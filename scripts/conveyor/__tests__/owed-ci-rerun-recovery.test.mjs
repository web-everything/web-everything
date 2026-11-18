import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import * as pidHelpers from '../../lib/pid-alive.mjs';
import { join } from 'node:path';
import { dispatchTimeoutRetry, readTimeoutHold, runReconcileCiHealDispatch } from '../../operations/ci-heal-pr-dispatch.mjs';
import { readTimeoutBudget, timeoutKey } from '../timeout-retry-state.mjs';
import { planReconcile } from '../reconcile-core.mjs';
const repo = 'web-everything/web-everything';
const t0 = Date.parse('2026-10-14T16:00:00Z');
const evidence = { eligible: true, repo, pr: 5273, head: 'a'.repeat(40), signature: 'stale', infraCancelled: true, cap: 1,
  jobs: [{ run: 123, job: 456, attempt: 1 }] };
const observe = (e, j) => ({ repo, head: e.head, runHead: e.head, open: true, run: j.run, jobRun: j.run,
  job: j.job, attempt: j.attempt, jobAttempt: j.attempt, status: 'completed', conclusion: 'failure' });
const deadPid = 987654321;
const realIdentity = pidHelpers.pidIdentity;
const realStamp = pidHelpers.pidIdentityStamp;
// Feed the real shared parser bounded ps snapshots; the test host may deny ps entirely.
const identityExec = (_cmd, args) => {
  if (Number(args[1]) === deadPid) throw Object.assign(Error('gone'), { status: 1, stderr: '' });
  if (Number(args[1]) === process.pid) return 'S Wed Oct 14 15:59:00 2026 node test-runner';
  throw Error('unexpected pid');
};
const deadRequester = { pid: deadPid, hostname: hostname() };
let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'owed-rerun-'));
  vi.spyOn(pidHelpers, 'pidIdentity').mockImplementation((pid, opts) => realIdentity(pid, { ...opts, exec: identityExec }));
  vi.spyOn(pidHelpers, 'pidIdentityStamp').mockImplementation(pid => realStamp(pid, identityExec));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const path = () => join(dir, `${timeoutKey(evidence)}.json`);
const seed = (over = {}) => writeFileSync(path(), JSON.stringify({ version: 1, evidence,
  requests: [{ id: 0, target: evidence.jobs[0], status: 'pending', requester: deadRequester, reservedAt: new Date(t0).toISOString(), ...over }] }));
const state = () => JSON.parse(readFileSync(path(), 'utf8'));
const plan = budget => planReconcile({ prs: [{ number: evidence.pr, state: 'OPEN', isDraft: true,
  headRefName: 'lane/x', headRefOid: evidence.head, labels: [], mergeStateStatus: 'BLOCKED', comments: [],
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: new Date(t0).toISOString(),
    detailsUrl: `https://github.com/${repo}/actions/runs/123/job/456` }],
  requiredCheckCompletedAt: new Date(t0).toISOString(), requiredCheckName: 'test', aheadByOnMain: 0,
  mainGreenNow: { red: false, sha: '123456789abcdef', at: '2026-10-14T07:00:00Z' }, owedCiRerunRetry: evidence,
  timeoutRetry: { eligible: false, reason: 'not-a-timeout' }, timeoutRetryBudget: budget }],
  agents: [], requiredChecks: ['test'], now: t0 + 21 * 60_000, mainRedWindows: [], staleCiRerun: 'once-per-head' });

