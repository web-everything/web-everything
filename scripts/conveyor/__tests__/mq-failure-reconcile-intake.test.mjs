import { describe, expect, it, vi } from 'vitest';
import { classifyMqFailureIntake, admitMqFailureRoute } from '../mq-failure-intake.mjs';
import { refreshMqFailureHead } from '../../lib/mq-failure-refresh.mjs';
import { collectMqFailureEvidence } from '../../lib/mq-failure-evidence.mjs';
import { buildMqFailureRoute, parseMqFailureRoute } from '../../lib/mq-failure-route.mjs';
import { planReconcile, BOOKKEEPING_MARKERS } from '../reconcile-core.mjs';
import { runReconcileFixDispatch, fetchPrDiffPaths } from '../reconcile-fix-dispatch.mjs';
import { createMqFailureLedger } from '../../lib/mq-failure-ledger.mjs';

const identity = { repo: 'acme/web', pr: 42, head: 'a'.repeat(40) };
const route = { ...identity, version: 1, failedJobs: ['unit (node 22)'],
  testFiles: ['tests/widget.test.mjs'], assertions: ['FAIL tests/widget.test.mjs > keeps state', 'AssertionError: expected true'], complete: true, stale: false };
const changedFiles = { ...identity, files: ['src/unrelated.mjs'], complete: true };
const classify = (overrides = {}) => classifyMqFailureIntake({ ...identity, route: structuredClone(route), changedFiles: structuredClone(changedFiles), ...overrides });

