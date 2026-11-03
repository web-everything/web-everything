// @vitest-environment node
import {afterEach, describe, expect, it, vi} from 'vitest';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {withPoolMutex} from '../pool-mutex.mjs';
import {blockedSlots, createMarkerReaper, heldTombstone, reapDeadSlotLocks} from '../forge-slot-markers.mjs';
import {lockDirFor, readLockEntry, releaseLockDir} from '../file-locks.mjs';
import {tryAcquireSlot} from '../heavy-admission.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });
const NOW = Date.parse('2026-11-01T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pool-mutex-')); roots.push(root);
  return {root, file: join(root, '.pool-mutex')};
}
function spinSeams(waitMs = 15) {
  let elapsed = 0;
  const spinSleep = vi.fn(ms => { elapsed += ms; });
  return {waitMs, spinClock: () => elapsed, spinSleep};
}
function staleSlot(root) {
  const entry = {owner: 'dead-owner', path: 'slot-0', pid: 111, heartbeatAt: iso(NOW - 3_600_001)};
  mkdirSync(lockDirFor(root, entry.path));
  writeFileSync(join(lockDirFor(root, entry.path), 'lock.json'), JSON.stringify(entry));
  return entry;
}
const acquire = root => tryAcquireSlot({lockRoot: root, cap: 1, owner: 'successor',
  nowMs: NOW, nowIso: iso(NOW), pid: process.pid});
const reap = (root, extra = {}) => reapDeadSlotLocks({root, host: 'forge', clock: () => NOW,
  liveness: () => 'dead', ...extra});

