import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as claims from '../fix-dispatch-claim.mjs';
import * as dispatchIo from '../../operations/dispatch-lane-io.mjs';
import * as workers from '../../operations/worker-wrapper-launch.mjs';
import soakBreak from '../soak/breaks/stale-fix-claim-released-when-owner-gone.mjs';
import { heartbeat } from '../../readiness/file-locks.mjs';

const T0 = Date.parse('2026-11-20T12:00:00Z');
const GRACE = 30 * 60_000;
const iso = ms => new Date(ms).toISOString();
const key = { repo: 'we', pr: 7171, kind: 'fix' };
const owner = 'dispatcher-A';
const name = claims.fixDispatchSessionName(key);
const other = { name: 'advisory-7171', state: 'working', sessionId: 'unrelated-session', pid: 123 };
let lockRoot;
let recordEvent;

beforeEach(() => {
  lockRoot = mkdtempSync(join(tmpdir(), 'fix-claim-stale-'));
  recordEvent = vi.fn();
  claims.acquireFixDispatchClaim({ ...key, owner, sessionId: 'owner-session', lockRoot,
    nowMs: T0, nowIso: iso(T0) });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(lockRoot, { recursive: true, force: true }); });

const read = () => claims.readFixDispatchClaim({ ...key, lockRoot });
function stamp(meta) {
  const entry = read();
  heartbeat(lockRoot, claims.fixDispatchResource(key), owner, entry.heartbeatAt, entry.pid, meta);
}
function refresh(options = {}) {
  return claims.refreshLiveFixDispatchClaims({ lockRoot, recordEvent,
    listAgentsAll: () => [other], hungInfoFor: () => ({ hung: false }),
    awaitingVerifyFor: null, idleRelease: { enabled: false },
    identity: () => ({ alive: 'unknown', reason: 'unreadable' }),
    alive: () => 'unknown', activityMsFor: () => null,
    nowMs: T0 + GRACE + 1, nowIso: () => iso(T0 + GRACE + 1), ...options });
}
function expectRelease(result, reason) {
  expect(read()).toBeNull();
  expect(result.released).toEqual([expect.objectContaining({ ...key, owner })]);
  expect(recordEvent).toHaveBeenCalledTimes(1);
  expect(recordEvent).toHaveBeenCalledWith({
    kind: 'stale-claim-released', repo: key.repo, pr: key.pr, daemon: 'reconcile-fix-dispatch',
    detail: { kind: key.kind, reason, owner },
  });
}

