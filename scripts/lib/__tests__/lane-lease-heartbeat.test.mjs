import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renewLaneLease, startLaneLeaseHeartbeat } from '../lane-lease-heartbeat.mjs';
import { staleTakeoverHasLiveProcesses, journalLiveProcessRefusal } from '../lane-lease-liveness.mjs';
import { laneLivenessGate } from '../lane-salvage.mjs';

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

  it.each([() => [], () => null, () => { throw Error('unreadable'); }])('keeps acquire fail-open when no occupant is observed', readCwds => {
    const journal = vi.fn();
    expect(staleTakeoverHasLiveProcesses(dir, { readCwds, journal })).toBe(false);
    expect(journal).not.toHaveBeenCalled();
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