describe('remote pool mutex', () => {
  it('records process identity and returns the synchronous value, then releases', () => {
    const {root, file} = fixture();
    expect(withPoolMutex(root, () => {
      const owner = JSON.parse(readFileSync(file, 'utf8'));
      expect(owner).toMatchObject({pid: process.pid, at: NOW});
      expect(owner.startedAt === null || typeof owner.startedAt === 'string').toBe(true);
      return 42;
    }, {clock: () => NOW})).toEqual({ok: true, value: 42});
    expect(existsSync(file)).toBe(false);
  });
  it('releases in finally when the critical section throws', () => {
    const {root, file} = fixture();
    expect(() => withPoolMutex(root, () => { throw new Error('boom'); })).toThrow('boom');
    expect(existsSync(file)).toBe(false);
  });
  it.each([{pid: 999, at: NOW}, {pid: process.pid, at: NOW + 1}])('does not release a replaced identity: %j', replacement => {
    const {root, file} = fixture();
    withPoolMutex(root, () => writeFileSync(file, JSON.stringify(replacement)), {clock: () => NOW});
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(replacement);
  });
  it('reclaims a provably dead mutex owner and retries', () => {
    const {root, file} = fixture();
    writeFileSync(file, JSON.stringify({pid: 111, startedAt: 'old', at: 1}));
    const liveness = vi.fn(() => 'dead');
    expect(withPoolMutex(root, () => 'ran', {liveness, waitMs: 0})).toEqual({ok: true, value: 'ran'});
    expect(liveness).toHaveBeenCalledWith(111, process.pid);
    expect(existsSync(file)).toBe(false);
  });
  it('serializes two dead-owner recoverers and never unlinks their live successor', () => {
    const {root, file} = fixture(); staleSlot(root);
    writeFileSync(file, JSON.stringify({pid: 111, at: 1}));
    const liveness = pid => pid === 111 ? 'dead' : 'alive';
    const reaper = vi.fn(() => reap(root)), first = vi.fn();
    const successor = {pid: process.pid, startedAt: 'successor', at: NOW + 1};
    const phases = [];
    expect(withPoolMutex(root, first, {waitMs: 0, liveness, onRecovery: phase => {
      phases.push(phase);
      if (phase === 'judged') {
        // A pauses after its FINAL identity comparison. B must not also judge/unlink that owner.
        expect(withPoolMutex(root, reaper, {waitMs: 0, liveness}))
          .toEqual({ok: false, reason: 'mutex-busy'});
      } else {
        // A has unlinked; a successor wins O_EXCL before A retries. Keep its identity on disk
        // after this simulated party yields, so both recoverers resume against a live holder.
        expect(withPoolMutex(root, () => {
          releaseLockDir(root, 'slot-0');
          expect(acquire(root).ok).toBe(true);
          writeFileSync(file, JSON.stringify(successor));
        }, {clock: () => NOW})).toEqual({ok: true, value: undefined});
      }
    }})).toEqual({ok: false, reason: 'mutex-busy'});
    expect(phases).toEqual(['judged', 'unlinked']);
    expect(withPoolMutex(root, reaper, {waitMs: 0, liveness}))
      .toEqual({ok: false, reason: 'mutex-busy'});
    expect(first).not.toHaveBeenCalled();
    expect(reaper).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(successor);
    expect(readLockEntry(root, 'slot-0')).toMatchObject({owner: 'successor', pid: process.pid});
    expect(existsSync(`${file}.recovery`)).toBe(false);
  });
  it('keeps a dead owner behind an abandoned recovery guard and returns bounded mutex-busy for operator recovery', () => {
    const {root, file} = fixture();
    const owner = {pid: 111, at: 1};
    writeFileSync(file, JSON.stringify(owner));
    mkdirSync(`${file}.recovery`);
    const fn = vi.fn(), seams = spinSeams();
    expect(withPoolMutex(root, fn, {...seams, liveness: () => 'dead'}))
      .toEqual({ok: false, reason: 'mutex-busy'});
    expect(fn).not.toHaveBeenCalled();
    expect(seams.spinSleep.mock.calls).toEqual([[5], [5], [5]]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(owner);
    expect(existsSync(`${file}.recovery`)).toBe(true);
  });
  it('releases the recovery guard when its guarded probe throws', () => {
    const {root, file} = fixture();
    writeFileSync(file, JSON.stringify({pid: 111, at: 1}));
    let probes = 0;
    expect(() => withPoolMutex(root, vi.fn(), {liveness: () => {
      if (++probes === 2) throw new Error('probe failed');
      return 'dead';
    }})).toThrow('probe failed');
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.recovery`)).toBe(false);
  });
  it.each(['alive', 'unknown', 'corrupt', 'unreadable', 'missing-pid'])('keeps %s evidence and bounds its wait without running fn', kind => {
    const {root, file} = fixture();
    if (kind === 'unreadable') mkdirSync(file);
    else writeFileSync(file, kind === 'corrupt' ? '{' : JSON.stringify(kind === 'missing-pid' ? {} : {pid: 111, at: 1}));
    const fn = vi.fn(), liveness = vi.fn(() => kind), seams = spinSeams();
    expect(withPoolMutex(root, fn, {...seams, liveness})).toEqual({ok: false, reason: 'mutex-busy'});
    expect(fn).not.toHaveBeenCalled();
    expect(seams.spinSleep.mock.calls).toEqual([[5], [5], [5]]);
    expect(existsSync(file)).toBe(true);
    if (['corrupt', 'unreadable', 'missing-pid'].includes(kind)) expect(liveness).not.toHaveBeenCalled();
  });
  it('acquires after a live owner releases during a bounded spin', () => {
    const {root, file} = fixture();
    writeFileSync(file, JSON.stringify({pid: 111, at: 1}));
    const seams = spinSeams();
    expect(withPoolMutex(root, () => 'ran', {...seams, liveness: () => 'alive',
      spinSleep: ms => { seams.spinSleep(ms); rmSync(file); }})).toEqual({ok: true, value: 'ran'});
  });
  it.each(['acquire', 'reap'])('a held mutex blocks concurrent %s without touching the slot', contender => {
    const {root} = fixture(), entry = staleSlot(root);
    const fn = vi.fn(() => contender === 'acquire' ? acquire(root) : reap(root));
    withPoolMutex(root, () => {
      expect(withPoolMutex(root, fn, {waitMs: 0})).toEqual({ok: false, reason: 'mutex-busy'});
      expect(fn).not.toHaveBeenCalled();
      expect(readLockEntry(root, 'slot-0')).toEqual(entry);
    });
  });
  it('keeps a successor acquired in its mutex section after an earlier reap judgment', () => {
    const {root} = fixture(); staleSlot(root);
    // Model a judgment made before entering exclusion: acquisition wins the mutex first.
    expect(reap(root, {liveness: () => {
      expect(withPoolMutex(root, () => {
        releaseLockDir(root, 'slot-0');
        return acquire(root);
      })).toMatchObject({ok: true, value: {ok: true}});
      return 'dead';
    }})).toEqual([]);
    expect(readLockEntry(root, 'slot-0')).toMatchObject({owner: 'successor', pid: process.pid});
  });
  it('ignores the mutex file in every remote slot enumerator', async () => {
    const {root, file} = fixture();
    writeFileSync(file, '{');
    mkdirSync(`${file}.recovery`);
    expect(blockedSlots(root, 1)).toEqual(new Set());
    expect(heldTombstone(root, 0)).toBe(false);
    expect(reap(root)).toEqual([]);
    const telemetry = vi.fn();
    expect(await createMarkerReaper({root, host: 'forge', clock: () => NOW}).step(telemetry)).toEqual([]);
    expect(telemetry).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(true);
  });
});