// Reconcile-facing helpers consume an already authenticated parsed route. They
// must retain fix admission/evidence even when their executor hint is refresh.
describe('mq failure reconcile intake', () => {
  it('every failing test in a nonempty complete set is outside the head-pinned diff => refresh', () => {
    expect(classify()).toBe('refresh');
    expect(classify({ route: { ...route, testFiles: ['tests/widget.test.mjs', 'tests/other.test.mjs'] } })).toBe('refresh');
  });

  it('in-diff failure => normal fix, no refresh', () => {
    const input = { ...identity, route, changedFiles: { ...changedFiles, files: ['tests/widget.test.mjs'] } };
    expect(classifyMqFailureIntake(input)).toBe('fix');
    expect(admitMqFailureRoute(input)).toMatchObject({ kind: 'fix', recoveryAction: 'fix' });
  });

  it('a mixed inside/outside failure set selects fix even when most files are outside', () => {
    expect(classify({ route: { ...route, testFiles: ['tests/outside.test.mjs', 'src/unrelated.mjs'] } })).toBe('fix');
  });

  it.each([
    ['empty failing set', { route: { ...route, testFiles: [] } }],
    ['missing failing set', { route: { ...route, testFiles: undefined } }],
    ['incomplete logs', { route: { ...route, complete: false } }],
    ['unknown log completeness', { route: { ...route, complete: undefined } }],
    ['unknown route', { route: null }],
    ['stale marker', { route: { ...route, stale: true } }],
    ['wrong route head', { route: { ...route, head: 'b'.repeat(40) } }],
    ['wrong route repo', { route: { ...route, repo: 'acme/other' } }],
    ['wrong route PR', { route: { ...route, pr: 43 } }],
    ['incomplete changed files', { changedFiles: { ...changedFiles, complete: false } }],
    ['unknown diff completeness', { changedFiles: { ...changedFiles, complete: undefined } }],
    ['unknown changed files', { changedFiles: null }],
    ['unpinned changed files', { changedFiles: { ...changedFiles, head: undefined } }],
    ['stale changed files', { changedFiles: { ...changedFiles, head: 'b'.repeat(40) } }],
    ['wrong changed-files repo', { changedFiles: { ...changedFiles, repo: 'acme/other' } }],
    ['wrong changed-files PR', { changedFiles: { ...changedFiles, pr: 43 } }],
    ['unknown path', { route: { ...route, testFiles: [null] } }],
    ['path outside repository', { route: { ...route, testFiles: ['../widget.test.mjs'] } }],
  ])('misparsed/incomplete evidence => fix (fail closed): %s', (_name, overrides) => {
    expect(classify(overrides)).toBe('fix');
  });

  it('compares repository paths consistently so a leading ./ cannot disguise an in-diff test', () => {
    expect(classify({ route: { ...route, testFiles: ['./src/unrelated.mjs'] } })).toBe('fix');
  });

  it('admits a route as a fix row with all evidence for the normal fixer brief', () => {
    const input = { ...identity, route: structuredClone(route), changedFiles: structuredClone(changedFiles) };
    const before = structuredClone(input);
    expect(admitMqFailureRoute(input)).toMatchObject({ kind: 'fix', ...identity, recoveryAction: 'refresh',
      evidence: { failedJobs: route.failedJobs, testFiles: route.testFiles, assertions: route.assertions, complete: true } });
    expect(input).toEqual(before);
    const inside = { ...input, changedFiles: { ...changedFiles, files: route.testFiles } };
    expect(admitMqFailureRoute(inside)).toMatchObject({ kind: 'fix', recoveryAction: 'fix', evidence: expect.objectContaining({ assertions: route.assertions }) });
  });

  it('incomplete parsed evidence remains a normal fix row rather than disappearing', () => {
    expect(admitMqFailureRoute({ ...identity, route: { ...route, complete: false }, changedFiles }))
      .toMatchObject({ kind: 'fix', recoveryAction: 'fix', evidence: { complete: false } });
  });

  it('never admits an absent, stale, wrong-PR or wrong-repo route as current evidence', () => {
    for (const invalid of [null, { ...route, stale: true }, { ...route, head: 'b'.repeat(40) }, { ...route, pr: 43 }, { ...route, repo: 'acme/other' }]) {
      expect(admitMqFailureRoute({ ...identity, route: invalid, changedFiles })).toBeNull();
    }
  });

  it('outside-diff intake drives exactly one refresh, then stops on repeated failure', async () => {
    const claims = new Set();
    const ledger = {
      claim: vi.fn(async key => {
        const id = JSON.stringify(key);
        if (claims.has(id)) return { claimed: false, note: 'already refreshed; operator inspection required' };
        claims.add(id);
        return { claimed: true };
      }),
      recordRefresh: vi.fn(async () => {}),
    };
    const io = {
      readHead: vi.fn(async () => identity.head),
      createCheckout: vi.fn(async () => ({ cwd: 'fixture/isolated', branch: 'topic' })),
      git: vi.fn(async ({ args }) => args[0] === 'merge' ? { ok: true, head: 'b'.repeat(40) } : { ok: true }),
      removeCheckout: vi.fn(async () => {}),
    };
    expect(classify()).toBe('refresh');
    const row = admitMqFailureRoute({ ...identity, route, changedFiles });
    expect(row).toMatchObject({ kind: 'fix', recoveryAction: 'refresh' });
    expect(await refreshMqFailureHead({ ...identity, ledger, io })).toMatchObject({ action: 'refreshed' });
    expect(await refreshMqFailureHead({ ...identity, ledger, io })).toMatchObject({ action: 'stop', note: expect.stringMatching(/already|refresh/i) });
    expect(io.git.mock.calls.filter(([call]) => call.args[0] === 'push')).toHaveLength(1);
  });
});


