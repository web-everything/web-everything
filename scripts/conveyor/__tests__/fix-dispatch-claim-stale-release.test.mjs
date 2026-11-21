import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as claims from '../fix-dispatch-claim.mjs';
import { heartbeat } from '../../readiness/file-locks.mjs';

const T0 = Date.parse('2026-11-20T12:00:00Z');
const GRACE = 30 * 60_000;
const iso = ms => new Date(ms).toISOString();
const key = { repo: 'we', pr: 7171, kind: 'fix' };
const owner = 'dispatcher-A';
const name = claims.fixDispatchSessionName(key);
const other = { name: 'advisory-7171', state: 'working', sessionId: 'owner-session', pid: 123 };
let lockRoot;
let recordEvent;

beforeEach(() => {
  lockRoot = mkdtempSync(join(tmpdir(), 'fix-claim-stale-'));
  recordEvent = vi.fn();
  claims.acquireFixDispatchClaim({ ...key, owner, sessionId: 'owner-session', lockRoot,
    nowMs: T0, nowIso: iso(T0) });
});
afterEach(() => rmSync(lockRoot, { recursive: true, force: true }));

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
    // A different name is unrelated even when its PR suffix, sessionId and pid look relevant.
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
    ['throwing listing', () => { throw new Error('listing unavailable'); }],
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

  it('does not mistake an advisory row with another name for the owner during grace', () => {
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