describe('stale pending recovery', () => {
  it('releases an observed stale dead-pid reservation and selects a fresh request in the same call without burning cap', async () => {
    seed();
    const request = vi.fn(() => ({ status: 'confirmed' }));
    const out = await dispatchTimeoutRetry(evidence, { repo, dir, now: () => t0 + 21 * 60_000, effects: { observe, request } });
    expect(out.status).toBe('requested'); expect(request).toHaveBeenCalledTimes(1);
    expect(state().requests).toEqual([expect.objectContaining({ status: 'rejected', released: true, outcome: 'stale pending reservation released' }),
      expect.objectContaining({ status: 'confirmed' })]);
    expect(readTimeoutBudget({ ...evidence, dir })).toMatchObject({ confirmed: 1, rejected: 0, pending: false });
  });
  it.each(['live', 'unknown'])('holds a same-host %s requester even past the hard ceiling', async kind => {
    seed({ requester: { pid: process.pid, hostname: hostname(), ...pidHelpers.pidIdentityStamp(process.pid) } });
    if (kind === 'unknown') vi.spyOn(pidHelpers, 'pidIdentity').mockReturnValue({ alive: null, reason: 'unreadable' });
    const now = t0 + 7 * 60 * 60_000;
    const request = vi.fn();
    expect(readTimeoutBudget({ ...evidence, dir, now }).pendingStale).toBeUndefined();
    expect(readTimeoutHold({ ...evidence, dir, now })).not.toBeNull();
    expect(await dispatchTimeoutRetry(evidence, { repo, dir, now: () => now, effects: { observe, request } }))
      .toMatchObject({ reason: 'retry-outcome-pending' });
    expect(request).not.toHaveBeenCalled();
    expect(state().requests[0].status).toBe('pending');
  });
  it('releases a reused pid only after its start identity mismatches', async () => {
    seed({ requester: { pid: process.pid, hostname: hostname(), runnerStart: 'old start marker' } });
    const now = t0 + 21 * 60_000;
    expect(readTimeoutBudget({ ...evidence, dir, now }).pendingStale).toBe(true);
    await dispatchTimeoutRetry({ ...evidence, reconcilePendingOnly: true }, { repo, dir, now: () => now, effects: { observe } });
    expect(state().requests[0]).toMatchObject({ status: 'rejected', released: true });
  });
  it.each([undefined, { pid: process.pid, hostname: `${hostname()}-remote` }])('legacy/remote requester %j waits until the hard ceiling and observation', async requester => {
    seed({ requester });
    const request = vi.fn();
    for (const age of [21 * 60_000, 6 * 60 * 60_000]) {
      const now = t0 + age;
      expect(readTimeoutBudget({ ...evidence, dir, now }).pendingStale).toBeUndefined();
      expect(await dispatchTimeoutRetry(evidence, { repo, dir, now: () => now, effects: { observe, request } }))
        .toMatchObject({ reason: 'retry-outcome-pending' });
    }
    const now = t0 + 6 * 60 * 60_000 + 1;
    expect(readTimeoutBudget({ ...evidence, dir, now }).pendingStale).toBe(true);
    expect(readTimeoutHold({ ...evidence, dir, now })).not.toBeNull();
    await dispatchTimeoutRetry({ ...evidence, reconcilePendingOnly: true }, { repo, dir, now: () => now,
      effects: { observe: () => { throw Error('unknown'); }, request } });
    expect(state().requests[0].status).toBe('pending');
    await dispatchTimeoutRetry({ ...evidence, reconcilePendingOnly: true }, { repo, dir, now: () => now, effects: { observe, request } });
    expect(state().requests[0]).toMatchObject({ status: 'rejected', released: true });
    expect(request).not.toHaveBeenCalled();
  });
  it('honors the configured hard ceiling for legacy state', () => {
    seed({ requester: undefined });
    vi.stubEnv('WE_TIMEOUT_RERUN_PENDING_HARD_STALE_MS', String(2 * 60 * 60_000));
    expect(readTimeoutBudget({ ...evidence, dir, now: t0 + 2 * 60 * 60_000 }).pendingStale).toBeUndefined();
    expect(readTimeoutBudget({ ...evidence, dir, now: t0 + 2 * 60 * 60_000 + 1 }).pendingStale).toBe(true);
  });
  it('records requester identity and holds a concurrent request beyond expiry', async () => {
    let release;
    const request = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const first = dispatchTimeoutRetry(evidence, { repo, dir, now: () => t0, effects: { observe, request } });
    await Promise.resolve();
    expect(state().requests[0].requester).toMatchObject({ pid: process.pid, hostname: hostname(), runnerStart: expect.any(String) });
    try {
      expect(await dispatchTimeoutRetry(evidence, { repo, dir, now: () => t0 + 21 * 60_000, effects: { observe, request } }))
        .toMatchObject({ reason: 'retry-outcome-pending' });
      expect(request).toHaveBeenCalledTimes(1);
    } finally { release({ status: 'confirmed' }); await first; }
  });
  it('holds when the observed attempt is missing', async () => {
    seed();
    const request = vi.fn();
    await dispatchTimeoutRetry(evidence, { repo, dir, now: () => t0 + 21 * 60_000,
      effects: { observe: (e, j) => ({ ...observe(e, j), attempt: undefined }), request } });
    expect(state().requests[0].status).toBe('pending');
    expect(request).not.toHaveBeenCalled();
  });
  it('planner retries expired holds then falls through to heal when the real cap is spent', async () => {
    seed();
    const now = t0 + 21 * 60_000;
    const row = plan(readTimeoutBudget({ ...evidence, dir, now })).dispatch[0];
    expect(row).toMatchObject({ kind: 'ci-timeout-rerun', timeoutRetry: { reconcilePendingOnly: true } });
    expect(readTimeoutHold({ ...evidence, dir, now })).toMatchObject({ reason: 'retry-outcome-pending' });
    const request = vi.fn(() => ({ status: 'rejected' }));
    await dispatchTimeoutRetry(row.timeoutRetry, { repo, dir, now: () => now, effects: { observe, request } });
    expect(request).not.toHaveBeenCalled();
    expect(readTimeoutHold({ ...evidence, dir, now })).toBeNull();
    const retry = plan(readTimeoutBudget({ ...evidence, dir, now })).dispatch[0];
    expect(retry.timeoutRetry.reconcilePendingOnly).toBeUndefined();
    await dispatchTimeoutRetry(retry.timeoutRetry, { repo, dir, now: () => now, effects: { observe, request } });
    expect(plan(readTimeoutBudget({ ...evidence, dir, now })).dispatch).toContainEqual(expect.objectContaining({ kind: 'ci-heal' }));
  });
  it.each([null, 'rejected', 'confirmed'])('expired reservation with failed observation still prevents heal (prior spend=%s)', async spent => {
    seed();
    if (spent) {
      const current = state(); current.requests.push({ id: 1, target: evidence.jobs[0], status: spent });
      writeFileSync(path(), JSON.stringify(current));
    }
    const now = t0 + 21 * 60_000;
    const planned = plan(readTimeoutBudget({ ...evidence, dir, now }));
    expect(planned.dispatch).toHaveLength(1);
    expect(planned.dispatch[0]).toMatchObject({ kind: 'ci-timeout-rerun', timeoutRetry: { reconcilePendingOnly: true } });
    const request = vi.fn();
    expect(await dispatchTimeoutRetry(planned.dispatch[0].timeoutRetry, { repo, dir, now: () => now,
      effects: { observe: () => { throw Error('observation unavailable'); }, request } }))
      .toMatchObject({ reason: 'retry-observation-unknown:observation unavailable' });
    expect(request).not.toHaveBeenCalled();
    expect(state().requests[0].status).toBe('pending');
    expect(plan(readTimeoutBudget({ ...evidence, dir, now })).dispatch.some(row => row.kind === 'ci-heal')).toBe(false);
    // Also defend admission against an earlier ci-heal plan while the reservation remains unresolved.
    const dispatch = vi.fn();
    const out = await runReconcileCiHealDispatch({ ...dispatchOpts(), dispatch, pickFreeLanes: () => [1],
      fixLoop: { killed: () => false }, currentBuild: () => null,
      reconcile: () => ({ dispatch: [{ kind: 'ci-heal', prNumber: evidence.pr, headRefOid: evidence.head, labels: [] }], refusals: [] }),
      timeoutHold: identity => readTimeoutHold({ ...identity, dir, now }) });
    expect(dispatch).not.toHaveBeenCalled(); expect(out.dispatched).toEqual([]);
    expect(out.refusals).toContainEqual(expect.objectContaining({ kind: 'ci-timeout-rerun', why: 'retry-outcome-pending' }));
  });
  it.each(['rejected', 'confirmed'])('spent cap reaches heal only after bound reconciliation (prior spend=%s)', async spent => {
    seed(); const current = state();
    current.requests.push({ id: 1, target: evidence.jobs[0], status: spent });
    writeFileSync(path(), JSON.stringify(current));
    const now = t0 + 21 * 60_000;
    const row = plan(readTimeoutBudget({ ...evidence, dir, now })).dispatch[0];
    const request = vi.fn();
    await dispatchTimeoutRetry(row.timeoutRetry, { repo, dir, now: () => now, effects: { observe, request } });
    expect(request).not.toHaveBeenCalled();
    expect(state().requests[0]).toMatchObject({ status: 'rejected', released: true });
    expect(readTimeoutHold({ ...evidence, dir, now })).toBeNull();
    expect(plan(readTimeoutBudget({ ...evidence, dir, now })).dispatch).toContainEqual(expect.objectContaining({ kind: 'ci-heal' }));
  });
  it('reconciliation-only evidence never requests a rerun when a concurrent executor already cleared pending', async () => {
    const request = vi.fn();
    expect(await dispatchTimeoutRetry({ ...evidence, reconcilePendingOnly: true }, { repo, dir, effects: { observe, request } }))
      .toMatchObject({ reason: 'waiting-for-new-attempt' });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([undefined, 'bad', new Date(t0 + 60_000).toISOString()])('fails closed on undated, invalid or young reservations: %s', async reservedAt => {
    seed({ reservedAt }); const request = vi.fn();
    expect(await dispatchTimeoutRetry(evidence, { repo, dir, now: () => t0 + 60_000, effects: { observe, request } })).toMatchObject({ reason: 'retry-outcome-pending' });
    expect(readTimeoutHold({ ...evidence, dir, now: t0 + 60_000 })).toMatchObject({ reason: 'retry-outcome-pending' });
    expect(request).not.toHaveBeenCalled();
  });
  it('exposes configured expiry separately while retaining the heal hold at and beyond the boundary', () => {
    seed(); vi.stubEnv('WE_TIMEOUT_RERUN_PENDING_STALE_MS', '1000');
    expect(readTimeoutHold({ ...evidence, dir, now: t0 + 1000 })).not.toBeNull();
    expect(readTimeoutHold({ ...evidence, dir, now: t0 + 1001 })).not.toBeNull();
    expect(readTimeoutBudget({ ...evidence, dir, now: t0 + 1000 }).pendingStale).toBeUndefined();
    expect(readTimeoutBudget({ ...evidence, dir, now: t0 + 1001 })).toMatchObject({ pending: true, pendingStale: true });
  });
  it('never releases stale pending on unreadable observation, stale head, or unreadable state', async () => {
    seed(); const now = () => t0 + 21 * 60_000;
    for (const observeEffect of [() => { throw Error('unknown'); }, (e, j) => ({ ...observe(e, j), head: 'other' })]) {
      await dispatchTimeoutRetry(evidence, { repo, dir, now, effects: { observe: observeEffect, request: () => { throw Error('must not request'); } } });
      expect(state().requests[0].status).toBe('pending');
    }
    writeFileSync(path(), '{');
    expect(readTimeoutHold({ ...evidence, dir, now: now() }).reason).toMatch(/unreadable/);
  });
  it('confirms an advanced attempt instead of releasing it even after expiry', async () => {
    seed();
    expect(await dispatchTimeoutRetry(evidence, { repo, dir, now: () => t0 + 21 * 60_000,
      effects: { observe: (e, j) => ({ ...observe(e, j), attempt: 2 }) } })).toMatchObject({ reason: 'retry-reconciled-wait-for-evidence' });
    expect(state().requests[0]).toMatchObject({ status: 'confirmed' });
    expect(state().requests[0].released).toBeUndefined();
  });
  it('concurrent executors share the reservation and send only one request', async () => {
    const request = vi.fn(async () => ({ status: 'confirmed' }));
    const opts = { repo, dir, now: () => t0, effects: { observe: async (...args) => observe(...args), request } };
    await Promise.all([dispatchTimeoutRetry(evidence, opts), dispatchTimeoutRetry(evidence, opts)]);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
const dispatchOpts = () => ({ root: dir, checkStaleness: () => ({ fresh: true, behind: 0 }),
  flushOwed: () => ({}), pollAttempts: () => [], flushTimeouts: async () => [], pickFreeLanes: () => [],
  unsupportedPath: join(dir, 'unsupported.json'), resolveProfile: () => ({ capabilities: { ciHeal: true } }) });
it.each([false, true])('timeout executor refusal carries why (throws=%s)', async throws => {
  const out = await runReconcileCiHealDispatch({ ...dispatchOpts(),
    reconcile: () => ({ dispatch: [{ kind: 'ci-timeout-rerun', prNumber: evidence.pr, timeoutRetry: evidence }], refusals: [] }),
    retryTimeout: () => { if (throws) throw Error('offline'); return { status: 'refused', reason: 'held' }; } });
  expect(out.refusals[0].why).toBe(throws ? 'offline' : 'held');
});
it('timeout hold refusal carries why into ci-heal output', async () => {
  const out = await runReconcileCiHealDispatch({ ...dispatchOpts(), pickFreeLanes: () => [1],
    resolveWorkUnit: () => ({ itemNum: null, scope: [] }), currentBuild: () => null,
    fixLoop: { killed: () => false },
    reconcile: () => ({ dispatch: [{ kind: 'ci-heal', prNumber: evidence.pr, headRefOid: evidence.head, labels: [] }], refusals: [] }),
    timeoutHold: () => ({ status: 'refused', reason: 'retry-outcome-pending' }) });
  expect(out.refusals).toContainEqual(expect.objectContaining({ kind: 'ci-timeout-rerun', why: 'retry-outcome-pending' }));
});