describe('stale fix claim release evidence', () => {
  it('exports STALE_GONE_GRACE_MS as thirty minutes', () => {
    expect(claims.STALE_GONE_GRACE_MS).toBe(GRACE);
  });

  it('stale fix claim is released when its owner run is provably gone: runnerPid dead', () => {
    stamp({ ...read().meta, runnerPid: 123 });
    const result = refresh({ alive: () => false });
    expectRelease(result, 'wrapped-runner-dead (pid 123 is gone)');
  });

  it('stale fix claim is released when its owner run is provably gone: readable listing lacks owner after grace', () => {
    // Absence requires no matching name or bound sessionId.
    expectRelease(refresh(), 'session-gone');
  });

  it('releases a provably absent owner even beyond the four-hour refresh ceiling', () => {
    expectRelease(refresh({ nowMs: T0 + claims.MAX_FIX_DISPATCH_CLAIM_REFRESH_MS + 1 }), 'session-gone');
  });

  it('fails closed for malformed runnerPid rather than assuming no runner', () => {
    stamp({ ...read().meta, runnerPid: 'unreadable' });
    const before = read();
    expect(refresh().released).toBeUndefined();
    expect(read()).toEqual(before);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('retains a bound session under any name after grace', () => {
    const before = read();
    expect(refresh({ listAgentsAll: () => [{ ...other, sessionId: 'owner-session' }] }).released).toBeUndefined();
    expect(read()).toEqual(before);
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'stale-claim-quarantined' }));
  });

  it.each(['listing', 'row'])('fails closed on incomplete %s metadata', location => {
    const rows = [{ ...other }];
    Object.defineProperty(location === 'listing' ? rows : rows[0], 'incomplete', { value: [{ reason: 'unreadable' }] });
    const before = read();
    expect(refresh({ listAgentsAll: () => rows }).released).toBeUndefined();
    expect(read()).toEqual(before);
  });

  it.each(['wrapped', 'default', 'malformed default'])('preserves incomplete evidence from the %s default source', source => {
    const rows = [{ ...other }];
    Object.defineProperty(rows, 'incomplete', { value: [{ reason: 'torn record' }] });
    vi.spyOn(dispatchIo, 'defaultListAgents').mockReturnValue(source === 'malformed default' ? null : source === 'default' ? rows : [other]);
    vi.spyOn(workers, 'listWrappedWorkerAgents').mockReturnValue(source === 'wrapped' ? rows : []);
    const before = read();
    expect(refresh({ listAgentsAll: undefined }).released).toBeUndefined();
    expect(read()).toEqual(before);
    expect(dispatchIo.defaultListAgents).toHaveBeenCalledWith({ all: true, fresh: true });
  });

  it('requests fresh default evidence instead of cached absence', () => {
    vi.spyOn(dispatchIo, 'defaultListAgents').mockImplementation(options => options.fresh
      ? [{ ...other, sessionId: 'owner-session' }] : [other]);
    vi.spyOn(workers, 'listWrappedWorkerAgents').mockReturnValue([]);
    expect(refresh({ listAgentsAll: undefined }).released).toBeUndefined();
    expect(read()).not.toBeNull();
    expect(dispatchIo.defaultListAgents).toHaveBeenCalledWith({ all: true, fresh: true });
  });

  it('passes fresh through defaultListAgents to bypass the agents cache', () => {
    const exec = vi.fn().mockReturnValue(JSON.stringify([other]));
    const env = { WE_CLAUDE_AGENTS_CACHE_TTL_MS: '60000', CLAUDE_CONFIG_DIR: lockRoot };
    dispatchIo.defaultListAgents({ exec, env, fresh: true });
    exec.mockReturnValue(JSON.stringify([{ ...other, name: 'fresh-owner' }]));
    expect(dispatchIo.defaultListAgents({ exec, env, fresh: true })[0].name).toBe('fresh-owner');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it.each([GRACE - 1, GRACE])('retains an old claim with a heartbeat only %i ms old', age => {
    const entry = read();
    heartbeat(lockRoot, claims.fixDispatchResource(key), owner, iso(T0 + GRACE + 1 - age), entry.pid, entry.meta);
    const before = read();
    expect(refresh().released).toBeUndefined();
    expect(read()).toEqual(before);
  });

  it('retains an absent claim until its configured lease expires', () => {
    claims.releaseFixDispatchClaim({ ...key, owner, lockRoot });
    claims.acquireFixDispatchClaim({ ...key, owner, lockRoot, leaseMinutes: 90, nowMs: T0, nowIso: iso(T0) });
    expect(read().meta.leaseMinutes).toBe(90);
    expect(refresh({ nowMs: T0 + 90 * 60_000 }).released).toBeUndefined();
    expectRelease(refresh({ nowMs: T0 + 90 * 60_000 + 1 }), 'session-gone');
  });

  it.each(['unreadable', 0, -1])('fails closed on malformed configured lease %s', leaseMinutes => {
    stamp({ ...read().meta, leaseMinutes });
    const before = read();
    expect(refresh().released).toBeUndefined();
    expect(read()).toEqual(before);
  });

  it('fails closed on an unreadable last heartbeat', () => {
    const entry = read();
    heartbeat(lockRoot, claims.fixDispatchResource(key), owner, 'unreadable', entry.pid, entry.meta);
    const before = read();
    expect(refresh().released).toBeUndefined();
    expect(read()).toEqual(before);
  });

  it('retains fixing claims whose holders have no agent rows', () => {
    const fixing = { ...key, kind: 'fixing' };
    claims.releaseFixDispatchClaim({ ...key, owner, lockRoot });
    claims.acquireFixDispatchClaim({ ...fixing, owner, lockRoot, nowMs: T0, nowIso: iso(T0) });
    const entry = claims.readFixDispatchClaim({ ...fixing, lockRoot });
    heartbeat(lockRoot, claims.fixDispatchResource(fixing), owner, entry.heartbeatAt, entry.pid, { ...entry.meta, who: 'fixer' });
    expect(refresh().released).toBeUndefined();
    expect(claims.readFixDispatchClaim({ ...fixing, lockRoot })).not.toBeNull();
  });

  it('malformed runnerPid still allows a live session heartbeat', () => {
    stamp({ ...read().meta, runnerPid: 'unreadable' });
    expect(refresh({ listAgentsAll: () => [{ name, state: 'working', sessionId: 'owner-session' }] }).refreshed).toHaveLength(1);
    expect(read().heartbeatAt).toBe(iso(T0 + GRACE + 1));
  });

  it.each([false, true])('propagates listing diagnostics without releasing (default=%s)', useDefault => {
    const error = new Error('listing unavailable: wrapped store unreadable');
    const before = read();
    const fail = () => { throw error; };
    if (useDefault) {
      vi.spyOn(dispatchIo, 'defaultListAgents').mockReturnValue([other]);
      vi.spyOn(workers, 'listWrappedWorkerAgents').mockImplementation(fail);
    }
    expect(() => refresh({ listAgentsAll: useDefault ? undefined : fail })).toThrow(error);
    expect(read()).toEqual(before);
  });

  it('soak presence remains true when the exported behaviour regresses', () => {
    const moduleDir = join(lockRoot, 'scripts/conveyor');
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(join(moduleDir, 'fix-dispatch-claim.mjs'), `
      export const STALE_GONE_GRACE_MS = 1800000;
      export function refreshLiveFixDispatchClaims() { throw new Error('regression'); }
    `);
    expect(soakBreak.fixPresent(lockRoot)).toBe(true);
    writeFileSync(join(moduleDir, 'fix-dispatch-claim.mjs'), 'export const STALE_GONE_GRACE_MS = 1800000;');
    expect(soakBreak.fixPresent(lockRoot)).toBe(false);
  });

  it('records the release event for a dead runner identity', () => {
    stamp({ ...read().meta, runnerPid: 123, runnerStart: 'start', runnerArgv: 'worker' });
    expectRelease(refresh({ identity: () => ({ alive: false, reason: 'pid-reused' }) }),
      'runner-identity-dead (pid-reused)');
  });

  it('records the release event for a dead session identity', () => {
    expectRelease(refresh({
      listAgentsAll: () => [{ name, state: 'working', sessionId: 'owner-session', pid: 123 }],
      identity: () => ({ alive: false, reason: 'not-found' }),
    }), 'session-identity-dead (not-found)');
  });

  it.each(['done', 'stopped', 'failed'])('records the release event for a settled terminal row: %s', state => {
    expectRelease(refresh({ listAgentsAll: () => [{ name, state, sessionId: 'owner-session' }] }),
      'settled-terminal-row');
  });

  it.each([GRACE - 1, GRACE])('retains the claim unchanged during listing lag, age %i', age => {
    const before = read();
    expect(refresh({ nowMs: T0 + age }).released).toBeUndefined();
    expect(read()).toEqual(before);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['empty listing', () => []],
    ['non-array listing', () => ({ agents: [other] })],
    ['null listing', () => null],
    ['incomplete agent row', () => [{}]],
    ['partially malformed listing', () => [other, null]],
  ])('fails closed with unknown evidence: %s', (_label, listAgentsAll) => {
    const before = read();
    expect(refresh({ listAgentsAll }).released).toBeUndefined();
    expect(read()).toEqual(before);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it.each([undefined, 'not-a-date'])('fails closed for unreadable claimedAt: %s', claimedAt => {
    const meta = { ...read().meta, claimedAt };
    if (claimedAt === undefined) delete meta.claimedAt;
    stamp(meta);
    const before = read();
    expect(refresh().released).toBeUndefined();
    expect(read()).toEqual(before);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['live row', { name, state: 'working', sessionId: 'owner-session', pid: 123 }, { alive: true }],
    ['ambiguous row', { name, state: 'working', sessionId: 'different-session', pid: 123 }, { alive: false }],
    ['unknown identity', { name, state: 'working', sessionId: 'owner-session', pid: 123 }, { alive: 'unknown' }],
    ['missing pid', { name, state: 'working', sessionId: 'owner-session' }, null],
    ['historical terminal row', { name, state: 'done', sessionId: 'old-session' }, null],
  ])('retains and quarantines once per refresh when %s exists', (_label, row, verdict) => {
    const before = read();
    const options = { listAgentsAll: () => [row, { ...row }], identity: () => verdict };
    expect(refresh(options).released).toBeUndefined();
    expect(read()).toMatchObject({ owner: before.owner, meta: before.meta });
    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'stale-claim-quarantined', repo: key.repo, pr: key.pr, daemon: 'reconcile-fix-dispatch',
      detail: expect.objectContaining({ kind: key.kind, owner }),
    }));
    refresh(options);
    expect(recordEvent).toHaveBeenCalledTimes(2);
  });

  it('retains an unrelated advisory row during grace', () => {
    const before = read();
    expect(refresh({ nowMs: T0 + GRACE - 1 }).released).toBeUndefined();
    expect(read()).toEqual(before);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('never releases a claim replaced during the listing probe', () => {
    refresh({ listAgentsAll: () => {
      claims.releaseFixDispatchClaim({ ...key, owner, lockRoot });
      claims.acquireFixDispatchClaim({ ...key, owner: 'dispatcher-B', lockRoot,
        nowMs: T0 + GRACE, nowIso: iso(T0 + GRACE) });
      return [other];
    } });
    expect(read().owner).toBe('dispatcher-B');
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('never releases a claim whose runner was stamped during the listing probe', () => {
    refresh({ listAgentsAll: () => {
      stamp({ ...read().meta, runnerPid: 123 });
      return [other];
    } });
    expect(read().meta.runnerPid).toBe(123);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('retains the existing synchronous-listing contract for Promises', () => {
    const before = read();
    expect(() => refresh({ listAgentsAll: () => Promise.resolve([other]) })).toThrow(/synchronous/);
    expect(read()).toEqual(before);
  });

  it.each([
    ['synchronous error', () => { throw new Error('event store unavailable'); }],
    ['async rejection', () => Promise.reject(new Error('event store unavailable'))],
  ])('a release survives event storage failure: %s', async (_label, sink) => {
    expect(refresh({ recordEvent: sink }).released).toHaveLength(1);
    expect(read()).toBeNull();
    await new Promise(resolve => setImmediate(resolve));
  });
});