describe('mq failure integration completeness', () => {
  it('unknown diff completeness preserves fix admission', () => {
    const repo = 'web-everything/web-everything';
    const body = buildMqFailureRoute({ ...route, repo });
    const pr = {
      number: identity.pr, state: 'OPEN', headRefName: 'lane/mq-recovery', headRefOid: identity.head,
      labels: [{ name: 'review:changes' }], mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }],
      comments: [{ body, author: { login: 'chalbert' } }],
      files: [{ path: 'src/unrelated.mjs' }],
    };
    for (const filesComplete of [undefined, false, true]) {
      const plan = planReconcile({ repo: 'we', prs: [{ ...pr, filesComplete }], agents: [], durableCounts: {} });
      expect(plan.refusals).toEqual([]);
      expect(plan.dispatch).toHaveLength(1);
      expect(plan.dispatch[0]).toMatchObject({ kind: 'fix', prNumber: identity.pr,
        mqFailureRecovery: { recoveryAction: filesComplete === true ? 'refresh' : 'fix',
          evidence: { testFiles: route.testFiles, complete: true } } });
    }
  });

  it('assertion-only failed job prevents refresh alongside an outside-diff failure', async () => {
    const evidence = await collectMqFailureEvidence({ removal: identity, io: {
      listRuns: vi.fn(async () => ({ runs: [{ id: 701, event: 'merge_group', conclusion: 'failure', head_sha: 'c'.repeat(40),
        head_branch: `gh-readonly-queue/main/pr-${identity.pr}-${'b'.repeat(40)}` }], complete: true, nextPage: null })),
      isAncestor: vi.fn(async () => true),
      listJobs: vi.fn(async () => ({ jobs: [
        { id: 901, name: 'outside-diff tests', conclusion: 'failure' },
        { id: 902, name: 'unidentified failing tests', conclusion: 'failure' },
      ], complete: true, nextPage: null })),
      readJobLog: vi.fn(async ({ jobId }) => ({ text: jobId === 901
        ? 'FAIL tests/widget.test.mjs > keeps state\nAssertionError: expected true'
        : 'AssertionError: expected true', complete: true })),
    } });
    expect(evidence).toMatchObject({ complete: false,
      failedJobs: ['outside-diff tests', 'unidentified failing tests'], testFiles: ['tests/widget.test.mjs'] });
    const parsed = parseMqFailureRoute({ expected: identity,
      comment: { body: buildMqFailureRoute({ ...identity, ...evidence }), author: { login: 'chalbert' } } });
    const input = { ...identity, route: parsed, changedFiles };
    expect(classifyMqFailureIntake(input)).toBe('fix');
    expect(admitMqFailureRoute(input)).toMatchObject({ kind: 'fix', recoveryAction: 'fix', evidence });
  });
});


describe('mq failure durable fixer fallback', () => {
  it.each(['conflict', 'push rejection'])('%s → deferred dispatch → successful fixer admission next pass', failure => {
    let persisted = {};
    // Each pass gets a new ledger and a fresh reconcile object; only storage crosses the boundary.
    const ledger = () => createMqFailureLedger({ io: { atomicUpdate(update) {
      const next = update(structuredClone(persisted));
      persisted = structuredClone(next.state);
      return next.result;
    } } });
    const repo = 'web-everything/web-everything';
    const io = {
      readHead: vi.fn(() => identity.head),
      createCheckout: vi.fn(() => ({ cwd: 'fixture/isolated', branch: 'topic' })),
      git: vi.fn(({ args }) => args[0] === 'merge'
        ? failure === 'conflict' ? { ok: false, conflict: true } : { ok: true, head: 'b'.repeat(40) }
        : { ok: false, error: 'non-fast-forward' }),
      removeCheckout: vi.fn(() => {}),
    };
    const dispatch = vi.fn(planned => ({ pr: planned.pr, sessionId: 'fixture-fixer' }));
    const pass = lanes => runReconcileFixDispatch({
      root: 'fixture/dispatch', repo: 'we', dryRun: false,
      reconcile: () => ({ dispatch: [{ kind: 'fix', prNumber: identity.pr,
        headRefName: 'topic', headRefOid: identity.head, files: ['src/unrelated.mjs'],
        mqFailureRecovery: admitMqFailureRoute({ ...identity, repo,
          route: { ...route, repo }, changedFiles: { ...changedFiles, repo } }) }], refusals: [] }),
      mqFailureLedger: ledger(), mqFailureIo: io,
      fetchItemlessDiffPaths: () => ['src/unrelated.mjs'],
      checkStaleness: () => ({ fresh: true, behind: 0 }),
      loadItems: () => [], findItemFn: () => null, pickFreeLanes: () => lanes,
      tryResume: () => ({ resumed: false }), tryResumeRound: null,
      listFixClaims: () => [], listBuildClaims: () => [], priorityShadow: null,
      dispatch,
    });
    const deferred = pass([]);
    expect(deferred.dispatched).toEqual([]);
    expect(deferred.refusals).toContainEqual(expect.objectContaining({ kind: 'no-lane', pr: identity.pr }));
    expect(dispatch).not.toHaveBeenCalled();
    const admitted = pass([5]);
    expect(admitted.dispatched).toEqual([{ pr: identity.pr, sessionId: 'fixture-fixer' }]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ pr: identity.pr,
      mqFailureRecovery: { recoveryAction: 'fix', evidence: { testFiles: route.testFiles, assertions: route.assertions } } });
    expect(io.createCheckout).toHaveBeenCalledTimes(1);
    expect(io.git.mock.calls.filter(([call]) => call.args[0] === 'merge')).toHaveLength(1);
    expect(io.git.mock.calls.filter(([call]) => call.args[0] === 'push')).toHaveLength(failure === 'conflict' ? 0 : 1);
    expect(io.removeCheckout).toHaveBeenCalledTimes(1);
  });
});


