import { afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { hostname } from 'node:os';
import { spawnKeepAlive } from '../test-keepalive.mjs';
import { ACTIVE_BUILD_TOKENS, buildLeaseIsLive, claimBuildLease, pidReusedSince, processStartMs } from '../daemon-rebuild/lease.mjs';
import { candidateWorktreePath } from '../daemon-rebuild/candidate.mjs';

const nowMs = Date.parse('2026-11-01T20:00:00Z');
const startedAt = new Date(nowMs - 60_000).toISOString();
const startedMs = Date.parse(startedAt);
// A real, live pid that is not this process (and not the runner's parent, which may not be signalable).
const child = spawnKeepAlive({ maxLifetimeMs: 120_000 });
const livePid = child.pid;
const lease = (pid, over = {}) => ({ host: hostname(), pid, token: 't', startedAt, ...over });
afterAll(() => child.kill());
afterEach(() => vi.restoreAllMocks());

describe('pidReusedSince (the one shared pid-reuse rule)', () => {
  it('is true only for a readable start time later than startedAt plus the slack', () => {
    expect(pidReusedSince(livePid, startedMs, () => startedMs + 10_000)).toBe(true);
  });
  it('is false for a start time before, at, or within the 2 s slack of startedAt', () => {
    expect(pidReusedSince(livePid, startedMs, () => startedMs - 3_600_000)).toBe(false);
    expect(pidReusedSince(livePid, startedMs, () => startedMs)).toBe(false);
    expect(pidReusedSince(livePid, startedMs, () => startedMs + 2_000)).toBe(false);
  });
  it('fails closed: unreadable (null / NaN / throwing) start time or unreadable startedAt is not proof', () => {
    expect(pidReusedSince(livePid, startedMs, () => null)).toBe(false);
    expect(pidReusedSince(livePid, startedMs, () => NaN)).toBe(false);
    expect(pidReusedSince(livePid, startedMs, () => { throw new Error('ps blew up'); })).toBe(false);
    expect(pidReusedSince(livePid, NaN, () => startedMs + 10_000)).toBe(false);
  });
});

describe('buildLeaseIsLive pid-reuse guard', () => {
  it('treats a live pid that started AFTER the lease as dead (reused pid)', () => {
    const startTimeOf = () => nowMs - 10_000;
    expect(buildLeaseIsLive(lease(livePid), { nowMs, startTimeOf })).toBe(false);
  });
  it('keeps a live pid that started before the lease alive', () => {
    const startTimeOf = () => nowMs - 3_600_000;
    expect(buildLeaseIsLive(lease(livePid), { nowMs, startTimeOf })).toBe(true);
  });
  it('fails closed: an unreadable start time keeps the lease live', () => {
    expect(buildLeaseIsLive(lease(livePid), { nowMs, startTimeOf: () => null })).toBe(true);
  });
  it('an EPERM (not signalable) pid still gets the start-time check: reused is dead, unreadable stays live', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('nope'), { code: 'EPERM' }); });
    expect(buildLeaseIsLive(lease(livePid), { nowMs, startTimeOf: () => nowMs - 10_000 })).toBe(false);
    expect(buildLeaseIsLive(lease(livePid), { nowMs, startTimeOf: () => null })).toBe(true);
  });
  it('processStartMs reads a real start time for this process and null for a bogus pid', () => {
    const t = processStartMs(process.pid);
    expect(Number.isFinite(t)).toBe(true);
    expect(Math.abs(Date.now() - t)).toBeLessThan(24 * 3_600_000);
    expect(processStartMs(0)).toBe(null);
  });
});

