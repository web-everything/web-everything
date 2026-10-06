/**
 * @file scripts/readiness/__tests__/with-lock.test.mjs
 * @description Proof of the blocking `withLock` over the repo's lock primitive (#4017): mutual exclusion, lease
 *   refresh, dead-owner reclaim, and — the class that kept recurring in the bespoke lock this replaced — a holder
 *   reclaimed under a stalled run neither refreshes nor removes the replacement owner's live lock.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { reserve, readLockEntry, lockDirFor, makeLockEntry, acquireLockDir, DEFAULT_LEASE_MINUTES } from '../file-locks.mjs';
import { withLock, withPathLock, lockRootFor, probeOwnerLiveness } from '../with-lock.mjs';

let dir, root;
const noSleep = () => {};
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'with-lock-')); root = path.join(dir, 'locks'); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const heldEntry = () => readLockEntry(root, 'k');

describe('withLock', () => {
  it('runs fn, returns its result and releases; releases and rethrows on failure', () => {
    expect(withLock(root, 'k', () => { expect(heldEntry()).not.toBeNull(); return 42; })).toBe(42);
    expect(fs.existsSync(lockDirFor(root, 'k'))).toBe(false);
    expect(() => withLock(root, 'k', () => { throw new Error('boom'); })).toThrow('boom');
    expect(fs.existsSync(lockDirFor(root, 'k'))).toBe(false);
  });

  it('blocks a second holder (ELOCKTIMEOUT naming the holder) and lets it in once the first is done', () => {
    let nested;
    withLock(root, 'k', () => { try { withLock(root, 'k', () => {}, { timeoutMs: 30, pollMs: 5 }); } catch (e) { nested = e; } });
    expect(nested.code).toBe('ELOCKTIMEOUT');
    expect(nested.message).toMatch(/timed out acquiring k \(held by .+:\d+:[0-9a-f]+\)/);
    expect(withLock(root, 'k', () => 'ok')).toBe('ok');
  });

  it('waits out a live holder: a second acquire succeeds as soon as the lock frees', () => {
    reserve(root, 'k', 'other-host:1:aa', Date.now(), new Date().toISOString(), null);
    let sleeps = 0;
    const sleep = () => { if (++sleeps === 3) fs.rmSync(lockDirFor(root, 'k'), { recursive: true }); };
    expect(withLock(root, 'k', () => 'got it', { timeoutMs: 5000, pollMs: 1, sleep })).toBe('got it');
    expect(sleeps).toBe(3);
  });

  it('touch refreshes this holder\'s lease', () => {
    let clock = Date.parse('2026-10-06T12:00:00Z');
    const now = () => clock;
    withLock(root, 'k', ({ touch }) => {
      clock += 60_000; touch();
      expect(heldEntry().heartbeatAt).toBe(new Date(clock).toISOString());
    }, { now });
  });

  it('reclaims an abandoned lock: a same-host dead pid at once, a foreign host only after its lease', () => {
    const dead = `${os.hostname()}:2147483646:ab`; // no such process
    reserve(root, 'k', dead, Date.now(), new Date().toISOString(), 2147483646);
    expect(probeOwnerLiveness({ owner: dead })).toBe('dead');
    expect(withLock(root, 'k', () => 'reclaimed', { timeoutMs: 0 })).toBe('reclaimed');
    // A foreign host cannot be probed: fresh ⇒ blocked, past the lease ⇒ reclaimable.
    reserve(root, 'k', 'other-host:1:ab', Date.now(), new Date().toISOString(), 1);
    expect(probeOwnerLiveness({ owner: 'other-host:1:ab' })).toBe('unknown');
    expect(() => withLock(root, 'k', () => {}, { timeoutMs: 0 })).toThrow('timed out acquiring');
    const t = Date.now() + DEFAULT_LEASE_MINUTES * 60_000 * 2;
    expect(withLock(root, 'k', () => 'lease-expired', { timeoutMs: 0, now: () => t })).toBe('lease-expired');
  });

  it('a holder reclaimed during a stall learns it (touch and exit throw ELOCKLOST) and never removes the new owner\'s lock', () => {
    let lostOnTouch, exit;
    const reclaimAsB = () => {
      // The holder stalled past its lease; B reclaims and now owns the lock.
      const later = Date.now() + 10 * 60_000;
      expect(reserve(root, 'k', 'B-host:9:bb', later, new Date(later).toISOString(), 9, 'unknown', 0.5)).toMatchObject({ ok: true, heldBy: 'B-host:9:bb' });
    };
    try {
      withLock(root, 'k', ({ touch }) => {
        reclaimAsB();
        try { touch(); } catch (e) { lostOnTouch = e; }
      });
    } catch (e) { exit = e; }
    expect(lostOnTouch.code).toBe('ELOCKLOST');
    expect(exit.code).toBe('ELOCKLOST');
    expect(heldEntry().owner).toBe('B-host:9:bb');            // B's lock survived the stalled holder's release and touch
  });

  it('keeps fn\'s own error when the lock was lost as well', () => {
    expect(() => withLock(root, 'k', () => {
      fs.rmSync(lockDirFor(root, 'k'), { recursive: true });
      throw new Error('fn failed');
    })).toThrow('fn failed');
  });

  it('a stalled ACQUIRER cannot delete the lock of the owner that reclaimed its entry-less dir (the #4017 review case)', () => {
    // Acquirer A won the mkdir and stalls before its entry write; B reclaims and takes the lock; A resumes.
    const key = 'k';
    const won = acquireLockDir(root, key, makeLockEntry('A:1:aa', key, new Date().toISOString(), 1), {
      afterMkdir: () => {
        const old = (Date.now() - 60_000) / 1000;
        fs.utimesSync(lockDirFor(root, key), old, old);
        reserve(root, key, 'B:2:bb', Date.now(), new Date().toISOString(), 2);
      },
    });
    expect(won).toBe(false);
    expect(heldEntry().owner).toBe('B:2:bb');
  });
});

describe('withPathLock', () => {
  it('keeps the lock dirs next to the file, keyed per file, so two files lock independently', () => {
    const a = path.join(dir, 'a.json'), b = path.join(dir, 'b.json');
    expect(lockRootFor(a)).toBe(path.join(dir, '.file-locks'));
    let nested;
    withPathLock(a, () => {
      withPathLock(b, () => {}, { timeoutMs: 0 });             // another file: not blocked
      try { withPathLock(a, () => {}, { timeoutMs: 0 }); } catch (e) { nested = e; }
    });
    expect(nested.code).toBe('ELOCKTIMEOUT');
  });
});