describe('mq failure production changed-files intake', () => {
  it.each(['complete', 'inside', 'head changed before', 'head changed during', 'unreadable head', 'unreadable files', 'oversized files'])(
    'outside-diff route + production-shaped fetch => refresh only with complete pinned evidence: %s', mode => {
      const repo = 'web-everything/web-everything';
      const body = buildMqFailureRoute({ ...route, repo });
      const pr = { number: identity.pr, state: 'OPEN', headRefName: 'topic', headRefOid: identity.head,
        labels: [{ name: 'review:changes' }], mergeStateStatus: 'CLEAN',
        statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }],
        comments: [{ body, author: { login: 'chalbert' } }], files: [{ path: 'src/unrelated.mjs' }] };
      const readHead = vi.fn(() => identity.head);
      if (mode === 'head changed before') readHead.mockReturnValue('c'.repeat(40));
      if (mode === 'head changed during') readHead.mockReturnValueOnce(identity.head).mockReturnValue('c'.repeat(40));
      if (mode === 'unreadable head') readHead.mockImplementation(() => { throw new Error('unreadable'); });
      const exec = vi.fn(() => {
        if (mode === 'unreadable files') throw new Error('files unavailable');
        if (mode === 'oversized files') return Array.from({ length: 3000 }, (_, i) => `src/file${i}.mjs`).join('\n');
        return mode === 'inside' ? 'tests/widget.test.mjs\n' : 'src/unrelated.mjs\n';
      });
      const fetchFiles = vi.fn(number => fetchPrDiffPaths(number, { root: 'fixture/dispatch', repo, exec }));
      const refresh = vi.fn(() => ({ action: 'refreshed', head: 'b'.repeat(40) }));
      const dispatch = vi.fn(planned => ({ pr: planned.pr }));
      const result = runReconcileFixDispatch({ root: 'fixture/dispatch', repo: 'we', dryRun: false,
        reconcile: () => planReconcile({ repo: 'we', prs: [structuredClone(pr)], agents: [], durableCounts: {} }),
        checkStaleness: () => ({ fresh: true, behind: 0 }),
        mqFailureIo: { readHead }, mqFailureLedger: { readFixFallback: () => false },
        refreshMqFailure: refresh, fetchItemlessDiffPaths: fetchFiles,
        loadItems: () => [], findItemFn: () => null, pickFreeLanes: () => [5],
        tryResume: () => ({ resumed: false }), tryResumeRound: null,
        listFixClaims: () => [], listBuildClaims: () => [], priorityShadow: null, dispatch,
      });
      if (mode === 'complete') {
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(refresh.mock.calls[0][0]).toMatchObject({ repo, pr: identity.pr, head: identity.head });
        expect(exec).toHaveBeenCalledWith('gh', ['pr', 'diff', String(identity.pr), '--name-only', '--repo', repo], expect.any(Object));
        expect(readHead).toHaveBeenCalledTimes(2);
        expect(dispatch).not.toHaveBeenCalled();
        expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'mq-failure-refresh' }));
      } else {
        expect(refresh).not.toHaveBeenCalled();
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch.mock.calls[0][0]).toMatchObject({ mqFailureRecovery: { recoveryAction: 'fix' } });
      }
    });
});