// claimBuildLease → leaseOwnerIsGone is the DESTRUCTIVE path: a true answer deletes the abandoned candidate tree.
describe('claimBuildLease candidate teardown (leaseOwnerIsGone pid-reuse guard)', () => {
  const ROOT = '/nonexistent/clone';
  const ENV = { WE_DAEMON_STATE_DIR: '/nonexistent/state', HOME: '/nonexistent/home' };
  const OLD_PATH = candidateWorktreePath(ROOT, ENV, 'old-token');
  const run = (calls) => (args) => { calls.push(args.join(' ')); return { status: 0, stdout: '', stderr: '' }; };

  /** Claim over an abandoned lease held by `livePid`; returns whether its candidate tree was torn down. */
  function claim({ leaseAgeMs, startTimeOf, kill }) {
    if (kill) vi.spyOn(process, 'kill').mockImplementation(kill);
    const calls = [];
    const state = { building: lease(livePid, { token: 'old-token', path: OLD_PATH, startedAt: new Date(nowMs - leaseAgeMs).toISOString() }) };
    const got = claimBuildLease({ state, plan: { finalSha: 'abc', inputsKey: 'k' }, root: ROOT, run: run(calls), env: ENV, nowMs, startTimeOf });
    if (got) ACTIVE_BUILD_TOKENS.delete(got.token);
    return { got, removed: calls.includes(`worktree remove --force ${OLD_PATH}`) };
  }
  const AGED = 3_600_000; // past the 20-minute stale limit, so the lease is up for takeover
  const FRESH = 600_000; // inside the stale limit: only proven pid reuse can free it

  it('deletes the candidate when the pid was provably reused (started after the lease), even on a fresh lease', () => {
    const { got, removed } = claim({ leaseAgeMs: FRESH, startTimeOf: () => nowMs - 1_000 });
    expect(got).not.toBeNull();
    expect(removed).toBe(true);
  });
  it('deletes the candidate of an aged lease whose pid was reused', () => {
    const { got, removed } = claim({ leaseAgeMs: AGED, startTimeOf: () => nowMs - 1_000 });
    expect(got).not.toBeNull();
    expect(removed).toBe(true);
  });
  it('takes over an aged lease from a REAL live owner (started before the lease) but leaves its tree alone', () => {
    const { got, removed } = claim({ leaseAgeMs: AGED, startTimeOf: () => nowMs - AGED - 3_600_000 });
    expect(got).not.toBeNull();
    expect(removed).toBe(false);
  });
  it('takes over an aged lease but leaves the tree alone when the start time is unreadable', () => {
    const { got, removed } = claim({ leaseAgeMs: AGED, startTimeOf: () => null });
    expect(got).not.toBeNull();
    expect(removed).toBe(false);
  });
  it('does not delete a start time within the 2 s slack of the lease, but does just past it', () => {
    expect(claim({ leaseAgeMs: AGED, startTimeOf: () => nowMs - AGED + 1_500 }).removed).toBe(false);
    expect(claim({ leaseAgeMs: AGED, startTimeOf: () => nowMs - AGED + 2_500 }).removed).toBe(true);
  });
  it('single-flight: a FRESH lease held by a live owner (started before it) is not taken over and its tree is kept', () => {
    const { got, removed } = claim({ leaseAgeMs: FRESH, startTimeOf: () => nowMs - FRESH - 3_600_000 });
    expect(got).toBeNull();
    expect(removed).toBe(false);
  });
  it('a malformed (non-integer) pid never counts as a live owner, and never throws', () => {
    const calls = [];
    const state = { building: { host: hostname(), pid: 'abc', token: 'old-token', path: OLD_PATH, startedAt: new Date(nowMs - FRESH).toISOString() } };
    const got = claimBuildLease({ state, plan: { finalSha: 'abc', inputsKey: 'k' }, root: ROOT, run: run(calls), env: ENV, nowMs, startTimeOf: () => null });
    if (got) ACTIVE_BUILD_TOKENS.delete(got.token);
    expect(got).not.toBeNull();
    expect(buildLeaseIsLive(state.building, { nowMs, startTimeOf: () => null })).toBe(false);
  });
  it('an EPERM (not signalable) owner still gets the start-time check: reused is deleted, unreadable is kept', () => {
    const eperm = () => { throw Object.assign(new Error('nope'), { code: 'EPERM' }); };
    expect(claim({ leaseAgeMs: AGED, startTimeOf: () => nowMs - 1_000, kill: eperm }).removed).toBe(true);
    expect(claim({ leaseAgeMs: AGED, startTimeOf: () => null, kill: eperm }).removed).toBe(false);
  });
  it('deletes the candidate of a dead (ESRCH) owner without consulting the start time', () => {
    const startTimeOf = vi.fn(() => null);
    const esrch = () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); };
    expect(claim({ leaseAgeMs: AGED, startTimeOf, kill: esrch }).removed).toBe(true);
    expect(startTimeOf).not.toHaveBeenCalled();
  });
  it('never deletes a candidate held on another host', () => {
    const calls = [];
    const state = { building: lease(livePid, { host: `${hostname()}-other`, token: 'old-token', path: OLD_PATH, startedAt: new Date(nowMs - AGED).toISOString() }) };
    const got = claimBuildLease({ state, plan: { finalSha: 'abc', inputsKey: 'k' }, root: ROOT, run: run(calls), env: ENV, nowMs, startTimeOf: () => nowMs - 1_000 });
    if (got) ACTIVE_BUILD_TOKENS.delete(got.token);
    expect(got).not.toBeNull();
    expect(calls).not.toContain(`worktree remove --force ${OLD_PATH}`);
  });
});

