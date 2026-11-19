import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renewLaneLease, startLaneLeaseHeartbeat } from '../lane-lease-heartbeat.mjs';
import { staleTakeoverHasLiveProcesses, journalLiveProcessRefusal } from '../lane-lease-liveness.mjs';
import { laneLivenessGate } from '../lane-salvage.mjs';
import { withLaneLeaseGuard } from '../lane-lease-guard.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lease-heartbeat-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('lane lease renewal', () => {
  it('resolves the absolute git dir from a subdirectory and preserves lease identity', () => {
    execFileSync('git', ['init', '--quiet', dir]);
    const cwd = join(dir, 'nested');
    mkdirSync(cwd);
    const file = join(dir, '.git', '.lane-lease');
    const lease = { session: 'owner', holder: 'holder', acquiredAt: '2026-01-01T00:00:00.000Z', ttlMinutes: 240 };
    writeFileSync(file, JSON.stringify(lease));
    expect(renewLaneLease({ cwd, now: () => new Date('2026-02-01') })).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...lease, renewedAt: '2026-02-01T00:00:00.000Z' });
    expect(readdirSync(join(dir, '.git')).filter(n => n.includes('.tmp-'))).toEqual([]);
  });

  it('silently ignores non-lanes, invalid JSON and failed git resolution', () => {
    const run = () => ({ status: 0, stdout: dir });
    expect(renewLaneLease({ cwd: dir, run })).toBe(false);
    writeFileSync(join(dir, '.lane-lease'), '{');
    expect(renewLaneLease({ cwd: dir, run })).toBe(false);
    expect(renewLaneLease({ cwd: dir, run: () => { throw Error('git'); } })).toBe(false);
    expect(renewLaneLease({ cwd: dir, run: () => ({ status: 1 }) })).toBe(false);
  });

  it.each(['released', 'session', 'holder', 'acquiredAt', 'renewedAt', 'unreadable'])('aborts renewal and removes the temporary file when the lease is %s before rename', change => {
    const file = join(dir, '.lane-lease');
    const lease = { session: 'owner', holder: 'holder', acquiredAt: '2026-01-01T00:00:00.000Z', ttlMinutes: 240 };
    writeFileSync(file, JSON.stringify(lease));
    const replacement = change === 'unreadable' ? '{' : JSON.stringify({ ...lease, [change]: 'successor' });
    const renameSync = vi.fn();
    expect(renewLaneLease({ cwd: dir, run: () => ({ status: 0, stdout: dir }),
      fs: {
        writeFileSync(tmp, body, options) {
          writeFileSync(tmp, body, options);
          if (change === 'released') rmSync(file);
          else writeFileSync(file, replacement);
        },
        renameSync, rmSync,
      },
    })).toBe(false);
    expect(renameSync).not.toHaveBeenCalled();
    if (change === 'released') expect(existsSync(file)).toBe(false);
    else expect(readFileSync(file, 'utf8')).toBe(replacement);
    expect(readdirSync(dir).filter(n => n.includes('.tmp-'))).toEqual([]);
  });

  it('returns false and leaves no lease after release between comparison and rename', () => {
    const file = join(dir, '.lane-lease');
    writeFileSync(file, JSON.stringify({ session: 'owner', acquiredAt: '2026-01-01' }));
    const rename = vi.fn(renameSync);
    const release = vi.fn(() => withLaneLeaseGuard(file, () => rmSync(file)));
    expect(renewLaneLease({ cwd: dir, run: () => ({ status: 0, stdout: dir }), fs: {
      writeFileSync(path, body, options) {
        // The first comparison has succeeded. Release wins the shared guard
        // immediately before renewal acquires it and attempts its rename.
        if (path === `${file}.lock`) release();
        writeFileSync(path, body, options);
      },
      renameSync: rename, rmSync,
    } })).toBe(false);
    expect(release).toHaveBeenCalledOnce();
    expect(rename).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('holds the shared release/takeover guard through the final comparison and rename', () => {
    const file = join(dir, '.lane-lease');
    writeFileSync(file, JSON.stringify({ session: 'owner', acquiredAt: '2026-01-01' }));
    const remove = vi.fn(() => rmSync(file));
    expect(renewLaneLease({ cwd: dir, run: () => ({ status: 0, stdout: dir }), fs: {
      writeFileSync, rmSync,
      renameSync(tmp, target) {
        expect(() => withLaneLeaseGuard(file, remove)).toThrow(/EEXIST/);
        expect(remove).not.toHaveBeenCalled();
        renameSync(tmp, target);
      },
    } })).toBe(true);
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8')).renewedAt).toBeDefined();
  });

  it('refuses an occupied guard without changing the lease or removing another writer\'s guard', () => {
    const file = join(dir, '.lane-lease');
    const body = JSON.stringify({ session: 'owner', acquiredAt: '2026-01-01' });
    writeFileSync(file, body);
    writeFileSync(`${file}.lock`, 'other writer');
    expect(renewLaneLease({ cwd: dir, run: () => ({ status: 0, stdout: dir }) })).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(body);
    expect(readFileSync(`${file}.lock`, 'utf8')).toBe('other writer');
    expect(readdirSync(dir).sort()).toEqual(['.lane-lease', '.lane-lease.lock']);
  });

  it('removes its guard and temporary file if rename fails', () => {
    const file = join(dir, '.lane-lease');
    const body = JSON.stringify({ session: 'owner', acquiredAt: '2026-01-01' });
    writeFileSync(file, body);
    expect(renewLaneLease({ cwd: dir, run: () => ({ status: 0, stdout: dir }), fs: {
      writeFileSync, rmSync, renameSync() { throw Error('rename failed'); },
    } })).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(body);
    expect(readdirSync(dir)).toEqual(['.lane-lease']);
  });

  it.each(['release', 'takeover'])('returns false without restoring anything if %s is observed after rename', change => {
    const file = join(dir, '.lane-lease');
    const successor = JSON.stringify({ session: 'successor', acquiredAt: '2026-02-01' });
    writeFileSync(file, JSON.stringify({ session: 'owner', acquiredAt: '2026-01-01' }));
    expect(renewLaneLease({ cwd: dir, run: () => ({ status: 0, stdout: dir }), fs: {
      writeFileSync, rmSync,
      renameSync(tmp, target) {
        renameSync(tmp, target);
        // A writer outside the guard protocol must not cause a stale restore.
        if (change === 'release') rmSync(target);
        else writeFileSync(target, successor);
      },
    } })).toBe(false);
    if (change === 'release') expect(readdirSync(dir)).toEqual([]);
    else {
      expect(readFileSync(file, 'utf8')).toBe(successor);
      expect(readdirSync(dir)).toEqual(['.lane-lease']);
    }
  });

  it('renews immediately, repeats at the default interval, unrefs and stops idempotently', () => {
    const renew = vi.fn();
    const timer = { unref: vi.fn() };
    let tick;
    const setIntervalFn = vi.fn(fn => { tick = fn; return timer; });
    const clearIntervalFn = vi.fn();
    const heartbeat = startLaneLeaseHeartbeat({ cwd: dir, renew, setIntervalFn, clearIntervalFn });
    expect(renew).toHaveBeenCalledWith({ cwd: dir });
    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect(timer.unref).toHaveBeenCalledOnce();
    tick();
    expect(renew).toHaveBeenCalledTimes(2);
    heartbeat.stop(); heartbeat.stop(); tick();
    expect(clearIntervalFn).toHaveBeenCalledOnce();
    expect(clearIntervalFn).toHaveBeenCalledWith(timer);
    expect(renew).toHaveBeenCalledTimes(2);
  });

  it('swallows synchronous and asynchronous renewal failures and continues ticking', async () => {
    let tick;
    const renew = vi.fn().mockImplementationOnce(() => { throw Error('write'); })
      .mockRejectedValueOnce(Error('async')).mockReturnValue(true);
    const heartbeat = startLaneLeaseHeartbeat({ cwd: dir, renew,
      setIntervalFn: fn => { tick = fn; return {}; }, clearIntervalFn: () => {} });
    tick(); await Promise.resolve(); tick();
    expect(renew).toHaveBeenCalledTimes(3);
    heartbeat.stop();
  });
});