// ── Reconcile precedence and cap, and the dispatcher's fail-closed guards ────────────────────────────────────
const wePrRepo = 'web-everything/web-everything';
const routedPr = (overrides = {}) => ({
  number: identity.pr, state: 'OPEN', headRefName: 'lane/mq-recovery', headRefOid: identity.head,
  labels: [{ name: 'review:changes' }], mergeStateStatus: 'CLEAN',
  statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }],
  comments: [{ body: buildMqFailureRoute({ ...route, repo: wePrRepo }), author: { login: 'chalbert' } }],
  files: [{ path: 'src/unrelated.mjs' }], filesComplete: true, ...overrides,
});
const plan = (pr, extra = {}) => planReconcile({ repo: 'we', prs: [pr], agents: [], durableCounts: {}, ...extra });
const mqRows = result => result.dispatch.filter(row => row.mode === 'mq-failure-recovery');

describe('mq recovery admission precedence and cap', () => {
  it('admits an OPEN, ready, unheld PR (baseline for the hold matrix)', () => {
    expect(mqRows(plan(routedPr()))).toHaveLength(1);
  });

  it.each([
    ['review:human', { labels: [{ name: 'review:human' }] }],
    ['red-team:blocked', { labels: [{ name: 'review:changes' }, { name: 'red-team:blocked' }] }],
    ['red-team:pending', { labels: [{ name: 'review:changes' }, { name: 'red-team:pending' }] }],
    ['not OPEN (merged)', { state: 'MERGED' }],
    ['not OPEN (closed)', { state: 'CLOSED' }],
    ['draft', { isDraft: true, statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'failure' }] }],
  ])('existing holds override authenticated MQ recovery: %s', (_name, overrides) => {
    const withRoute = plan(routedPr(overrides));
    expect(mqRows(withRoute)).toEqual([]);
    // The route comment changes nothing: the plan is exactly what the same PR gets without it.
    const without = plan(routedPr({ ...overrides, comments: [] }));
    expect(withRoute.dispatch.map(row => row.kind)).toEqual(without.dispatch.map(row => row.kind));
    expect(withRoute.refusals.map(row => row.kind)).toEqual(without.refusals.map(row => row.kind));
  });

  it.each([
    ['a held fix claim', { fixClaim: { who: 'fix-42', claimedAt: '2026-11-09T00:00:00Z' } }],
    ['an unvetted truncated comment list', { comments: Array.from({ length: 100 }, (_, i) => ({ body: `c${i}`, author: { login: 'x' } })) }],
  ])('an earlier liveness/safety hold wins over a valid route: %s', (_name, overrides) => {
    const pr = routedPr(overrides);
    if (overrides.comments) pr.comments[99] = routedPr().comments[0];
    expect(mqRows(plan(pr))).toEqual([]);
  });

  it('mq recovery respects the fix round cap: exhausted rounds refuse instead of dispatching', () => {
    const open = plan(routedPr(), { durableCounts: { [identity.pr]: 0 } });
    expect(mqRows(open)).toHaveLength(1);
    const capped = plan(routedPr(), { durableCounts: { [identity.pr]: 99 } });
    expect(mqRows(capped)).toEqual([]);
    expect(capped.refusals).toContainEqual(expect.objectContaining({ kind: 'cap-exhausted', prNumber: identity.pr,
      why: expect.stringMatching(/MQ failure recovery fix rounds exhausted/) }));
  });

  it('the route marker is bookkeeping, never a reviewer finding that counts a round', () => {
    const comment = routedPr().comments[0];
    const marker = comment.body.split('\n')[0];
    expect(BOOKKEEPING_MARKERS.some(prefix => marker.startsWith(prefix))).toBe(true);
  });
});