describe('R830 adopt-only lease never blocks a rebuild job', () => {
  const plan = { finalSha: 'a'.repeat(40), inputsKey: 'k' };
  // The pid MUST count as a live, long-running owner for these tests to reach the adoptOnly guard: without a start
  // time before the lease, the default reader reports the keepalive child as a reused pid and the lease is dead anyway.
  const OLDER = () => nowMs - 3_600_000;
  const ROOT = '/nonexistent/clone';
  const ENV = { WE_DAEMON_STATE_DIR: '/nonexistent/state', HOME: '/nonexistent/home' };
  const OLD_PATH = candidateWorktreePath(ROOT, ENV, 'old-token');
  const runTo = (calls) => (args) => { calls.push(args.join(' ')); return { status: 0, stdout: '', stderr: '' }; };
  it('an adopt-only lease from another LIVE pid (the daemon) is not live, and is reclaimable at once', () => {
    // Control: the identical lease without the flag IS live, so only the adoptOnly guard can make this false.
    expect(buildLeaseIsLive(lease(livePid), { nowMs, startTimeOf: OLDER })).toBe(true);
    expect(buildLeaseIsLive(lease(livePid, { adoptOnly: true }), { nowMs, startTimeOf: OLDER })).toBe(false);
    const state = { building: lease(livePid, { adoptOnly: true }) };
    const got = claimBuildLease({ state, plan, root: '/nonexistent-root', run: () => ({ status: 0 }), env: {}, nowMs, startTimeOf: OLDER });
    expect(got).toBeTruthy();
    expect(got.pid).toBe(process.pid);
    expect(state.building.token).toBe(got.token);
    ACTIVE_BUILD_TOKENS.delete(got.token);
  });
  it('reclaiming an adopt-only lease from another live pid tears down its candidate path (leaseOwnerIsGone adoptOnly branch)', () => {
    const calls = [];
    const state = { building: lease(livePid, { adoptOnly: true, token: 'old-token', path: OLD_PATH }) };
    const got = claimBuildLease({ state, plan, root: ROOT, run: runTo(calls), env: ENV, nowMs, startTimeOf: OLDER });
    if (got) ACTIVE_BUILD_TOKENS.delete(got.token);
    expect(got).not.toBeNull();
    expect(calls).toContain(`worktree remove --force ${OLD_PATH}`);
  });
  it('a non-adopt-only lease from the same live, older owner keeps its candidate tree (the teardown is adopt-only specific)', () => {
    const calls = [];
    const aged = new Date(nowMs - 3_600_000).toISOString();
    const state = { building: lease(livePid, { token: 'old-token', path: OLD_PATH, startedAt: aged }) };
    const got = claimBuildLease({ state, plan, root: ROOT, run: runTo(calls), env: ENV, nowMs, startTimeOf: () => nowMs - 7_200_000 });
    if (got) ACTIVE_BUILD_TOKENS.delete(got.token);
    expect(got).not.toBeNull();
    expect(calls).not.toContain(`worktree remove --force ${OLD_PATH}`);
  });
  it('a lease this process holds (token active) does not block itself after release, and records adoptOnly when asked', () => {
    const state = { building: null };
    const got = claimBuildLease({ state, plan, root: '/x', run: () => ({ status: 0 }), env: {}, nowMs, adoptOnly: true });
    expect(got.token).toBeTruthy();
    expect(state.building.adoptOnly).toBe(true);
    ACTIVE_BUILD_TOKENS.delete(got.token);
    expect(buildLeaseIsLive(state.building, { nowMs })).toBe(false);
  });
  it('a dead job pid is reclaimable at once', () => {
    expect(buildLeaseIsLive(lease(2 ** 22 + 12345), { nowMs })).toBe(false);
  });
  it('a live OTHER non-adopt-only job still blocks', () => {
    expect(buildLeaseIsLive(lease(livePid), { nowMs, startTimeOf: () => nowMs - 3_600_000 })).toBe(true);
    const state = { building: lease(livePid) };
    expect(claimBuildLease({ state, plan, root: '/x', run: () => ({ status: 0 }), env: {}, nowMs, startTimeOf: () => nowMs - 3_600_000 })).toBeNull();
  });
});
