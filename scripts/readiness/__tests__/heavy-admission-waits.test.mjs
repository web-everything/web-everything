// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  summarizeRecentWaits, recordAdmissionWait, readRecentWaits, recordHoldDuration, readHoldDurations,
  acquireSlotBlocking, tryAcquireSlot, releaseOwnedSlot, resolveAdmissionPolicy, runWithRemoteDecision,
} from '../heavy-admission.mjs';

vi.mock('../forge-remote-health.mjs', () => ({
  checkRemoteHealth: async () => ({ ok: true }),
  peekRemoteTelemetry: () => ({ activeRuns: 0, cores: 8, loadPerCore: 0.1, memFreePct: 90 }),
  recordRemoteResult: async () => {},
}));
const roots = [];
const temp = () => { const root = mkdtempSync(join(process.env.TMPDIR, 'admission-waits-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const T = Date.now();
const row = (waitMs, route = 'local', at = T) => ({ at: new Date(at).toISOString(), waitMs, route });
const policy = () => resolveAdmissionPolicy({ platform: { fastSlots: 0, fastScale: { maxSlots: 0 } }, env: {} });

describe('recent admission wait summary', () => {
  it('uses nearest ranks overall and per route, including zero waits and the window boundary', () => {
    const rows = [row(0), row(1000), row(2000), row(3000), row(4000), row(5000),
      row(6000, 'remote'), row(7000, 'remote'), row(8000, 'remote'), row(9000, 'remote', T - 60 * 60_000)];
    expect(summarizeRecentWaits(rows, { nowMs: T })).toEqual({
      windowMinutes: 60, count: 10, p50Ms: 4000, p90Ms: 8000,
      byRoute: { local: { count: 6, p50Ms: 2000, p90Ms: 5000 }, remote: { count: 4, p50Ms: 7000, p90Ms: 9000 } },
    });
  });
  it('tolerates corrupt JSONL and excludes invalid, old, and future evidence', () => {
    const rows = ['broken', 'null', '{}', JSON.stringify(row(7)), JSON.stringify(row(1, 'remote', T - 120001)),
      JSON.stringify(row(1, 'local', T + 1)), JSON.stringify(row(-1)), JSON.stringify(row('2')),
      JSON.stringify(row(1, 'unknown')), JSON.stringify({ ...row(1), at: 'invalid' })].join('\n');
    expect(summarizeRecentWaits(rows, { nowMs: T, windowMinutes: 2 })).toMatchObject({ count: 1, p50Ms: 7, p90Ms: 7 });
  });
  it('reports absent evidence with null percentiles and defaults invalid windows', () => {
    expect(summarizeRecentWaits('', { nowMs: T, windowMinutes: -1 })).toEqual({ windowMinutes: 60, count: 0, p50Ms: null, p90Ms: null,
      byRoute: { local: { count: 0, p50Ms: null, p90Ms: null }, remote: { count: 0, p50Ms: null, p90Ms: null } } });
    expect(readRecentWaits(temp()).count).toBe(0);
  });
});

describe('admission wait ledger', () => {
  it('writes the row beside backward-compatible hold durations', () => {
    const lockRoot = temp();
    recordHoldDuration({ lockRoot, kind: 'selected', ms: 123 });
    const before = readFileSync(join(lockRoot, 'durations.jsonl'), 'utf8');
    expect(recordAdmissionWait({ lockRoot, kind: 'selected', waitMs: 12.6, route: 'local', owner: 'owner', lane: '30', at: new Date(T).toISOString() })).toBe(true);
    expect(JSON.parse(readFileSync(join(lockRoot, 'waits.jsonl'), 'utf8'))).toEqual({ at: new Date(T).toISOString(), kind: 'selected', waitMs: 13, route: 'local', waitReason: 'none', owner: 'owner', lane: '30' });
    expect(readFileSync(join(lockRoot, 'durations.jsonl'), 'utf8')).toBe(before);
    expect(readHoldDurations(lockRoot)).toHaveLength(1);
  });
  it('never throws for unwritable destinations and refuses invalid samples', () => {
    const lockRoot = join(temp(), 'file'); writeFileSync(lockRoot, 'occupied');
    expect(recordAdmissionWait({ lockRoot, waitMs: 1, route: 'local' })).toBe(false);
    expect(readRecentWaits(lockRoot).count).toBe(0);
    for (const waitMs of [-1, NaN, Infinity, '1']) expect(recordAdmissionWait({ lockRoot, waitMs, route: 'local' })).toBe(false);
    expect(recordAdmissionWait({ lockRoot, waitMs: 1, route: 'unknown' })).toBe(false);
  });
  it.each(['none', 'cap-full', 'host-load'])('records exactly one local admission after %s', async reason => {
    const lockRoot = temp(); let time = T; let checks = 0;
    if (reason === 'cap-full') expect(tryAcquireSlot({ lockRoot, cap: 1, owner: 'holder', nowMs: T, nowIso: new Date(T).toISOString() }).ok).toBe(true);
    const result = await acquireSlotBlocking({ lockRoot, cap: 1, owner: 'waiter', lane: '30', kind: 'FULL', policy: policy(), env: {},
      now: () => time, pollMs: 100, log: () => {}, hostAdmission: () => ({ admitted: reason !== 'host-load' || checks++ > 0, reason: 'test load' }),
      sleep: async ms => { time += ms; releaseOwnedSlot({ lockRoot, cap: 1, owner: 'holder' }); } });
    expect(result.ok).toBe(true);
    const rows = readFileSync(join(lockRoot, 'waits.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ waitMs: reason === 'none' ? 0 : 100, route: 'local', waitReason: reason, owner: 'waiter', lane: '30' });
  });
  it.each([
    ['capacity then host-load', 2],
    ['host-load then capacity', 1],
  ])('records exactly one admission with host-load precedence after %s', async (_order, rejectedHostCheck) => {
    const lockRoot = temp(); let time = T; let checks = 0; let sleeps = 0;
    expect(tryAcquireSlot({ lockRoot, cap: 1, owner: 'holder', nowMs: T, nowIso: new Date(T).toISOString() }).ok).toBe(true);
    const result = await acquireSlotBlocking({ lockRoot, cap: 1, owner: 'waiter', lane: '30', kind: 'FULL', policy: policy(), env: {},
      now: () => time, pollMs: 100, log: () => {},
      hostAdmission: () => ({ admitted: ++checks !== rejectedHostCheck, reason: 'test load' }),
      sleep: async ms => {
        time += ms;
        if (++sleeps === 2) expect(releaseOwnedSlot({ lockRoot, cap: 1, owner: 'holder' }).released).toBe(true);
      } });
    expect(result.ok).toBe(true);
    expect(checks).toBe(3);
    expect(sleeps).toBe(2);
    const rows = readFileSync(join(lockRoot, 'waits.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ waitMs: 200, route: 'local', waitReason: 'host-load', owner: 'waiter', lane: '30' });
  });
  it('does not record deferred callers', async () => {
    const lockRoot = temp();
    const result = await acquireSlotBlocking({ lockRoot, cap: 1, owner: 'waiter', policy: policy(), env: {}, canDefer: true,
      hostAdmission: () => ({ admitted: false, reason: 'load' }), log: () => {} });
    expect(result.deferred).toBe(true);
    expect(existsSync(join(lockRoot, 'waits.jsonl'))).toBe(false);
  });
  it.each([false, true])('records one remote slot admission (busy=%s) in the shared ledger', async busy => {
    const root = temp(), lockRoot = join(root, 'heavy'), remoteRoot = join(root, 'remote'); let time = T;
    if (busy) expect(tryAcquireSlot({ lockRoot: remoteRoot, cap: 1, owner: 'holder', nowMs: T, nowIso: new Date(T).toISOString() }).ok).toBe(true);
    const result = await runWithRemoteDecision({ argv: ['npx', 'vitest', 'run', 'a.test.mjs'], cwd: root, lockRoot, env: {},
      policy: resolveAdmissionPolicy({ platform: { remote: { enabled: true, mode: 'always', maxConcurrent: 1 } } }),
      clock: () => time, loadPerCore: () => 0, hostOverloaded: () => false, log: () => {},
      sleep: async ms => { time += ms; releaseOwnedSlot({ lockRoot: remoteRoot, cap: 1, owner: 'holder' }); },
      remoteExec: async () => ({ mode: 'remote', code: 0 }) });
    expect(result).toMatchObject({ handled: true, exitCode: 0 });
    const rows = readFileSync(join(lockRoot, 'waits.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ route: 'remote', waitMs: busy ? 1000 : 0, waitReason: busy ? 'remote-busy' : 'none', owner: expect.stringMatching(/^remote-/) });
  });
});

describe('queue-status recent waits', () => {
  it('exposes the selected window in real CLI JSON and text, and rejects invalid windows', () => {
    const pool = temp();
    const env = { ...process.env, LANE_POOL_ROOT: pool, WE_PLATFORM_PREFERENCES: join(pool, 'no-preferences'), WE_HEAVY_ADMISSION: 'on' };
    const lockRoot = join(pool, '.admission', 'heavy');
    recordAdmissionWait({ lockRoot, kind: 'selected', waitMs: 2000, route: 'local' });
    recordAdmissionWait({ lockRoot, kind: 'selected', waitMs: 4000, route: 'remote', at: new Date(Date.now() - 5 * 60_000).toISOString() });
    const run = (...args) => spawnSync(process.execPath, ['scripts/readiness/heavy-admission.mjs', 'queue-status', ...args], { env, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    const json = run('--json', '--window-minutes=2');
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout).recentWaits).toMatchObject({ windowMinutes: 2, count: 1, p50Ms: 2000, p90Ms: 2000 });
    const text = run('--window-minutes=10');
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('recent waits (last 10m): p50 2.0s p90 4.0s over 2 admissions (local');
    expect(run('--window-minutes=NaN').status).toBe(2);
  });
});