describe('mq recovery dispatcher guards', () => {
  const entry = (overrides = {}) => ({ kind: 'fix', prNumber: identity.pr, headRefName: 'topic', headRefOid: identity.head,
    files: ['src/unrelated.mjs'], mqFailureRecovery: admitMqFailureRoute({ ...identity, repo: wePrRepo,
      route: { ...route, repo: wePrRepo }, changedFiles: { ...changedFiles, repo: wePrRepo } }), ...overrides });
  function run({ entries = [entry()], ledger = { readFixFallback: () => false }, dryRun = false, readHead, refresh, lanes = [5] } = {}) {
    const dispatch = vi.fn(planned => ({ pr: planned.pr, sessionId: 'fixture-fixer' }));
    const fetchFiles = vi.fn(() => ['src/unrelated.mjs']);
    const head = readHead ?? vi.fn(() => identity.head);
    const refreshMqFailure = refresh ?? vi.fn(() => ({ action: 'refreshed', head: 'b'.repeat(40) }));
    const result = runReconcileFixDispatch({ root: 'fixture/dispatch', repo: 'we', dryRun,
      reconcile: () => ({ dispatch: entries, refusals: [] }),
      checkStaleness: () => ({ fresh: true, behind: 0 }),
      mqFailureIo: { readHead: head }, mqFailureLedger: ledger, refreshMqFailure,
      fetchItemlessDiffPaths: fetchFiles, loadItems: () => [], findItemFn: () => null, pickFreeLanes: () => lanes,
      tryResume: () => ({ resumed: false }), tryResumeRound: null,
      listFixClaims: () => [], listBuildClaims: () => [], priorityShadow: null, dispatch });
    return { result, dispatch, fetchFiles, readHead: head, refreshMqFailure };
  }

  it.each([
    ['repo', { repo: 'web-everything/other' }],
    ['PR', { pr: 43 }],
    ['head', { head: 'b'.repeat(40) }],
  ])('misbound direct hints never invoke refresh and never reach the fixer: %s', (_name, mismatch) => {
    const base = entry();
    const f = run({ entries: [{ ...base, mqFailureRecovery: { ...base.mqFailureRecovery, ...mismatch } }] });
    expect(f.refreshMqFailure).not.toHaveBeenCalled();
    expect(f.readHead).not.toHaveBeenCalled();
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.dispatch.mock.calls[0][0].mqFailureRecovery).toBeUndefined();
  });

  it('incomplete evidence is forwarded to the fixer as a plain fix and never refreshed', () => {
    const base = entry();
    const incomplete = { ...base.mqFailureRecovery, recoveryAction: 'refresh', evidence: { ...base.mqFailureRecovery.evidence, complete: false } };
    const f = run({ entries: [{ ...base, mqFailureRecovery: incomplete }] });
    expect(f.refreshMqFailure).not.toHaveBeenCalled();
    expect(f.dispatch.mock.calls[0][0].mqFailureRecovery).toMatchObject({ recoveryAction: 'fix', evidence: { complete: false } });
  });

  it('dryRun reads no diff and passes dryRun to the executor, which can claim and push nothing', () => {
    const refresh = vi.fn(() => ({ action: 'stop', note: 'Dry-run: no refresh' }));
    const f = run({ dryRun: true, refresh });
    expect(f.fetchFiles).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it('one pass reads at most eight MQ diffs; entries past the bound keep fixer admission', () => {
    const entries = Array.from({ length: 9 }, (_, i) => {
      const pr = 100 + i;
      return { kind: 'fix', prNumber: pr, headRefName: `topic-${i}`, headRefOid: identity.head, files: ['src/unrelated.mjs'],
        mqFailureRecovery: admitMqFailureRoute({ ...identity, pr, repo: wePrRepo,
          route: { ...route, pr, repo: wePrRepo }, changedFiles: { ...changedFiles, pr, repo: wePrRepo } }) };
    });
    const f = run({ entries, lanes: [5] });
    expect(f.refreshMqFailure).toHaveBeenCalledTimes(8);
    expect(f.readHead).toHaveBeenCalledTimes(16); // two bracketing head reads per bounded diff read, none for the ninth
    const ninth = f.dispatch.mock.calls.map(([planned]) => planned).find(planned => planned.pr === 108);
    expect(ninth?.mqFailureRecovery).toMatchObject({ recoveryAction: 'fix', refreshNote: expect.stringMatching(/normal fix required/) });
  });

  it.each([
    ['rejecting async ledger', { readFixFallback: () => Promise.reject(new Error('ledger down')) }],
    ['throwing ledger', { readFixFallback: () => { throw new Error('ledger down'); } }],
    ['non-boolean ledger answer', { readFixFallback: () => 'yes' }],
  ])('%s stops the pass for that PR without refresh or dispatch', (_name, ledger) => {
    const f = run({ ledger });
    expect(f.refreshMqFailure).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.result.refusals).toContainEqual(expect.objectContaining({ kind: 'mq-failure-refresh', pr: identity.pr,
      why: expect.stringMatching(/operator inspection required/) }));
  });
});
