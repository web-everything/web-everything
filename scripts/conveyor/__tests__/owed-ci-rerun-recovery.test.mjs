import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { dispatchTimeoutRetry as dispatchRetry, readTimeoutHold, runReconcileCiHealDispatch } from '../../operations/ci-heal-pr-dispatch.mjs';
import { readTimeoutBudget as readBudget, timeoutKey, timeoutRequesterNamespace } from '../timeout-retry-state.mjs';
import { planReconcile } from '../reconcile-core.mjs';
const repo = 'web-everything/web-everything';
const t0 = Date.parse('2026-10-14T16:00:00Z');
const evidence = { eligible: true, repo, pr: 5273, head: 'a'.repeat(40), signature: 'stale', infraCancelled: true, cap: 1,
  jobs: [{ run: 123, job: 456, attempt: 1 }] };
const observe = (e, j) => ({ repo, head: e.head, runHead: e.head, open: true, run: j.run, jobRun: j.run,
  job: j.job, attempt: j.attempt, jobAttempt: j.attempt, status: 'completed', conclusion: 'failure' });
const deadPid = 987654321;
const namespace = 'test-namespace';
const deadRequester = { pid: deadPid, hostname: hostname(), namespace };
let dir, ownerProbe;
const dispatchTimeoutRetry = (evidence, opts) => dispatchRetry(evidence, { ownerProbe, ...opts });
const readTimeoutBudget = opts => readBudget({ ownerProbe, ...opts });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'owed-rerun-'));
  ownerProbe = { host: hostname(), namespace, identity: vi.fn((pid, opts) => ({
    alive: pid === deadPid || opts.expectStart === 'old start marker' ? false : true,
  })) };
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
  it('an unreadable current namespace holds even a dead same-host pid regardless of age', async () => {
    seed();
    ownerProbe.namespace = null;
    const request = vi.fn();
    const now = t0 + 30 * 24 * 60 * 60_000;
    expect(readTimeoutBudget({ ...evidence, dir, now }).pendingStale).toBeUndefined();
    expect(await dispatchTimeoutRetry(evidence, { repo, dir, now: () => now, effects: { observe, request } }))
      .toMatchObject({ reason: 'retry-outcome-pending' });
    expect(ownerProbe.identity).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(readTimeoutBudget({ ...evidence, dir, now: t0 + 30 * 24 * 60 * 60_000 }).pendingStale).toBeUndefined();
  });
  it('counts a stale ambiguous dead-pid reservation as spent and refuses a replacement at cap', async () => {
    seed();
    const request = vi.fn();
    const now = t0 + 21 * 60_000;
    const out = await dispatchTimeoutRetry(evidence, { repo, dir, now: () => now, effects: { observe, request } });
    expect(out).toMatchObject({ reason: 'timeout-retries-exhausted' });
    expect(request).not.toHaveBeenCalled();
    expect(state().requests).toHaveLength(1);
    expect(state().requests[0]).toMatchObject({ status: 'rejected', outcome: 'ambiguous request expired unobserved; counted as spent' });
    expect(state().requests[0]).not.toHaveProperty('released');
    expect(readTimeoutBudget({ ...evidence, dir, now })).toEqual({ confirmed: 0, rejected: 1, pending: false });
  });
  it('permits only the remaining budget after counting an expired ambiguous request', async () => {
    seed();
    const request = vi.fn(() => ({ status: 'confirmed' }));
    const now = t0 + 21 * 60_000;
    const opts = { repo, dir, now: () => now, effects: { observe, request } };
    expect(await dispatchTimeoutRetry({ ...evidence, cap: 2 }, opts)).toMatchObject({ status: 'requested' });
    expect(readTimeoutBudget({ ...evidence, dir, now })).toEqual({ confirmed: 1, rejected: 1, pending: false });
    expect(await dispatchTimeoutRetry({ ...evidence, cap: 2 }, opts)).toMatchObject({ reason: 'timeout-retries-exhausted' });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('ordinary timeout execution spends an expired ambiguous request against its two-attempt cap', async () => {
    seed();
    const current = state();
    current.requests.push({ id: 1, target: evidence.jobs[0], status: 'confirmed' });
    writeFileSync(path(), JSON.stringify(current));
    const request = vi.fn();
    const now = t0 + 21 * 60_000;
    expect(await dispatchTimeoutRetry({ ...evidence, infraCancelled: false }, { repo, dir, now: () => now, effects: { observe, request } }))
      .toMatchObject({ reason: 'timeout-retries-exhausted' });
    expect(request).not.toHaveBeenCalled();
    expect(readTimeoutBudget({ ...evidence, dir, now })).toEqual({ confirmed: 1, rejected: 1, pending: false });
  });
  it.each(['live', 'unknown'])('holds a same-host %s requester regardless of age', async kind => {
    seed({ requester: { pid: process.pid, hostname: hostname(), namespace } });
    if (kind === 'unknown') ownerProbe.identity.mockReturnValue({ alive: null, reason: 'unreadable' });
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
    seed({ requester: { pid: process.pid, hostname: hostname(), namespace, runnerStart: 'old start marker' } });
    const now = t0 + 21 * 60_000;
    expect(readTimeoutBudget({ ...evidence, dir, now }).pendingStale).toBe(true);
    await dispatchTimeoutRetry({ ...evidence, reconcilePendingOnly: true }, { repo, dir, now: () => now, effects: { observe } });
    expect(ownerProbe.identity).toHaveBeenCalledWith(process.pid, { expectStart: 'old start marker', startedBy: t0 });
    expect(state().requests[0]).toMatchObject({ status: 'rejected', outcome: 'ambiguous request expired unobserved; counted as spent' });
  });
  it.each([
    undefined,
    { ...deadRequester, hostname: `${hostname()}-remote` },
    { ...deadRequester, namespace: undefined },
    { ...deadRequester, namespace: null },
    { ...deadRequester, namespace: 'different-pid-namespace' },
    { ...deadRequester, pid: undefined },
    { ...deadRequester, pid: 0 },
  ])('uncomparable requester %j retains the hold regardless of age', async requester => {
    seed({ requester });
    const request = vi.fn();
    const now = t0 + 30 * 24 * 60 * 60_000;
    expect(readTimeoutBudget({ ...evidence, dir, now }).pendingStale).toBeUndefined();
    expect(await dispatchTimeoutRetry({ ...evidence, reconcilePendingOnly: true }, {
      repo, dir, now: () => now, effects: { observe, request },
    })).toMatchObject({ reason: 'retry-outcome-pending' });
    expect(readTimeoutHold({ ...evidence, dir, now })).not.toBeNull();
    expect(state().requests[0].status).toBe('pending');
    expect(ownerProbe.identity).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
  it('records requester identity and holds a concurrent request beyond expiry', async () => {
    let release;
    const request = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const first = dispatchTimeoutRetry(evidence, { repo, dir, now: () => t0, effects: { observe, request } });
    await Promise.resolve();
    ownerProbe.namespace = state().requests[0].requester.namespace;
    expect(state().requests[0].requester).toMatchObject({ pid: process.pid, hostname: hostname(), namespace: timeoutRequesterNamespace() });
    expect(state().requests[0].requester).toHaveProperty('runnerStart');
    try {
      expect(await dispatchTimeoutRetry(evidence, { repo, dir, now: () => t0 + 21 * 60_000, effects: { observe, request } }))
        .toMatchObject({ reason: 'retry-outcome-pending' });
      expect(request).toHaveBeenCalledTimes(1);
    } finally { release({ status: 'confirmed' }); await first; }
  });
  it.each([
    ['older run attempt', { attempt: 0 }],
    ['older job attempt', { jobAttempt: 0 }],
    ['different job attempt', { jobAttempt: 2 }],
    ['missing job attempt', { jobAttempt: undefined }],
    ['in-progress job', { status: 'in_progress' }],
    ['queued job', { status: 'queued' }],
    ['missing job status', { status: undefined }],
  ])('holds a stale dead-owner reservation on %s observation', async (_name, observed) => {
    seed();
    const request = vi.fn();
    const now = t0 + 21 * 60_000;
    expect(await dispatchTimeoutRetry(evidence, { repo, dir, now: () => now,
      effects: { observe: (e, j) => ({ ...observe(e, j), ...observed }), request } }))
      .toMatchObject({ reason: 'retry-outcome-pending' });
    expect(state().requests[0].status).toBe('pending');
    expect(readTimeoutHold({ ...evidence, dir, now })).not.toBeNull();
    expect(request).not.toHaveBeenCalled();
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
    expect(readTimeoutBudget({ ...evidence, dir, now })).toEqual({ confirmed: 0, rejected: 1, pending: false });
    expect(plan(readTimeoutBudget({ ...evidence, dir, now })).dispatch.some(row => row.kind === 'ci-timeout-rerun')).toBe(false);
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
    expect(state().requests[0]).toMatchObject({ status: 'rejected', outcome: 'ambiguous request expired unobserved; counted as spent' });
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
  it.each(['completed', 'in_progress'])('confirms a strictly newer attempt even when its job is %s', async status => {
    seed();
    expect(await dispatchTimeoutRetry(evidence, { repo, dir, now: () => t0 + 21 * 60_000,
      effects: { observe: (e, j) => ({ ...observe(e, j), attempt: 2, status }) } })).toMatchObject({ reason: 'retry-reconciled-wait-for-evidence' });
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

describe('requester namespace marker', () => {
  it('reads the Linux PID namespace without falling back to a host boot marker', () => {
    const exec = vi.fn();
    expect(timeoutRequesterNamespace({ platform: 'linux', readNamespace: () => 'pid:[123]', exec })).toBe('pid:[123]');
    expect(timeoutRequesterNamespace({ platform: 'linux', readNamespace: () => null, exec })).toBeNull();
    expect(timeoutRequesterNamespace({ platform: 'linux', readNamespace: () => { throw Error('EACCES'); }, exec })).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });
  it('uses a bounded per-boot sysctl marker on non-Linux platforms', () => {
    const exec = vi.fn(() => '{ sec = 123, usec = 456 } Wed Oct 14 2026');
    expect(timeoutRequesterNamespace({ platform: 'darwin', exec })).toBe('boot:123:456');
    expect(exec).toHaveBeenCalledWith('sysctl', ['-n', 'kern.boottime'], expect.objectContaining({ timeout: 5000, maxBuffer: 4096 }));
  });
  it('fails closed when the boot marker is malformed, unreadable or oversized', () => {
    for (const output of ['', 'garbage', '{ sec = 123 }']) {
      expect(timeoutRequesterNamespace({ platform: 'darwin', exec: () => output })).toBeNull();
    }
    for (const code of ['EACCES', 'ENOBUFS', 'ETIMEDOUT']) {
      expect(timeoutRequesterNamespace({ platform: 'darwin', exec: () => { throw Object.assign(Error(code), { code }); } })).toBeNull();
    }
  });
});