describe('live process takeover refusal with injected liveness reads', () => {
  it('refuses a nested cwd and journals the action, excluding self and path-prefix siblings', () => {
    const journal = vi.fn();
    const readCwds = () => [{ pid: process.pid, cwd: dir }, { pid: 123, cwd: join(dir, 'nested') },
      { pid: 124, cwd: `${dir}-other` }];
    expect(staleTakeoverHasLiveProcesses(dir, { readCwds, journal })).toBe(true);
    expect(journal).toHaveBeenCalledOnce();
    expect(journal).toHaveBeenCalledWith(dir, expect.objectContaining({
      action: 'reclaim-refused-live-process', livePids: [123],
    }));
  });

  it('allows takeover when the injected reader observes no occupant', () => {
    const journal = vi.fn();
    expect(staleTakeoverHasLiveProcesses(dir, { readCwds: () => [], journal })).toBe(false);
    expect(journal).not.toHaveBeenCalled();
  });

  it.each([
    ['null', () => null], ['throw', () => { throw Error('lsof unavailable'); }],
  ])('fails closed and journals an unreadable cwd probe: %s', (_, readCwds) => {
    const journal = vi.fn();
    expect(staleTakeoverHasLiveProcesses(dir, { readCwds, journal })).toBe(true);
    expect(journal).toHaveBeenCalledOnce();
    expect(journal).toHaveBeenCalledWith(dir, {
      action: 'reclaim-refused-live-process', reason: expect.stringMatching(/probe unreadable.*retrying takeover/),
    });
  });

  it('exposes reclaim process evidence for journaling while preserving its refusal reason', () => {
    const gate = laneLivenessGate({ dir, readAgents: () => [],
      readCwds: () => [{ pid: 123, cwd: dir }], quietMs: 0 });
    expect(gate.eligible).toBe(false);
    expect(gate.reason).toMatch(/123/);
    const journal = vi.fn();
    expect(journalLiveProcessRefusal(dir, gate.livePids, journal)).toBe(true);
    expect(journal.mock.calls[0][1].action).toBe('reclaim-refused-live-process');
    expect(laneLivenessGate({ dir, readAgents: () => [], readCwds: () => null }).eligible).toBe(false);
  });
});
