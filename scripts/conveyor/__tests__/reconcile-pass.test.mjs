import { vi, it, expect, describe } from 'vitest';


vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal(), execFileSync: vi.fn(),
}));
vi.mock('../../lib/gh-throttle.mjs', async (importOriginal) => {
  const { execFileSync } = await import('node:child_process');
  const { looksLikePersonalAccessDenial } = await importOriginal();
  return {
    // Real shared denial classifier: required-status-checks.mjs delegates its 403/404 test to it (#4708).
    looksLikePersonalAccessDenial,
    execFileSyncThrottled: vi.fn((file, args, opts) => execFileSync(file, args, opts)),
    runGhSync: vi.fn((args, opts) => execFileSync('gh', args, opts)),
  };
});
vi.mock('../../lib/write-all-sync.mjs', () => ({ writeAllSync: vi.fn(), writeLineSync: vi.fn() }));

import { prFileContract } from './pr-file-test-helpers.mjs';
prFileContract({
  name: 'reconcile-pass', load: () => import('../reconcile-pass.mjs'),
  reader: 'defaultReadPrs', run: 'runReconcilePass',
  fields: 'number,title,headRefName,headRefOid,baseRefName,labels,statusCheckRollup,mergeStateStatus,comments,body,files,isDraft,createdAt', reconcile: true,
});


// we:backlog/x81m8xx-*.md (#4189) — a caller passing the internal repo KEY (`--repo=we`, exactly as
// `constellation-repos.mjs` names it) must not reach `gh` as the bare key: `gh pr list --repo we` fails
// (`gh` only understands `owner/name`). Both readers must see the NORMALISED slug.
it('normalises a bare repo KEY (e.g. --repo=we) to its gh owner/name slug before any IO', async () => {
  const { runReconcilePass } = await import('../reconcile-pass.mjs');
  const readPrs = vi.fn(() => []);
  const enrichMainRed = vi.fn((prs) => ({ prs, mainRedWindows: [] }));
  runReconcilePass({
    repo: 'we', readPrs, enrichMainRed,
    readAgents: () => [], enrich: (agents) => agents,
  });
  expect(readPrs).toHaveBeenCalledWith({ repo: 'web-everything/web-everything' });
  // #4501 — `enrichMainRed` now also receives the live-fetched `requiredChecks` (here degraded to the
  // FALLBACK_REQUIRED_STATUS_CHECKS default, since `execFileSync` is mocked with no real `gh` behind it) —
  // this test's own concern (repo-key normalisation) is unaffected.
  // The live required-checks read goes through a host-level cache, so on a machine whose cache already holds the
  // real branch-protection list (e.g. with `soak-replay-gate`) the list is a SUPERSET of the fallback — assert the
  // fallback checks are present rather than pinning the exact host-dependent list.
  expect(enrichMainRed).toHaveBeenCalledWith([], {
    repo: 'web-everything/web-everything', defaultBranch: 'main',
    requiredChecks: expect.arrayContaining(['test', 'smoke', 'daemon-soak']),
  });
});

// #2748 false-red follow-up (soak-replay-gate, PR #2775) — `runReconcilePass` is the ONE call site wired
// end-to-end: it fetches the repo's required status-check names (cached, `we:scripts/lib/required-status-
// checks.mjs`) and threads them into `planReconcile`, so `classifyPr`'s `ci-red` phase means a REQUIRED check
// failed rather than "any check outside a hand-maintained exclusion list". `readRequiredChecks` is injectable
// like every other reader in this file, so this is exercised with no network.
it('fetches the required set once per pass and threads it into planReconcile (never ci-red on an advisory-only red)', async () => {
  const { runReconcilePass } = await import('../reconcile-pass.mjs');
  const rollup = [
    { name: 'soak-replay-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
    { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'smoke', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'daemon-soak', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ];
  const readRequiredChecks = vi.fn(() => ({ checks: ['test', 'smoke', 'daemon-soak'], source: 'live' }));
  const plan = runReconcilePass({
    repo: 'web-everything/web-everything',
    readPrs: () => [{
      number: 2748, headRefName: 'lane/x', labels: [{ name: 'review:accepted' }, { name: 'ready-to-merge' }],
      mergeStateStatus: 'CLEAN', statusCheckRollup: rollup, comments: [],
    }],
    readAgents: () => [], enrich: (agents) => agents, readRequiredChecks,
  });
  expect(readRequiredChecks).toHaveBeenCalledWith({ repo: 'web-everything/web-everything', branch: 'main' });
  expect(plan.dispatch).toEqual([]);
  expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'nothing-owed', phase: 'queued', prNumber: 2748 })]);
});

it('maps repo slugs before binding and refuses unknown repos before IO', async () => {
  const { runReconcilePass } = await import('../reconcile-pass.mjs');
  const requiredChecks = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'];
  const options = {
    readRequiredChecks: () => ({ checks: requiredChecks, source: 'live' }),
    readPrs: () => [{ statusCheckRollup: requiredChecks.map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })), number: 49, headRefName: 'lane/1-x', headRefOid: 'a'.repeat(40), labels: [{ name: 'review:pending' }], comments: [] }],
    readAgents: () => [{ name: 'review-fui-49', pidAlive: true, pid: 1 }], enrich: (agents) => agents,
  };
  expect(runReconcilePass({ ...options, repo: 'frontier-ui/frontierui' }).refusals.some((r) => r.kind === 'live-process')).toBe(true);
  expect(runReconcilePass(options).dispatch).toHaveLength(1);
  expect(() => runReconcilePass({ repo: 'other/repo', readPrs: () => { throw new Error('must not read'); } })).toThrow(/not a constellation repo/);
});

// we:backlog/x5uqim1-*.md (#4075/#3383) — enrichPrsWithMainRedFacts pays the extra `gh run list --branch main`
// read only when at least one PR is currently failing its required check; the other tests in this file (no PR
// ever fails) already prove the zero-cost path implicitly (no `readMainRuns`/`readAheadBy` was ever wired in and
// nothing broke). These pin the paying path explicitly, with the REAL shapes measured 2026-09-25. CORRECTED
// mid-build from an earlier `gh run view --json attempt` design to `ahead_by` (`gh api .../compare`) — see
// `main-red-recovery.mjs`'s own file header for why a rerun of the same stale commit does not actually resolve
// a red-main-caused failure.
it('enrichPrsWithMainRedFacts skips the extra main-run read entirely when nothing is ci-failed', async () => {
  const { enrichPrsWithMainRedFacts } = await import('../reconcile-pass.mjs');
  const readMainRuns = vi.fn();
  const readMainLatestCheckRuns = vi.fn();
  const prs = [{ number: 1, statusCheckRollup: [] }];
  const out = enrichPrsWithMainRedFacts(prs, { readMainRuns, readMainLatestCheckRuns });
  expect(readMainRuns).not.toHaveBeenCalled();
  expect(readMainLatestCheckRuns).not.toHaveBeenCalled();
  expect(out).toEqual({ prs, mainRedWindows: [], mainLatestCheckRuns: [] });
});

it('enrichPrsWithMainRedFacts attaches requiredCheckCompletedAt/aheadByOnMain only to the failing PR (PR #2635\'s real shape)', async () => {
  const { enrichPrsWithMainRedFacts } = await import('../reconcile-pass.mjs');
  const failingCheck = {
    __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE',
    completedAt: '2026-09-25T01:57:47Z',
  };
  const quietPr = { number: 1, statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
  const redPr = { number: 2635, headRefOid: 'ab9985630d90019a07b94e946bc75f8de7a6161f', statusCheckRollup: [failingCheck] };
  const readMainRuns = vi.fn(() => [
    { status: 'completed', conclusion: 'failure', updatedAt: '2026-09-25T01:30:55Z', workflowName: 'CI' },
    { status: 'completed', conclusion: 'success', updatedAt: '2026-09-25T02:31:25Z', workflowName: 'CI' },
  ]);
  const readAheadBy = vi.fn(() => 33);
  const out = enrichPrsWithMainRedFacts([quietPr, redPr], { readMainRuns, readAheadBy });
  expect(readMainRuns).toHaveBeenCalledTimes(1);
  expect(readAheadBy).toHaveBeenCalledWith('ab9985630d90019a07b94e946bc75f8de7a6161f', { repo: null, base: 'main' });
  expect(out.prs[0]).toBe(quietPr); // untouched — not failing
  expect(out.prs[1]).toMatchObject({ number: 2635, requiredCheckCompletedAt: '2026-09-25T01:57:47Z', aheadByOnMain: 33 });
  expect(out.mainRedWindows).toEqual([{ start: '2026-09-25T01:30:55Z', end: '2026-09-25T02:31:25Z' }]);
});

it('enrichPrsWithMainRedFacts also enriches a PR red only on daemon-soak (soak-main-red: not test alone)', async () => {
  const { enrichPrsWithMainRedFacts } = await import('../reconcile-pass.mjs');
  const soakRed = {
    number: 2783, headRefOid: 'cec3090bc6e4342642295723c3f87f0d9216eb41', statusCheckRollup: [
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-09-27T02:03:00Z' },
      { __typename: 'CheckRun', name: 'daemon-soak', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-09-27T02:11:30Z' },
    ],
  };
  const readMainRuns = vi.fn(() => [{ status: 'completed', conclusion: 'failure', updatedAt: '2026-09-27T02:00:00Z', workflowName: 'CI' }]);
  const out = enrichPrsWithMainRedFacts([soakRed], { readMainRuns, readAheadBy: () => 2 });
  expect(readMainRuns).toHaveBeenCalledTimes(1);
  expect(out.prs[0]).toMatchObject({ requiredCheckName: 'daemon-soak', requiredCheckCompletedAt: '2026-09-27T02:11:30Z', aheadByOnMain: 2 });
  expect(out.mainRedWindows).toEqual([{ start: '2026-09-27T02:00:00Z', end: null }]);
});

// landing-freeze fix (2026-09-27) — PR #2790 fixed a `daemon-soak` regression that never ran on `main` at all
// during its own window (see `main-red-recovery.mjs`'s own "LANDING-FREEZE FIX" section header), so
// `mainRedWindows` alone can never attribute #2748/#2783/#2784/#2788/#2789's identical failures to `main`.
// `mainLatestCheckRuns` is the second, retrospection-independent fact `isPrCiFailureOwedRerun`'s green-check
// path needs, read under the SAME "only when something is failing" gate as `mainRedWindows`.
it('enrichPrsWithMainRedFacts also reads mainLatestCheckRuns, under the same pay-only-when-needed gate as mainRedWindows', async () => {
  const { enrichPrsWithMainRedFacts } = await import('../reconcile-pass.mjs');
  const soakRed = {
    number: 2748, headRefOid: 'dfb57d0', statusCheckRollup: [
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-09-27T02:32:41Z' },
      { __typename: 'CheckRun', name: 'daemon-soak', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-09-27T02:36:03Z' },
    ],
  };
  const readMainLatestCheckRuns = vi.fn(() => [{ name: 'daemon-soak', conclusion: 'success', status: 'completed', completed_at: '2026-09-27T03:56:55Z' }]);
  const out = enrichPrsWithMainRedFacts([soakRed], {
    readMainRuns: () => [], readAheadBy: () => 5, readMainLatestCheckRuns,
  });
  expect(readMainLatestCheckRuns).toHaveBeenCalledTimes(1);
  expect(out.mainLatestCheckRuns).toEqual([{ name: 'daemon-soak', conclusion: 'success', status: 'completed', completed_at: '2026-09-27T03:56:55Z' }]);
});

// PR #2793 review — one `gh run list` per pass (not two), and the per-PR green-fix evidence attached.
it('enrichPrsWithMainRedFacts reads main\'s run list once, and attaches the green-fix evidence for a check green on main', async () => {
  const { enrichPrsWithMainRedFacts } = await import('../reconcile-pass.mjs');
  const soakRed = {
    number: 2748, headRefOid: 'dfb57d0', statusCheckRollup: [
      { __typename: 'CheckRun', name: 'daemon-soak', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-09-27T02:36:03Z' },
    ],
  };
  const mainRuns = [{ status: 'completed', conclusion: 'success', updatedAt: '2026-09-27T04:00:00Z', headSha: 'green-sha', workflowName: 'CI' }];
  const readMainRuns = vi.fn(() => mainRuns);
  const readMainLatestCheckRuns = vi.fn(() => [{ name: 'daemon-soak', conclusion: 'success', status: 'completed', completed_at: '2026-09-27T03:56:55Z', head_sha: 'green-sha' }]);
  const readMainGreenFixFacts = vi.fn(() => ({ prContainsMainGreenSha: false, mergeBaseCheckRuns: [] }));
  const out = enrichPrsWithMainRedFacts([soakRed], { readMainRuns, readAheadBy: () => 5, readMainLatestCheckRuns, readMainGreenFixFacts });
  expect(readMainRuns).toHaveBeenCalledTimes(1);
  expect(readMainLatestCheckRuns).toHaveBeenCalledWith(expect.objectContaining({ mainRuns }));
  expect(readMainGreenFixFacts).toHaveBeenCalledWith('dfb57d0', expect.objectContaining({ greenSha: 'green-sha', checkName: 'daemon-soak' }));
  expect(out.prs[0]).toMatchObject({ prContainsMainGreenSha: false, mergeBaseCheckRuns: [] });
});

it('enrichPrsWithMainRedFacts also enriches a PR red only on soak-replay-gate, when requiredChecks names it (#4501)', async () => {
  const { enrichPrsWithMainRedFacts } = await import('../reconcile-pass.mjs');
  const readMainRuns = () => [];
  // Real shape, web-everything/web-everything PR #2939, CI run 36599015675: soak-replay-gate FAILURE while
  // test/smoke/daemon-soak were all SUCCESS.
  const soakGateRed = {
    number: 2939, headRefOid: 'deadbeef', statusCheckRollup: [
      { name: 'test', status: 'completed', conclusion: 'success', completedAt: '2026-09-29T17:08:47Z' },
      { name: 'smoke', status: 'completed', conclusion: 'success', completedAt: '2026-09-29T16:39:24Z' },
      { name: 'daemon-soak', status: 'completed', conclusion: 'success', completedAt: '2026-09-29T16:45:57Z' },
      { name: 'soak-replay-gate', status: 'completed', conclusion: 'failure', completedAt: '2026-09-29T16:39:42Z' },
    ],
  };
  const out = enrichPrsWithMainRedFacts([soakGateRed], {
    readMainRuns, readAheadBy: () => 2, requiredChecks: ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'],
  });
  expect(out.prs[0].requiredCheckName).toBe('soak-replay-gate');
  expect(out.prs[0].requiredCheckCompletedAt).toBe('2026-09-29T16:39:42Z');
});

it('enrichPrsWithMainRedFacts SKIPS that same PR when requiredChecks omits soak-replay-gate (#4501 before/proof)', async () => {
  const { enrichPrsWithMainRedFacts } = await import('../reconcile-pass.mjs');
  const readMainRuns = () => [];
  const soakGateRed = {
    number: 2939, headRefOid: 'deadbeef', statusCheckRollup: [
      { name: 'test', status: 'completed', conclusion: 'success', completedAt: '2026-09-29T17:08:47Z' },
      { name: 'smoke', status: 'completed', conclusion: 'success', completedAt: '2026-09-29T16:39:24Z' },
      { name: 'daemon-soak', status: 'completed', conclusion: 'success', completedAt: '2026-09-29T16:45:57Z' },
      { name: 'soak-replay-gate', status: 'completed', conclusion: 'failure', completedAt: '2026-09-29T16:39:42Z' },
    ],
  };
  const out = enrichPrsWithMainRedFacts([soakGateRed], {
    readMainRuns, readAheadBy: () => 2, requiredChecks: ['test', 'smoke', 'daemon-soak'],
  });
  expect(out.prs).toEqual([soakGateRed]); // unchanged — never even enriched
  expect(out.mainRedWindows).toEqual([]);
});

it('runReconcilePass threads the live-fetched requiredChecks into enrichMainRed, not just planReconcile (#4501)', async () => {
  const { runReconcilePass } = await import('../reconcile-pass.mjs');
  let enrichMainRedCalledWith = null;
  const readRequiredChecks = () => ({ checks: ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'], source: 'live' });
  const enrichMainRed = (prs, opts) => { enrichMainRedCalledWith = opts; return { prs, mainRedWindows: [], mainLatestCheckRuns: [] }; };
  runReconcilePass({
    readPrs: () => [], readAgents: () => [], enrich: (a) => a, enrichMainRed,
    enrichAlreadyLanded: (prs) => prs, enrichBaseRef: (prs) => prs, enrichSystemFix: (prs) => prs,
    enrichFixClaims: (prs) => prs, readRequiredChecks, resolveMainSha: () => null,
  });
  expect(enrichMainRedCalledWith.requiredChecks).toEqual(['test', 'smoke', 'daemon-soak', 'soak-replay-gate']);
});

it('enrichPrsWithMainRedFacts skips the green-fix read when the check is not green on main', async () => {
  const { enrichPrsWithMainRedFacts } = await import('../reconcile-pass.mjs');
  const soakRed = {
    number: 2748, headRefOid: 'dfb57d0', statusCheckRollup: [
      { __typename: 'CheckRun', name: 'daemon-soak', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-09-27T02:36:03Z' },
    ],
  };
  const readMainGreenFixFacts = vi.fn();
  const out = enrichPrsWithMainRedFacts([soakRed], {
    readMainRuns: () => [], readAheadBy: () => 5, readMainLatestCheckRuns: () => [], readMainGreenFixFacts,
  });
  expect(readMainGreenFixFacts).not.toHaveBeenCalled();
  expect(out.prs[0]).toMatchObject({ prContainsMainGreenSha: null, mergeBaseCheckRuns: null });
});

it('defaultReadMainGreenFixFacts: contains-green short-circuits; otherwise reads the merge base\'s check-runs; any failure is null', async () => {
  const { defaultReadMainGreenFixFacts } = await import('../reconcile-pass.mjs');
  const o = { repo: 'web-everything/web-everything', greenSha: 'green-sha', checkName: 'daemon-soak' };

  const containsExec = vi.fn(() => JSON.stringify({ behind_by: 0, merge_base: 'green-sha' }));
  expect(defaultReadMainGreenFixFacts('pr-head', { ...o, exec: containsExec })).toEqual({ prContainsMainGreenSha: true, mergeBaseCheckRuns: null, mergeBaseRunConclusion: null });
  expect(containsExec).toHaveBeenCalledTimes(1);
  expect(containsExec.mock.calls[0][1]).toEqual(expect.arrayContaining(['repos/web-everything/web-everything/compare/green-sha...pr-head']));

  const baseRuns = [{ name: 'daemon-soak', conclusion: 'success', status: 'completed', completed_at: 'x' }];
  const behindExec = vi.fn()
    .mockReturnValueOnce(JSON.stringify({ behind_by: 4, merge_base: 'base-sha' }))
    .mockReturnValueOnce(JSON.stringify(baseRuns));
  // A real result at the base → no run-conclusion read (2 calls only).
  expect(defaultReadMainGreenFixFacts('pr-head', { ...o, exec: behindExec })).toEqual({ prContainsMainGreenSha: false, mergeBaseCheckRuns: baseRuns, mergeBaseRunConclusion: null });
  expect(behindExec).toHaveBeenCalledTimes(2);
  expect(behindExec.mock.calls[1][1]).toEqual([
    'api', 'repos/web-everything/web-everything/commits/base-sha/check-runs?check_name=daemon-soak&per_page=100', '--jq', '.check_runs',
  ]);

  // No result at the base (PR #2748's shape) → reads the base's own CI push run; newest COMPLETED `CI` wins.
  const skippedExec = vi.fn()
    .mockReturnValueOnce(JSON.stringify({ behind_by: 4, merge_base: 'base-sha' }))
    .mockReturnValueOnce(JSON.stringify([{ name: 'daemon-soak', conclusion: 'skipped', status: 'completed', completed_at: 'x' }]))
    .mockReturnValueOnce(JSON.stringify([
      { name: 'CI', status: 'completed', conclusion: 'cancelled', updated_at: '2026-09-26T01:00:00Z' },
      { name: 'CI', status: 'completed', conclusion: 'success', updated_at: '2026-09-26T02:00:00Z' },
      { name: 'CI', status: 'in_progress', conclusion: null, updated_at: '2026-09-26T03:00:00Z' },
      { name: 'release-please', status: 'completed', conclusion: 'failure', updated_at: '2026-09-26T04:00:00Z' },
    ]));
  expect(defaultReadMainGreenFixFacts('pr-head', { ...o, exec: skippedExec }).mergeBaseRunConclusion).toBe('success');
  expect(skippedExec.mock.calls[2][1][3]).toBe('repos/web-everything/web-everything/actions/runs?head_sha=base-sha&event=push&per_page=100');

  const none = { prContainsMainGreenSha: null, mergeBaseCheckRuns: null, mergeBaseRunConclusion: null };
  const throwingExec = vi.fn(() => { throw new Error('gh: not found'); });
  expect(defaultReadMainGreenFixFacts('pr-head', { ...o, exec: throwingExec })).toEqual(none);
  const noRepoExec = vi.fn();
  expect(defaultReadMainGreenFixFacts('pr-head', { ...o, repo: null, exec: noRepoExec })).toEqual(none);
  expect(noRepoExec).not.toHaveBeenCalled();
});

it('defaultReadMainLatestCheckRuns never calls exec at all with no repo — the safe no-op default (mirrors defaultReadRequiredContexts)', async () => {
  const { defaultReadMainLatestCheckRuns } = await import('../reconcile-pass.mjs');
  const exec = vi.fn();
  expect(defaultReadMainLatestCheckRuns({ exec, repo: null })).toEqual([]);
  expect(exec).not.toHaveBeenCalled();
});

it('defaultReadMainLatestCheckRuns reads main\'s latest completed run\'s own check-runs, and degrades to [] on any failure', async () => {
  const { defaultReadMainLatestCheckRuns } = await import('../reconcile-pass.mjs');
  const readMainRuns = vi.fn(() => [
    { status: 'completed', updatedAt: '2026-09-27T04:00:00Z', headSha: 'main-tip-sha', workflowName: 'CI' },
  ]);
  const exec = vi.fn(() => JSON.stringify([{ name: 'daemon-soak', conclusion: 'success', status: 'completed', completed_at: '2026-09-27T03:56:55Z' }]));
  const out = defaultReadMainLatestCheckRuns({ exec, repo: 'web-everything/web-everything', readMainRuns });
  expect(out).toEqual([{ name: 'daemon-soak', conclusion: 'success', status: 'completed', completed_at: '2026-09-27T03:56:55Z' }]);
  expect(exec).toHaveBeenCalledWith('gh', [
    // PR #2793 review — `per_page=100`: the default page of 30 can push the failing check off page one.
    'api', 'repos/web-everything/web-everything/commits/main-tip-sha/check-runs?per_page=100', '--jq', '.check_runs',
  ], expect.any(Object));

  const throwingExec = vi.fn(() => { throw new Error('gh: not found'); });
  expect(defaultReadMainLatestCheckRuns({ exec: throwingExec, repo: 'web-everything/web-everything', readMainRuns })).toEqual([]);
});

it('defaultReadMainRuns filters to the CI workflow and passes the exact pinned argv', async () => {
  const { execFileSync } = await import('node:child_process');
  execFileSync.mockReturnValueOnce(JSON.stringify([
    { databaseId: 1, workflowName: 'CI', status: 'completed', conclusion: 'success', createdAt: 'a', updatedAt: 'b' },
    { databaseId: 2, workflowName: 'release-please', status: 'completed', conclusion: 'success', createdAt: 'a', updatedAt: 'b' },
  ]));
  const { defaultReadMainRuns } = await import('../reconcile-pass.mjs');
  const runs = defaultReadMainRuns({});
  expect(runs).toEqual([{ databaseId: 1, workflowName: 'CI', status: 'completed', conclusion: 'success', createdAt: 'a', updatedAt: 'b' }]);
  expect(execFileSync).toHaveBeenCalledWith('gh', [
    'run', 'list', '--branch', 'main', '--limit', '100', '--json', 'databaseId,conclusion,status,createdAt,updatedAt,workflowName,headSha',
  ], expect.any(Object));
});

it('defaultReadAheadBy reads ahead_by off the real compare-endpoint shape, and degrades to null on any failure (best-effort)', async () => {
  const { execFileSync } = await import('node:child_process');
  execFileSync.mockReturnValueOnce('33\n');
  const { defaultReadAheadBy } = await import('../reconcile-pass.mjs');
  expect(defaultReadAheadBy('ab9985630d90019a07b94e946bc75f8de7a6161f', { repo: 'web-everything/web-everything' })).toBe(33);
  expect(execFileSync).toHaveBeenCalledWith('gh', [
    'api', '--method', 'GET',
    'repos/web-everything/web-everything/compare/ab9985630d90019a07b94e946bc75f8de7a6161f...main', '--jq', '.ahead_by',
  ], expect.any(Object));

  execFileSync.mockImplementationOnce(() => { throw new Error('gh: not found'); });
  expect(defaultReadAheadBy('deadbeef', {})).toBeNull();
});

// live incident, web-everything/web-everything PR #2752 (#4034/#2748) — see `we:scripts/lib/already-landed-content.mjs`'s
// own header for the incident. These pin the IO shell that computes `alreadyLandedInMain` off per-file blob
// identity against `main`'s own history, injected so the whole path is exercisable with no real git/gh.
const HEAD_2752 = '253d75c2b82988be773903cba4e5ed172be57fb8';
const BASE_2752 = '06d01a43e0000000000000000000000000000000';
const BLOB = 'b'.repeat(40);

it('enrichPrsWithAlreadyLandedFacts skips a PR with no merge-status:conflicting label entirely — zero extra IO', async () => {
  const { enrichPrsWithAlreadyLandedFacts } = await import('../reconcile-pass.mjs');
  const fetchRef = vi.fn();
  const readMergeBase = vi.fn();
  const prs = [{ number: 1, labels: [{ name: 'review:changes' }] }];
  const out = enrichPrsWithAlreadyLandedFacts(prs, { fetchRef, readMergeBase });
  expect(fetchRef).not.toHaveBeenCalled();
  expect(readMergeBase).not.toHaveBeenCalled();
  expect(out).toEqual(prs);
  expect(out[0].alreadyLandedInMain).toBeUndefined();
});

it('enrichPrsWithAlreadyLandedFacts attaches alreadyLandedInMain with the attributed carrier PR when every change matches (PR #2752\'s real shape)', async () => {
  const { enrichPrsWithAlreadyLandedFacts } = await import('../reconcile-pass.mjs');
  const pr = {
    number: 2752, headRefName: 'lane/4034-critical-work-gate', headRefOid: HEAD_2752,
    labels: [{ name: 'review:changes' }, { name: 'merge-status:conflicting' }],
  };
  const fetchRef = vi.fn();
  const readMergeBase = vi.fn(() => BASE_2752);
  const changes = [
    { status: 'A', path: 'scripts/lib/critical-work.mjs', dstMode: '100644', dstBlob: BLOB },
    { status: 'M', path: 'scripts/lib/provider-routing.mjs', dstMode: '100644', dstBlob: BLOB },
  ];
  const readChanges = vi.fn(() => changes);
  const findMatchingCommit = vi.fn(() => '22faaaa916445657928d5e30720881b830387ab6');
  const readPulls = vi.fn(() => [2759]);
  const out = enrichPrsWithAlreadyLandedFacts([pr], { fetchRef, readMergeBase, readChanges, findMatchingCommit, readPulls });
  // Fetched by PR NUMBER — never by the author-controlled branch name (PR #2769 security review).
  expect(fetchRef).toHaveBeenCalledWith(2752, {});
  expect(readMergeBase).toHaveBeenCalledWith(HEAD_2752, 'origin/main', {});
  expect(readChanges).toHaveBeenCalledWith(BASE_2752, HEAD_2752, {});
  // Every change is searched only within `<merge-base>..origin/main`.
  expect(findMatchingCommit).toHaveBeenCalledWith(changes[0], { base: BASE_2752, mainRef: 'origin/main' });
  expect(out[0].alreadyLandedInMain).toEqual({ carrierPr: 2759 });
  // one pulls lookup per DISTINCT matched commit, never one per file.
  expect(readPulls).toHaveBeenCalledTimes(1);
});

it('enrichPrsWithAlreadyLandedFacts leaves the PR untouched when even one change has no match — never guesses partial containment', async () => {
  const { enrichPrsWithAlreadyLandedFacts } = await import('../reconcile-pass.mjs');
  const pr = {
    number: 2752, headRefName: 'lane/4034-critical-work-gate', headRefOid: HEAD_2752,
    labels: [{ name: 'merge-status:conflicting' }],
  };
  const readChanges = vi.fn(() => [
    { status: 'A', path: 'b.txt', dstMode: '100644', dstBlob: BLOB },
    { status: 'D', path: 'a.txt', dstMode: '000000', dstBlob: '0'.repeat(40) }, // a rename's source half
  ]);
  const findMatchingCommit = vi.fn((change) => (change.path === 'b.txt' ? 'commit1' : null));
  const out = enrichPrsWithAlreadyLandedFacts([pr], {
    fetchRef: vi.fn(), readMergeBase: () => BASE_2752, readChanges, findMatchingCommit, readPulls: vi.fn(),
  });
  expect(out[0].alreadyLandedInMain).toBeUndefined();
});

it('enrichPrsWithAlreadyLandedFacts never guesses containment with no merge-base, no readable changes, or a non-sha head', async () => {
  const { enrichPrsWithAlreadyLandedFacts } = await import('../reconcile-pass.mjs');
  const pr = { number: 2752, headRefOid: HEAD_2752, labels: [{ name: 'merge-status:conflicting' }] };
  const readChanges = vi.fn(() => []);
  expect(enrichPrsWithAlreadyLandedFacts([pr], { fetchRef: vi.fn(), readMergeBase: () => null, readChanges })[0]
    .alreadyLandedInMain).toBeUndefined();
  expect(readChanges).not.toHaveBeenCalled();
  expect(enrichPrsWithAlreadyLandedFacts([pr], { fetchRef: vi.fn(), readMergeBase: () => BASE_2752, readChanges })[0]
    .alreadyLandedInMain).toBeUndefined();
  const readMergeBase = vi.fn();
  const hostile = { ...pr, headRefOid: '--output=/x' };
  expect(enrichPrsWithAlreadyLandedFacts([hostile], { fetchRef: vi.fn(), readMergeBase })[0]).toBe(hostile);
  expect(readMergeBase).not.toHaveBeenCalled();
});

// #4265 (PR #2797 review, live incident 2026-09-27) — the stacked-base conflict-fix cap's own `currentSha` used
// to be hardcoded `null` in `reconcile-core.mjs`, so repairs against different, since-rebased tips of the same
// stacked base all counted as "the same conflict" and exhausted the smaller per-target cap. This attaches
// `baseRefSha` — the SAME purely-local `git rev-parse origin/<ref>` read `defaultResolveMainSha` already does
// for `mainSha`, just pointed at each stacked PR's own base ref — so `reconcile-core.mjs` can tell a stale
// repeat apart from a fresh tip.
describe('enrichPrsWithBaseRefFacts (#4265)', () => {
  it('attaches baseRefSha for a PR whose base differs from defaultBranch, resolved via the injected reader', async () => {
    const { enrichPrsWithBaseRefFacts } = await import('../reconcile-pass.mjs');
    const resolveRef = vi.fn(() => 'ddd4444');
    const pr = { number: 2578, baseRefName: 'lane/3681-ratify-daemon-lifecycle' };
    const out = enrichPrsWithBaseRefFacts([pr], { resolveRef });
    expect(out[0].baseRefSha).toBe('ddd4444');
    expect(resolveRef).toHaveBeenCalledWith('lane/3681-ratify-daemon-lifecycle');
  });

  it('resolves each DISTINCT base ref only once, even when several PRs share the same stacked base', async () => {
    const { enrichPrsWithBaseRefFacts } = await import('../reconcile-pass.mjs');
    const resolveRef = vi.fn(() => 'ddd4444');
    const prs = [
      { number: 1, baseRefName: 'lane/shared-base' },
      { number: 2, baseRefName: 'lane/shared-base' },
    ];
    const out = enrichPrsWithBaseRefFacts(prs, { resolveRef });
    expect(out.every((pr) => pr.baseRefSha === 'ddd4444')).toBe(true);
    expect(resolveRef).toHaveBeenCalledTimes(1);
  });

  it('leaves a PR whose base IS defaultBranch, or names none, untouched — never calls resolveRef for it', async () => {
    const { enrichPrsWithBaseRefFacts } = await import('../reconcile-pass.mjs');
    const resolveRef = vi.fn(() => 'ddd4444');
    const prs = [{ number: 1, baseRefName: 'main' }, { number: 2 }, { number: 3, baseRefName: null }];
    const out = enrichPrsWithBaseRefFacts(prs, { resolveRef });
    expect(out.map((pr) => pr.baseRefSha)).toEqual([undefined, undefined, undefined]);
    expect(resolveRef).not.toHaveBeenCalled();
  });

  it('a failed/unresolvable ref (resolveRef returns null) degrades to baseRefSha: null, never throws', async () => {
    const { enrichPrsWithBaseRefFacts } = await import('../reconcile-pass.mjs');
    const out = enrichPrsWithBaseRefFacts([{ number: 1, baseRefName: 'lane/gone' }], { resolveRef: () => null });
    expect(out[0].baseRefSha).toBeNull();
  });

  it('a caller-supplied defaultBranch overrides "main" — a PR based on the repo\'s actual default is not "stacked"', async () => {
    const { enrichPrsWithBaseRefFacts } = await import('../reconcile-pass.mjs');
    const resolveRef = vi.fn(() => 'ddd4444');
    const out = enrichPrsWithBaseRefFacts([{ number: 1, baseRefName: 'trunk' }], { resolveRef, defaultBranch: 'trunk' });
    expect(out[0].baseRefSha).toBeUndefined();
    expect(resolveRef).not.toHaveBeenCalled();
  });
});

// #4265 — `runReconcilePass` must thread `enrichBaseRef`'s own output into `planReconcile` so a stacked PR's
// `baseRefSha` evidence ever reaches `reconcile-core.mjs` at all (a wiring gap here would silently degrade every
// caller back to the pre-#4265 ref-only comparison even with `enrichPrsWithBaseRefFacts` itself correct).
it('runReconcilePass threads enrichBaseRef\'s output through to planReconcile (#4265)', async () => {
  const { runReconcilePass } = await import('../reconcile-pass.mjs');
  const stackedPr = { statusCheckRollup: ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'].map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })), number: 2578, baseRefName: 'lane/3681-ratify-daemon-lifecycle', comments: [] };
  const enrichBaseRef = vi.fn((prs) => prs.map((pr) => ({ ...pr, baseRefSha: 'ddd4444' })));
  runReconcilePass({
    readPrs: () => [stackedPr], readAgents: () => [], enrich: (a) => a,
    enrichMainRed: (prs) => ({ prs, mainRedWindows: [] }), enrichAlreadyLanded: (prs) => prs,
    enrichBaseRef,
  });
  expect(enrichBaseRef).toHaveBeenCalledWith([stackedPr], { defaultBranch: 'main' });
});

// #4263 (PR #2787 review, live incident 2026-09-27) — a `waiting-on-system-fix` ci-heal escalation refuses
// until the referenced fix PR lands, but nothing ever re-checked whether it actually had — the refusal keyed
// purely on the escalation's own head match and suppressed healing FOREVER even after the fix genuinely
// merged. This re-scans each PR's own comments with the SAME pure `latestCiHealEscalationForHead` reader
// `reconcile-core.mjs` uses, and independently re-checks the named `systemFixRef` PR's own current state.
describe('enrichPrsWithSystemFixFacts (#4263)', () => {
  it('attaches systemFixLanded:true when the named systemFixRef PR has since MERGED', async () => {
    const { enrichPrsWithSystemFixFacts } = await import('../reconcile-pass.mjs');
    const { buildCiHealEscalationComment } = await import('../ci-heal-escalation-mark.mjs');
    const escalation = buildCiHealEscalationComment({ headSha: 'aaa1111', outcome: 'waiting-on-system-fix', systemFixRef: 2784 });
    const pr = { number: 2783, headRefOid: 'aaa1111', comments: [{ body: escalation, author: { login: 'web-everything' } }] };
    const readSystemFixState = vi.fn(() => 'merged');
    const out = enrichPrsWithSystemFixFacts([pr], { readSystemFixState });
    expect(out[0].systemFixLanded).toBe(true);
    expect(readSystemFixState).toHaveBeenCalledWith('2784', { repo: null });
  });

  it('attaches systemFixLanded:true when the named systemFixRef PR has since CLOSED (abandoned, not merged)', async () => {
    const { enrichPrsWithSystemFixFacts } = await import('../reconcile-pass.mjs');
    const { buildCiHealEscalationComment } = await import('../ci-heal-escalation-mark.mjs');
    const escalation = buildCiHealEscalationComment({ headSha: 'aaa1111', outcome: 'waiting-on-system-fix', systemFixRef: 2784 });
    const pr = { number: 2783, headRefOid: 'aaa1111', comments: [{ body: escalation, author: { login: 'web-everything' } }] };
    const out = enrichPrsWithSystemFixFacts([pr], { readSystemFixState: () => 'closed' });
    expect(out[0].systemFixLanded).toBe(true);
  });

  it('leaves the PR untouched (no systemFixLanded field) while the referenced fix PR is still open/pending', async () => {
    const { enrichPrsWithSystemFixFacts } = await import('../reconcile-pass.mjs');
    const { buildCiHealEscalationComment } = await import('../ci-heal-escalation-mark.mjs');
    const escalation = buildCiHealEscalationComment({ headSha: 'aaa1111', outcome: 'waiting-on-system-fix', systemFixRef: 2784 });
    const pr = { number: 2783, headRefOid: 'aaa1111', comments: [{ body: escalation, author: { login: 'web-everything' } }] };
    const out = enrichPrsWithSystemFixFacts([pr], { readSystemFixState: () => 'pending' });
    expect(out[0].systemFixLanded).toBeUndefined();
  });

  it('never touches a PR with no escalation, or a plain needs-human escalation — zero extra IO', async () => {
    const { enrichPrsWithSystemFixFacts } = await import('../reconcile-pass.mjs');
    const { buildCiHealEscalationComment } = await import('../ci-heal-escalation-mark.mjs');
    const needsHuman = buildCiHealEscalationComment({ headSha: 'aaa1111', outcome: 'needs-human' });
    const readSystemFixState = vi.fn();
    const prs = [
      { number: 1, headRefOid: 'aaa1111', comments: [] },
      { number: 2, headRefOid: 'aaa1111', comments: [{ body: needsHuman, author: { login: 'web-everything' } }] },
    ];
    const out = enrichPrsWithSystemFixFacts(prs, { readSystemFixState });
    expect(out.map((pr) => pr.systemFixLanded)).toEqual([undefined, undefined]);
    expect(readSystemFixState).not.toHaveBeenCalled();
  });

  it('resolves each DISTINCT systemFixRef only once, even when several PRs escalate to the same fix', async () => {
    const { enrichPrsWithSystemFixFacts } = await import('../reconcile-pass.mjs');
    const { buildCiHealEscalationComment } = await import('../ci-heal-escalation-mark.mjs');
    const escalation = buildCiHealEscalationComment({ headSha: 'aaa1111', outcome: 'waiting-on-system-fix', systemFixRef: 2784 });
    const prs = [
      { number: 1, headRefOid: 'aaa1111', comments: [{ body: escalation, author: { login: 'web-everything' } }] },
      { number: 2, headRefOid: 'aaa1111', comments: [{ body: escalation, author: { login: 'web-everything' } }] },
    ];
    const readSystemFixState = vi.fn(() => 'merged');
    const out = enrichPrsWithSystemFixFacts(prs, { readSystemFixState });
    expect(out.every((pr) => pr.systemFixLanded === true)).toBe(true);
    expect(readSystemFixState).toHaveBeenCalledTimes(1);
  });
});

// #4263 — `runReconcilePass` must thread `enrichSystemFix`'s own output into `planReconcile`, mirroring the
// `enrichBaseRef` wiring test above — a gap here would silently degrade every caller back to refusing forever.
it('runReconcilePass threads enrichSystemFix\'s output through to planReconcile (#4263)', async () => {
  const { runReconcilePass } = await import('../reconcile-pass.mjs');
  const escalatedPr = { statusCheckRollup: ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'].map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })), number: 2783, headRefOid: 'aaa1111', comments: [] };
  const enrichSystemFix = vi.fn((prs) => prs.map((pr) => ({ ...pr, systemFixLanded: true })));
  runReconcilePass({
    readPrs: () => [escalatedPr], readAgents: () => [], enrich: (a) => a,
    enrichMainRed: (prs) => ({ prs, mainRedWindows: [] }), enrichAlreadyLanded: (prs) => prs,
    enrichBaseRef: (prs) => prs, enrichSystemFix,
  });
  expect(enrichSystemFix).toHaveBeenCalledWith([escalatedPr], { repo: null });
});

it('defaultFetchRef fetches refs/pull/<n>/head behind --end-of-options into an explicit destination — never the branch name (PR #2769 security review)', async () => {
  const { defaultFetchRef } = await import('../reconcile-pass.mjs');
  const exec = vi.fn();
  defaultFetchRef(2752, { exec });
  expect(exec).toHaveBeenCalledWith('git', [
    'fetch', '--quiet', '--end-of-options', 'origin', '+refs/pull/2752/head:refs/already-landed/pr/2752',
  ], expect.any(Object));
  // A hostile branch-name-shaped value (the live exploit: `--upload-pack=<cmd>`) never reaches git at all.
  exec.mockClear();
  for (const bad of ['--upload-pack=touch /tmp/x;', 'lane/x', '0', '-1', '12abc', null, undefined, 2.5]) defaultFetchRef(bad, { exec });
  expect(exec).not.toHaveBeenCalled();
  expect(() => defaultFetchRef(1, { exec: () => { throw new Error('offline'); } })).not.toThrow();
});

it('defaultReadMergeBase / defaultReadChanges guard their revisions and degrade to null / [] on failure', async () => {
  const { defaultReadMergeBase, defaultReadChanges } = await import('../reconcile-pass.mjs');
  const exec = vi.fn(() => `${BASE_2752}\n`);
  expect(defaultReadMergeBase(HEAD_2752, 'origin/main', { exec })).toBe(BASE_2752);
  expect(exec).toHaveBeenCalledWith('git', ['merge-base', '--end-of-options', HEAD_2752, 'origin/main'], expect.any(Object));
  expect(defaultReadMergeBase('--evil', 'origin/main', { exec: vi.fn() })).toBeNull();
  expect(defaultReadMergeBase(HEAD_2752, 'origin/main', { exec: () => { throw new Error('x'); } })).toBeNull();

  const raw = `:100644 100755 ${BLOB} ${BLOB} M\0s.sh\0`;
  const dexec = vi.fn(() => raw);
  expect(defaultReadChanges(BASE_2752, HEAD_2752, { exec: dexec })).toEqual([
    { status: 'M', path: 's.sh', dstMode: '100755', dstBlob: BLOB },
  ]);
  expect(dexec).toHaveBeenCalledWith('git', [
    'diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--end-of-options', BASE_2752, HEAD_2752,
  ], expect.any(Object));
  expect(defaultReadChanges('nope', HEAD_2752, { exec: dexec })).toEqual([]);
  expect(defaultReadChanges(BASE_2752, HEAD_2752, { exec: () => { throw new Error('x'); } })).toEqual([]);
});

// These four inject `exec` EXPLICITLY (mirroring `we:scripts/conveyor/__tests__/reconcile-core.test.mjs`'s own
// `spyExec` pattern) rather than relying on the module-level `node:child_process` mock: that mock is already
// proven to work for `execFileSyncThrottled` (a SEPARATE mocked module wrapping it) elsewhere in this file, but
// a direct default-parameter reference to the bare `execFileSync` binding inside a freshly-added function here
// was measured, live, to bypass it and run REAL git — explicit injection is the reliable, established way this
// codebase asserts an exact argv with no dependence on that mock's own quirks.
it('defaultReadEntryAt reads {mode, blob} for exactly the named path via ls-tree; null only for a clean absence, THROWS on a failed read', async () => {
  const { defaultReadEntryAt } = await import('../reconcile-pass.mjs');
  const exec = vi.fn(() => `100755 blob 774a24d2703ada7a5c3bec4ced8696b13a5f6026\tscripts/run.sh\0`);
  expect(defaultReadEntryAt('253d75c2b', 'scripts/run.sh', { exec })).toEqual({ mode: '100755', blob: '774a24d2703ada7a5c3bec4ced8696b13a5f6026' });
  expect(exec).toHaveBeenCalledWith('git', [
    '--literal-pathspecs', 'ls-tree', '-z', '--full-tree', '--end-of-options', '253d75c2b', '--', 'scripts/run.sh',
  ], expect.any(Object));
  expect(defaultReadEntryAt('253d75c2b', 'missing.mjs', { exec: () => '' })).toBeNull();
  // A failed read is NOT absence — `null` would let a deletion pass for landed (PR #2769 review, round 2).
  expect(() => defaultReadEntryAt('deadbeef', 'x.mjs', { exec: () => { throw new Error('fatal: bad revision'); } })).toThrow(/bad revision/);
});

describe('defaultTipCarriesChange — main\'s tip still carries the PR\'s change (PR #2769 review, round 2)', () => {
  const OLD = 'a'.repeat(40);
  const TIP = 'd'.repeat(40);
  const blobs = (map) => vi.fn((cmd, args) => {
    if (args[0] === 'cat-file') return map[args.at(-1)];
    if (args[0] === 'merge-file') return map.merged;
    throw new Error(`unexpected ${args.join(' ')}`);
  });

  it('edited file: a conflict-free `git merge-file` of the PR into the tip must reproduce the tip exactly', async () => {
    const { defaultTipCarriesChange } = await import('../reconcile-pass.mjs');
    const exec = blobs({ [TIP]: 'a\nfeature=true\nunrelated=1\n', merged: 'a\nfeature=true\nunrelated=1\n' });
    expect(defaultTipCarriesChange(TIP, OLD, BLOB, { exec })).toBe(true);
    expect(exec).toHaveBeenCalledWith('git', ['merge-file', '-p', '--object-id', '--end-of-options', TIP, OLD, BLOB], expect.any(Object));
    // the merge re-applied the PR's change (main had reverted it) — the tip does not carry it.
    expect(defaultTipCarriesChange(TIP, OLD, BLOB, { exec: blobs({ [TIP]: 'a\nfeature=false\nunrelated=1\n', merged: 'a\nfeature=true\nunrelated=1\n' }) })).toBe(false);
  });

  it('edited file: a merge conflict (non-zero exit) throws for the caller to fail closed', async () => {
    const { defaultTipCarriesChange } = await import('../reconcile-pass.mjs');
    const exec = vi.fn((cmd, args) => { if (args[0] === 'merge-file') throw new Error('exit 1: 1 conflict'); return 'x\n'; });
    expect(() => defaultTipCarriesChange(TIP, OLD, BLOB, { exec })).toThrow(/conflict/);
  });

  it('added file: never merged against git\'s empty blob — the PR\'s whole text must sit in the tip unbroken', async () => {
    const { defaultTipCarriesChange } = await import('../reconcile-pass.mjs');
    const exec = blobs({ [TIP]: 'l1\nl2\nrefined\n', [BLOB]: 'l1\nl2\n' });
    expect(defaultTipCarriesChange(TIP, null, BLOB, { exec })).toBe(true);
    expect(exec).toHaveBeenCalledWith('git', ['cat-file', 'blob', '--end-of-options', BLOB], expect.any(Object));
    expect(exec.mock.calls.some(([, args]) => args[0] === 'merge-file')).toBe(false);
    expect(defaultTipCarriesChange(TIP, null, BLOB, { exec: blobs({ [TIP]: 'l1\nmid\nl2\n', [BLOB]: 'l1\nl2\n' }) })).toBe(false);
  });

  it('refuses a non-sha argument before any git call', async () => {
    const { defaultTipCarriesChange } = await import('../reconcile-pass.mjs');
    const exec = vi.fn();
    expect(defaultTipCarriesChange('--upload-pack=x', OLD, BLOB, { exec })).toBe(false);
    expect(defaultTipCarriesChange(TIP, '-x', BLOB, { exec })).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('defaultFindMatchingMainCommit — searches only `<merge-base>..main`, per change status (PR #2769 review)', () => {
  const base = BASE_2752;
  const mainRef = 'origin/main';

  it('A/M: returns the first in-window commit whose entry has the SAME blob AND mode, most-recent-first', async () => {
    const { defaultFindMatchingMainCommit } = await import('../reconcile-pass.mjs');
    const exec = vi.fn(() => 'commitA\ncommitB\ncommitC\n');
    const readEntryAt = vi.fn((ref) => {
      if (ref === base) return null; // an added file: absent at the PR's base
      return ref === 'commitB' || ref === mainRef ? { mode: '100644', blob: BLOB } : { mode: '100644', blob: 'c'.repeat(40) };
    });
    const change = { status: 'A', path: 'scripts/lib/critical-work.mjs', dstMode: '100644', dstBlob: BLOB };
    expect(defaultFindMatchingMainCommit(change, { base, mainRef, exec, readEntryAt })).toBe('commitB');
    expect(exec).toHaveBeenCalledWith('git', [
      '--literal-pathspecs', 'log', '--format=%H', '-n300', `${base}..origin/main`, '--', 'scripts/lib/critical-work.mjs',
    ], expect.any(Object));
  });

  it('A/M: a same-blob, different-mode entry is NOT a match — a mode-only change is never "landed" by its old blob', async () => {
    const { defaultFindMatchingMainCommit } = await import('../reconcile-pass.mjs');
    const change = { status: 'M', path: 's.sh', dstMode: '100755', dstBlob: BLOB };
    const readEntryAt = () => ({ mode: '100644', blob: BLOB });
    expect(defaultFindMatchingMainCommit(change, { base, mainRef, exec: () => 'c1\n', readEntryAt })).toBeNull();
  });

  it('A/M: an in-window match that main later UNDID is not landed — tip gone, or tip back at the base version', async () => {
    const { defaultFindMatchingMainCommit } = await import('../reconcile-pass.mjs');
    const exec = () => 'carrier\n';
    const OLD = 'a'.repeat(40);
    const add = { status: 'A', path: 'n.mjs', dstMode: '100644', dstBlob: BLOB };
    // added by a carrier, then the add was reverted: gone from the tip.
    expect(defaultFindMatchingMainCommit(add, { base, mainRef, exec, readEntryAt: (ref) => (ref === 'carrier' ? { mode: '100644', blob: BLOB } : null) })).toBeNull();
    // modified by a carrier, then reverted: the tip holds the base version again.
    const mod = { status: 'M', path: 'm.mjs', dstMode: '100644', dstBlob: BLOB };
    const entry = (ref) => (ref === 'carrier' ? { mode: '100644', blob: BLOB } : { mode: '100644', blob: OLD });
    // (a revert makes the merge re-apply the PR's change, so the tip-carries check says no)
    expect(defaultFindMatchingMainCommit(mod, { base, mainRef, exec, readEntryAt: entry, tipCarriesChange: () => false })).toBeNull();
  });

  // `main` held the PR's BLOB at `carrier`, then moved the file on to TIP.
  const OLD = 'a'.repeat(40);
  const TIP = 'd'.repeat(40);
  const refinedEntry = (ref) => (ref === 'carrier' ? { mode: '100644', blob: BLOB }
    : ref === base ? { mode: '100644', blob: OLD } : { mode: '100644', blob: TIP });
  const mod = { status: 'M', path: 'm.mjs', dstMode: '100644', dstBlob: BLOB };

  it('A/M: refined after the carry is landed only when the tip still carries the PR\'s change (PR #2769 review, round 2)', async () => {
    const { defaultFindMatchingMainCommit } = await import('../reconcile-pass.mjs');
    const exec = () => 'carrier\n';
    const carries = vi.fn(() => true);
    expect(defaultFindMatchingMainCommit(mod, { base, mainRef, exec, readEntryAt: refinedEntry, tipCarriesChange: carries })).toBe('carrier');
    expect(carries).toHaveBeenCalledWith(TIP, OLD, BLOB, expect.any(Object));
    // the transient-carry and revert-plus-unrelated-edit shapes: main held BLOB once, the tip no longer carries it.
    expect(defaultFindMatchingMainCommit(mod, { base, mainRef, exec, readEntryAt: refinedEntry, tipCarriesChange: () => false })).toBeNull();
    // a failed check (conflict, binary, git error) fails closed.
    expect(defaultFindMatchingMainCommit(mod, { base, mainRef, exec, readEntryAt: refinedEntry, tipCarriesChange: () => { throw new Error('conflict'); } })).toBeNull();
    // the tip IS the PR's blob: no content check needed.
    const exact = vi.fn();
    expect(defaultFindMatchingMainCommit(mod, { base, mainRef, exec, readEntryAt: (ref) => (ref === base ? { mode: '100644', blob: OLD } : { mode: '100644', blob: BLOB }), tipCarriesChange: exact })).toBe('carrier');
    expect(exact).not.toHaveBeenCalled();
  });

  it('A/M: the tip must keep the PR\'s mode; an added file is checked with a null base', async () => {
    const { defaultFindMatchingMainCommit } = await import('../reconcile-pass.mjs');
    const exec = () => 'carrier\n';
    const modeFlipped = (ref) => (ref === mainRef ? { mode: '100755', blob: BLOB } : refinedEntry(ref));
    expect(defaultFindMatchingMainCommit(mod, { base, mainRef, exec, readEntryAt: modeFlipped, tipCarriesChange: () => true })).toBeNull();
    const add = { status: 'A', path: 'n.mjs', dstMode: '100644', dstBlob: BLOB };
    const carries = vi.fn(() => true);
    const addEntry = (ref) => (ref === base ? null : refinedEntry(ref));
    expect(defaultFindMatchingMainCommit(add, { base, mainRef, exec, readEntryAt: addEntry, tipCarriesChange: carries })).toBe('carrier');
    expect(carries).toHaveBeenCalledWith(TIP, null, BLOB, expect.any(Object));
    // an M whose path is missing at the PR's base is inconsistent — never guessed.
    expect(defaultFindMatchingMainCommit(mod, { base, mainRef, exec, readEntryAt: addEntry, tipCarriesChange: () => true })).toBeNull();
  });

  it('D: landed only when the path is gone from main\'s tip AND an in-window commit deleted it', async () => {
    const { defaultFindMatchingMainCommit } = await import('../reconcile-pass.mjs');
    const change = { status: 'D', path: 'dead.mjs', dstMode: '000000', dstBlob: '0'.repeat(40) };
    const exec = vi.fn(() => 'delcommit\n');
    expect(defaultFindMatchingMainCommit(change, { base, mainRef, exec, readEntryAt: () => null })).toBe('delcommit');
    expect(exec).toHaveBeenCalledWith('git', [
      '--literal-pathspecs', 'log', '--format=%H', '-n300', '--diff-filter=D', `${base}..origin/main`, '--', 'dead.mjs',
    ], expect.any(Object));
    // still alive on main (e.g. a rename's source main kept editing) — never landed, no log read at all.
    const exec2 = vi.fn();
    expect(defaultFindMatchingMainCommit(change, { base, mainRef, exec: exec2, readEntryAt: () => ({ mode: '100644', blob: BLOB }) })).toBeNull();
    expect(exec2).not.toHaveBeenCalled();
    // gone from the tip but no in-window deletion (it was deleted before the PR's base) — never landed.
    expect(defaultFindMatchingMainCommit(change, { base, mainRef, exec: () => '', readEntryAt: () => null })).toBeNull();
  });

  it('D: a FAILED tip read is not absence — main deleted then re-added the path, the tip ls-tree times out (PR #2769 review, round 2)', async () => {
    const { defaultFindMatchingMainCommit, defaultReadEntryAt } = await import('../reconcile-pass.mjs');
    const change = { status: 'D', path: 'dead.mjs', dstMode: '000000', dstBlob: '0'.repeat(40) };
    // Real reader, injected exec: the ls-tree fails, the log would find the earlier in-window deletion.
    const exec = vi.fn((cmd, args) => {
      if (args.includes('ls-tree')) throw new Error('ETIMEDOUT');
      return 'olddelete\n';
    });
    expect(defaultFindMatchingMainCommit(change, { base, mainRef, exec, readEntryAt: defaultReadEntryAt })).toBeNull();
    expect(exec.mock.calls.some(([, args]) => args.includes('log'))).toBe(false);
  });

  it('an unsupported status (type change, unmerged) never matches', async () => {
    const { defaultFindMatchingMainCommit } = await import('../reconcile-pass.mjs');
    const exec = vi.fn(() => 'c1\n');
    for (const status of ['T', 'U', 'X']) {
      expect(defaultFindMatchingMainCommit({ status, path: 'a', dstMode: '120000', dstBlob: BLOB }, { base, mainRef, exec, readEntryAt: () => ({ mode: '120000', blob: BLOB }) })).toBeNull();
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('returns null (never throws) with no base / main ref, or when the log read fails', async () => {
    const { defaultFindMatchingMainCommit } = await import('../reconcile-pass.mjs');
    const change = { status: 'A', path: 'a.mjs', dstMode: '100644', dstBlob: BLOB };
    expect(defaultFindMatchingMainCommit(change, { base: null, mainRef })).toBeNull();
    expect(defaultFindMatchingMainCommit(change, { base, mainRef: null })).toBeNull();
    expect(defaultFindMatchingMainCommit(change, { base, mainRef, exec: () => { throw new Error('not a git repo'); } })).toBeNull();
  });
});

it('defaultReadPullsForCommit reads the PR numbers GitHub associates with a commit, degrading to [] on any failure', async () => {
  const { execFileSyncThrottled } = await import('../../lib/gh-throttle.mjs');
  execFileSyncThrottled.mockReturnValueOnce('2759\n');
  const { defaultReadPullsForCommit } = await import('../reconcile-pass.mjs');
  expect(defaultReadPullsForCommit('22faaaa9', { repo: 'web-everything/web-everything' })).toEqual([2759]);
  expect(execFileSyncThrottled).toHaveBeenCalledWith('gh', [
    'api', 'repos/web-everything/web-everything/commits/22faaaa9/pulls', '--jq', '.[].number',
  ], expect.any(Object));

  execFileSyncThrottled.mockImplementationOnce(() => { throw new Error('404'); });
  expect(defaultReadPullsForCommit('deadbeef', {})).toEqual([]);
});

it('skips a deferred snapshot without enriching or planning from empty PR evidence', async () => {
  const { runReconcilePass } = await import('../reconcile-pass.mjs');
  const readAgents = vi.fn();
  const result = runReconcilePass({
    readPrs: () => ({ outcome: 'deferred-low-budget', deferred: true, message: 'skip this pass' }), readAgents,
  });
  expect(result).toMatchObject({ outcome: 'deferred-low-budget', dispatch: [], refusals: [] });
  expect(readAgents).not.toHaveBeenCalled();
});

describe('xng7q1p conservative timeout evidence', () => {
  const head = 'a'.repeat(40);
  const repo = 'web-everything/web-everything';
  const log = (path = 'unit.test.mjs', name = 'suite > times out') =>
    ` FAIL ${path} > ${name}\nError: Test timed out in 5000ms.\n Test Files 1 failed | 1 passed\n Tests 1 failed | 2 passed\n Duration 10.0s\n`;
  const fixture = () => ({ repo, pr: 3415, head, sourceHead: head, diffComplete: true, checksComplete: true,
    changed: [{ filename: 'unrelated.mjs' }], failedChecks: [20], roots: ['vitest.config.ts'],
    sources: { 'vitest.config.ts': 'export default { test: { setupFiles: ["./setup.ts"] } };',
      'setup.ts': 'export const ready = true;', 'unit.test.mjs': 'import { it } from "vitest"; import { value } from "./subject.mjs";',
      'subject.mjs': 'import { value } from "./leaf.mjs"; export {value};', 'leaf.mjs': 'export const value = 1;' },
    jobs: [{ repo, head, run: 10, job: 20, attempt: 1, workflow: '.github/workflows/ci.yml', status: 'completed',
      conclusion: 'failure', logJob: 20, logAttempt: 1, log: log() }],
  });
  const classify = (e) => classifyTimeoutEvidence(e, { repo, pr: 3415, head, ts: timeoutTs });

  it('accepts only a complete timeout inventory and a disjoint source/setup closure', () => {
    expect(classify(fixture())).toMatchObject({ eligible: true, failures: [{ path: 'unit.test.mjs', name: 'suite > times out' }] });
  });
  it.each(['unit.test.mjs', 'subject.mjs', 'leaf.mjs', 'setup.ts', 'vitest.config.ts', 'README.md', 'data.json',
    'package-lock.json', '.github/workflows/ci.yml', 'fixtures/value.mjs'])('refuses changed input %s', (filename) => {
    const e = fixture(); e.changed = [{ filename }]; expect(classify(e).eligible).toBe(false);
  });
  it.each([
    "import { vi } from 'vitest'; await vi.importActual('./subject.mjs');",
    "import { vi } from 'vitest'; await vi.importMock('./subject.mjs');",
    "import { vi as v } from 'vitest'; await v.importActual('./subject.mjs');",
    "import { vi } from 'vitest'; const { importActual: load } = vi; await load('./subject.mjs');",
    "import { vi } from 'vitest'; await vi['importMock']('./subject.mjs');",
    "import { vi } from 'vitest'; await vi[loader]('./subject.mjs');",
    "await import('./subject.mjs');",
  ])('refuses changed dependencies loaded at runtime: %s', (source) => {
    const e = fixture(); e.sources['unit.test.mjs'] = source;
    e.changed = [{ filename: 'subject.mjs' }];
    expect(classify(e)).toMatchObject({ eligible: false, reason: 'unknown-dependency-edge:unit.test.mjs' });
  });
  it('bounds whitespace-heavy logs, oversized logs and oversized lines without accepting partial inventories', () => {
    const started = performance.now();
    expect(parseTimeoutFailures(' \n'.repeat(512 * 1024) + log()).complete).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(parseTimeoutFailures('\n'.repeat(2 * 1024 * 1024) + log()).complete).toBe(false);
    expect(parseTimeoutFailures(' '.repeat(16 * 1024 + 1) + log()).complete).toBe(false);
  });
  it('checks the old name of a renamed dependency', () => {
    const e = fixture(); e.changed = [{ filename: 'renamed.mjs', previous_filename: 'leaf.mjs' }];
    expect(classify(e).reason).toBe('changed-dependency:leaf.mjs');
  });
  it.each([
    (e) => { e.diffComplete = false; }, (e) => { e.checksComplete = false; },
    (e) => { e.head = 'b'.repeat(40); }, (e) => { e.repo = 'other/repo'; },
    (e) => { e.jobs[0].head = 'b'.repeat(40); }, (e) => { e.jobs[0].logJob = 21; },
    (e) => { e.jobs[0].logAttempt = 2; }, (e) => { e.jobs[0].run = null; },
    (e) => { e.jobs[0].status = 'in_progress'; }, (e) => { e.failedChecks.push(21); },
    (e) => { e.jobs[0].log = 'Test timed out in 5000ms.'; },
    (e) => { e.jobs[0].log = log().replace('Tests 1 failed', 'Tests 2 failed'); },
    (e) => { e.jobs[0].log = log().replace('Error: Test timed out in 5000ms.', 'AssertionError: mismatch'); },
    (e) => { e.sources['leaf.mjs'] = 'export const value = import(name);'; },
    (e) => { e.sources['leaf.mjs'] = 'import fs from "node:fs";'; },
    (e) => { delete e.sources['leaf.mjs']; },
  ])('fails closed on incomplete, mixed, stale or unknown evidence %#', (mutate) => {
    const e = fixture(); mutate(e); expect(classify(e).eligible).toBe(false);
  });
  it('keeps duplicate full test names in different files distinct', () => {
    const e = fixture();
    e.sources['other.test.mjs'] = 'import {it} from "vitest";';
    e.jobs[0].log = ' FAIL unit.test.mjs > duplicate\nError: Test timed out in 5000ms.\n'
      + ' FAIL other.test.mjs > duplicate\nError: Test timed out in 5000ms.\n Test Files 2 failed\n Tests 2 failed\n Duration 10s\n';
    expect(classify(e).failures.map((f) => f.path)).toEqual(['unit.test.mjs', 'other.test.mjs']);
  });
  it('enrichment carries classified evidence into the real planner', () => {
    const e = fixture();
    const pr = { number: 3415, headRefOid: head, state: 'OPEN', labels: [],
      statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE',
        detailsUrl: `https://github.com/${repo}/actions/runs/10/job/20` }] };
    const prs = enrichPrsWithTimeoutEvidence([pr], { repo, enabled: true, readBudget: () => ({ confirmed: 0, pending: false }), read: () => classify(e) });
    const out = timeoutPlanReconcile({ prs, requiredChecks: ['test'] });
    expect(out.dispatch[0]).toMatchObject({ kind: 'ci-timeout-rerun', timeoutRetry: { signature: classify(e).signature } });
  });
  it('historical #3415 replay refuses the incomplete aggregate inventory and changed inputs', () => {
    // Sanitized read-only capture: run 36944615955 attempt 1, historical job 110643729641.
    const e = fixture();
    e.head = e.sourceHead = '1df80664a3ec7f67cb7cb19ad1c5c35bf5c80966';
    e.changed = [{ filename: 'scripts/lib/atomic-json-file.mjs' }, { filename: 'scripts/lib/gh-rest-read.mjs' },
      { filename: 'backlog/4429-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md' }];
    e.jobs[0] = { ...e.jobs[0], head: e.head, run: 36944615955, job: 110643729641, logJob: 110643729641,
      log: log('scripts/operations/__tests__/priority-sync.test.mjs',
        'the declaration > is registered on the command line under its own name, with --help derived from the declaration') };
    e.failedChecks = [110643729641, 110645262691]; // aggregate "test" failed as well
    expect(classifyTimeoutEvidence(e, { repo, pr: 3415, head: e.head, ts: timeoutTs }))
      .toEqual({ eligible: false, reason: 'unaccounted-failing-check' });
    expect(parseTimeoutFailures(e.jobs[0].log)).toMatchObject({ complete: true, failures: [{ kind: 'test-timeout' }] });
  });
});
import timeoutTs from 'typescript';
import { classifyTimeoutEvidence, parseTimeoutFailures, enrichPrsWithTimeoutEvidence, readTimeoutEvidence, timeoutImpact, isDerivedTimeoutCheck } from '../reconcile-pass.mjs';
import { planReconcile as timeoutPlanReconcile } from '../reconcile-core.mjs';

it('xng7q1p immutable GitHub reads feed enrichment → planner without checkout-derived scope', () => {
  const head = 'a'.repeat(40), repo = 'web-everything/web-everything';
  const prefix = `repos/${repo}`;
  const log = ' FAIL unit.test.mjs > suite > timeout\nError: Test timed out in 5000ms.\n Test Files 1 failed\n Tests 1 failed\n Duration 5.2s\n';
  const sources = { 'vitest.config.ts': 'export default {test:{}};', 'unit.test.mjs': 'import {it} from "vitest";' };
  const data = {
    [`${prefix}/pulls/3415`]: { state: 'open', head: {sha: head}, base: {sha: 'b'.repeat(40)}, changed_files: 1 },
    [`${prefix}/pulls/3415/files?per_page=100&page=1`]: [{filename:'other.mjs'}],
    [`${prefix}/commits/${head}/check-runs?per_page=100&page=1&filter=latest`]: {
      total_count: 1, check_runs: [{status:'completed',conclusion:'failure',details_url:`https://github.com/${repo}/actions/runs/10/job/20`}] },
    [`${prefix}/commits/${head}/status`]: { total_count: 0 },
    [`${prefix}/actions/jobs/20`]: {id:20,run_id:10,head_sha:head,run_attempt:1,status:'completed',conclusion:'failure'},
    [`${prefix}/actions/runs/10`]: {id:10,head_sha:head,run_attempt:1,repository:{full_name:repo},path:'.github/workflows/ci.yml'},
    [`${prefix}/actions/jobs/20/logs`]: log,
    [`${prefix}/git/trees/${head}?recursive=1`]: {truncated:false,tree:Object.keys(sources).map((path,i)=>({type:'blob',path,sha:`blob${i}`}))},
  };
  Object.values(sources).forEach((source, i) => { data[`${prefix}/git/blobs/blob${i}`] = {encoding:'base64',content:Buffer.from(source).toString('base64')}; });
  const calls = [];
  const exec = (cmd, args) => {
    expect(cmd).toBe('gh'); expect(args[0]).toBe('api'); calls.push(args[1]);
    if (!(args[1] in data)) throw new Error(`unaccounted read ${args[1]}`);
    return typeof data[args[1]] === 'string' ? data[args[1]] : JSON.stringify(data[args[1]]);
  };
  const pr = { number:3415,headRefOid:head,state:'OPEN',labels:[],statusCheckRollup:[{
    name:'test',status:'COMPLETED',conclusion:'FAILURE',detailsUrl:`https://github.com/${repo}/actions/runs/10/job/20`}] };
  const prs = enrichPrsWithTimeoutEvidence([pr], {repo,enabled:true,readBudget: () => ({ confirmed: 0, pending: false }),read:(p,o)=>readTimeoutEvidence(p,{...o,exec,ts:timeoutTs})});
  expect(timeoutPlanReconcile({prs,requiredChecks:['test']}).dispatch[0].kind).toBe('ci-timeout-rerun');
  expect(calls.filter((p)=>p===`${prefix}/pulls/3415`)).toHaveLength(2);
  data[`${prefix}/pulls/3415`].changed_files = 101;
  expect(readTimeoutEvidence(pr,{repo,exec,ts:timeoutTs})).toMatchObject({eligible:false,reason:'timeout-evidence:incomplete-diff'});
});

const XX_REQUIRED = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'];
const XX_HEAD = '4ecb5deb362c81aa28de162db4616bb4c2009347';
const xxRuns = () => XX_REQUIRED.map((name, i) => ({ id: 110460009383 + i, name, status: 'completed',
  conclusion: name === 'smoke' ? 'cancelled' : 'success', completed_at: '2026-10-01T10:00:00Z' }));
const xxPr = () => ({ number: 3336, headRefOid: XX_HEAD, headRefName: 'lane/3336-replay', isDraft: true,
  labels: [], comments: [], statusCheckRollup: Array.from({ length: 100 }, (_, i) => ({
    name: i ? 'review-gate' : 'soak-replay-gate', status: 'COMPLETED', conclusion: 'SUCCESS',
  })) });
const xxOptions = () => ({ repo: 'we', readPrs: () => [xxPr()], readAgents: () => [], enrich: a => a,
  readRequiredChecks: () => ({ checks: XX_REQUIRED }), enrichMainRed: prs => ({ prs, mainRedWindows: [] }),
  enrichAlreadyLanded: prs => prs, enrichBaseRef: prs => prs, enrichSystemFix: prs => prs,
  enrichFixClaims: prs => prs, resolveMainSha: () => null, enrichTimeouts: prs => prs });

it('xxh4zw8 hydrates the crowded snapshot before planning same-tick recovery', async () => {
  const { runReconcilePass } = await import('../reconcile-pass.mjs');
  const readChecks = vi.fn(() => xxRuns());
  const plan = runReconcilePass({ ...xxOptions(), readChecks });
  expect(plan.dispatch.map(d => d.kind)).toEqual(['ci-heal']);
  expect(readChecks).toHaveBeenCalledTimes(1);
  expect(readChecks).toHaveBeenCalledWith({ repo: 'web-everything/web-everything', sha: XX_HEAD });
});

it('hydrated REST check origins reach timeout enrichment', async () => {
  const { runReconcilePass } = await import('../reconcile-pass.mjs');
  const detailsUrl = 'https://github.com/web-everything/web-everything/actions/runs/10/job/20';
  const read = vi.fn(() => ({ eligible: false, reason: 'fixture-not-timeout' }));
  const plan = runReconcilePass({ ...xxOptions(),
    readChecks: () => xxRuns().map(row => ({ ...row,
      conclusion: row.name === 'smoke' ? 'failure' : 'success', details_url: detailsUrl })),
    enrichTimeouts: (prs, opts) => enrichPrsWithTimeoutEvidence(prs, { ...opts, enabled: true,
      read, readBudget: () => ({ confirmed: 0, pending: false }) }),
  });
  expect(read).toHaveBeenCalledOnce();
  expect(read.mock.calls[0][0].statusCheckRollup[1].detailsUrl).toBe(detailsUrl);
  expect(plan.refusals).toContainEqual(expect.objectContaining({ kind: 'timeout-retry-ineligible',
    why: 'PR #3336: fixture-not-timeout' }));
  expect([...plan.notes, ...plan.refusals].some(row =>
    (row.text ?? row.why ?? '').includes('missing-check-origin'))).toBe(false);
  expect(plan.dispatch.map(d => d.kind)).toEqual(['ci-heal']);
});

it('xxh4zw8 hydrates shared-file input and preserves attribution timestamps and numeric rerun IDs', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readPrsFromFile } = await import('../open-pr-fetch.mjs');
  const { runReconcilePass, defaultReadChecks, enrichPrsWithMainRedFacts } = await import('../reconcile-pass.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'xxh4zw8-'));
  try {
    const path = join(dir, 'prs.json');
    writeFileSync(path, JSON.stringify([xxPr()]));
    const exec = vi.fn(() => xxRuns().map(row => JSON.stringify(row)).join('\n'));
    const plan = runReconcilePass({ ...xxOptions(), readPrs: () => readPrsFromFile(path),
      readChecks: args => defaultReadChecks(args, { exec }),
      enrichMainRed: (prs, opts) => {
        expect(prs[0].statusCheckRollup[1]).toMatchObject({ id: 110460009384,
          name: 'smoke', conclusion: 'CANCELLED', completedAt: '2026-10-01T10:00:00Z' });
        const enriched = enrichPrsWithMainRedFacts(prs, { ...opts, readMainRuns: () => [],
          readMainLatestCheckRuns: () => [], readAheadBy: () => 0 });
        expect(enriched.prs[0].requiredCheckCompletedAt).toBe('2026-10-01T10:00:00Z');
        return enriched;
      } });
    expect(plan.dispatch.map(d => d.kind)).toEqual(['ci-heal']);
    expect(exec.mock.calls[0][1]).toContain('--paginate');
    expect(exec.mock.calls[0][1]).toContain(`repos/web-everything/web-everything/commits/${XX_HEAD}/check-runs`);
    expect(exec.mock.calls[0][1].at(-1)).toContain('completed_at');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each(['source', 'docs', 'configuration', 'data'])('xxh4zw8 hydrates omitted names below 100 rows for %s changes and deduplicates same-head reads', async category => {
  const { runReconcilePass } = await import('../reconcile-pass.mjs');
  const pr = { ...xxPr(), files: [{ path: `${category}/example` }], statusCheckRollup: [xxPr().statusCheckRollup[0]] };
  const readChecks = vi.fn(() => xxRuns());
  const plan = runReconcilePass({ ...xxOptions(), readPrs: () => [pr, { ...pr, number: 3337 }], readChecks });
  expect(readChecks).toHaveBeenCalledTimes(1);
  expect(plan.dispatch.map(d => [d.prNumber, d.kind])).toEqual([[3336, 'ci-heal'], [3337, 'ci-heal']]);
});

it('xxh4zw8 the 100-row boundary hydrates even with all names present and targets each distinct head', async () => {
  const { runReconcilePass } = await import('../reconcile-pass.mjs');
  const pr = { ...xxPr(), statusCheckRollup: [...xxRuns(), ...xxPr().statusCheckRollup.slice(4)] };
  const readChecks = vi.fn(() => xxRuns());
  runReconcilePass({ ...xxOptions(), repo: 'frontierui', readChecks,
    readPrs: () => [pr, { ...pr, number: 3337, headRefOid: 'b'.repeat(40) }] });
  expect(readChecks.mock.calls).toEqual([
    [{ repo: 'frontier-ui/frontierui', sha: XX_HEAD }], [{ repo: 'frontier-ui/frontierui', sha: 'b'.repeat(40) }],
  ]);
});

it.each([
  ['transport', () => { throw new Error('HTTP 502'); }],
  ['malformed', () => ({ check_runs: [] })],
  ['bad ID', () => xxRuns().map(row => ({ ...row, id: '123' }))],
  ['unreadable', () => xxRuns().map(row => ({ ...row, conclusion: row.name === 'test' ? null : row.conclusion }))],
])('xxh4zw8 %s hydration refuses visibly, never heals unknown evidence, and allows unrelated progress', async (_, readChecks) => {
  const { runReconcilePass, formatReport } = await import('../reconcile-pass.mjs');
  const good = { ...xxPr(), number: 3337, statusCheckRollup: xxRuns().map(row => ({ ...row, conclusion: 'SUCCESS', status: 'COMPLETED' })) };
  const plan = runReconcilePass({ ...xxOptions(), readChecks, readPrs: () => [xxPr(), good] });
  expect(plan.dispatch.map(d => [d.prNumber, d.kind])).toEqual([[3337, 'promote-draft']]);
  expect(plan.refusals.filter(r => r.kind === 'check-read-failed'))
    .toEqual([expect.objectContaining({ prNumber: 3336, why: expect.any(String) })]);
  expect(formatReport(plan)).toContain('required-check hydration refused');
  expect(plan.prs).toBe(2);
});

// Live incident: plateauapp/plateau-app #217 (and web-everything #4402/#4439) logged `check-read-failed: required-check
// hydration refused` when the REST feed read fine but the required checks had simply never started. That is not a
// read failure: the PR is owed a CI trigger (missing-run recovery performs it).
it.each([
  ['an empty feed', () => []],
  ['only unrelated checks', () => [{ id: 9, name: 'admit', status: 'completed', conclusion: 'success', completed_at: '2026-10-08T10:05:31Z' }]],
])('never-started required checks (%s) are owed a re-trigger, not a check-read-failed refusal', async (_, readChecks) => {
  const { runReconcilePass, formatReport } = await import('../reconcile-pass.mjs');
  const plan = runReconcilePass({ ...xxOptions(), readChecks, readPrs: () => [xxPr()] });
  expect(plan.refusals.filter(r => r.kind === 'check-read-failed')).toEqual([]);
  expect(plan.owedTriggers).toEqual([expect.objectContaining({ kind: 'ci-trigger-owed', prNumber: 3336 })]);
  expect(formatReport(plan)).toContain('ci-trigger-owed PR #3336');
  expect(formatReport(plan)).not.toContain('required-check hydration refused');
});

it('xxh4zw8 an authoritative cancelled check with absent required jobs still heals', async () => {
  const { runReconcilePass } = await import('../reconcile-pass.mjs');
  const readChecks = () => xxRuns().filter(row => row.name === 'smoke');
  const plan = runReconcilePass({ ...xxOptions(), readChecks });
  expect(plan.dispatch.map(d => [d.prNumber, d.kind])).toEqual([[3336, 'ci-heal']]);
  expect(plan.refusals).toEqual([]);
});

it.each([
  ['absent evidence', () => xxRuns().filter(row => row.name === 'soak-replay-gate'), false],
  ['unreadable read', () => { throw new Error('HTTP 502'); }, true],
])('xxh4zw8 %s withholds CI evidence but keeps the PR in non-CI planning', async (_, readChecks, isReadFailure) => {
  const { runReconcilePass } = await import('../reconcile-pass.mjs');
  const pr = { ...xxPr(), isDraft: false, labels: [{ name: 'review:changes' }],
    comments: [{ body: '🔁 review — changes requested\nPlease fix', author: { login: 'web-everything' }, createdAt: '2026-10-01T09:00:00Z' }] };
  const plan = runReconcilePass({ ...xxOptions(), readChecks, readPrs: () => [pr] });
  expect(plan.dispatch.map(d => [d.prNumber, d.kind])).toEqual([[3336, 'fix']]);
  // Absent evidence = the checks never started: owed a trigger, NOT a failed read. A real read error still refuses.
  expect(plan.refusals.filter(r => r.kind === 'check-read-failed'))
    .toEqual(isReadFailure ? [expect.objectContaining({ prNumber: 3336 })] : []);
  expect(plan.owedTriggers.map(t => t.prNumber)).toEqual(isReadFailure ? [] : [3336]);
});

// Known failing/pending evidence already in the snapshot must survive a refused hydration: a cancelled required
// check seen in the truncated snapshot still schedules recovery on this tick, while the refusal stays visible.
it.each([
  ['unreadable read', () => { throw new Error('HTTP 502'); }, true],
  ['absent evidence', () => xxRuns().filter(row => row.name === 'soak-replay-gate'), false],
])('xxh4zw8 %s keeps the known cancelled snapshot so recovery is still scheduled', async (_, readChecks, isReadFailure) => {
  const { runReconcilePass } = await import('../reconcile-pass.mjs');
  const pr = { ...xxPr(), statusCheckRollup: [{ name: 'smoke', status: 'COMPLETED', conclusion: 'CANCELLED',
    completedAt: '2026-10-01T10:00:00Z' }] };
  const plan = runReconcilePass({ ...xxOptions(), readChecks, readPrs: () => [pr] });
  expect(plan.dispatch.map(d => [d.prNumber, d.kind])).toEqual([[3336, 'ci-heal']]);
  expect(plan.refusals.filter(r => r.kind === 'check-read-failed'))
    .toEqual(isReadFailure ? [expect.objectContaining({ prNumber: 3336 })] : []);
});

it('xxh4zw8 a refused hydration keeps known pending evidence but never promotes on a truncated green snapshot', async () => {
  const { runReconcilePass } = await import('../reconcile-pass.mjs');
  const green = XX_REQUIRED.map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' }));
  const fail = () => { throw new Error('HTTP 502'); };
  const truncated = { ...xxPr(), statusCheckRollup: [...green, ...xxPr().statusCheckRollup.slice(4)] };
  expect(runReconcilePass({ ...xxOptions(), readChecks: fail, readPrs: () => [truncated] }).dispatch).toEqual([]);
  const pending = { ...xxPr(), statusCheckRollup: [{ name: 'smoke', status: 'IN_PROGRESS', conclusion: null }] };
  const plan = runReconcilePass({ ...xxOptions(), readChecks: fail, readPrs: () => [pending] });
  expect(plan.dispatch).toEqual([]);
  expect(plan.refusals.filter(r => r.kind === 'check-read-failed')).toHaveLength(1);
});

it('xxh4zw8 hydration collapses superseded cancellations and unreadable conclusions before classification', async () => {
  const { runReconcilePass } = await import('../reconcile-pass.mjs');
  const rows = [...xxRuns(), { ...xxRuns()[1], id: 110460009999, conclusion: 'success' },
    { ...xxRuns()[0], id: 1, conclusion: null }];
  for (const ordered of [rows, [...rows].reverse()]) {
    expect(runReconcilePass({ ...xxOptions(), readChecks: () => ordered }).dispatch.map(d => d.kind)).toEqual(['promote-draft']);
  }
});

it('xxh4zw8 malformed JSON-lines read is refused and failed identical-head reads are deduplicated', async () => {
  const { runReconcilePass, defaultReadChecks } = await import('../reconcile-pass.mjs');
  const exec = vi.fn(() => '{not-json');
  const plan = runReconcilePass({ ...xxOptions(), readPrs: () => [xxPr(), { ...xxPr(), number: 3337 }],
    readChecks: args => defaultReadChecks(args, { exec }) });
  expect(exec).toHaveBeenCalledTimes(1);
  expect(plan.dispatch).toEqual([]);
  expect(plan.refusals.filter(r => r.kind === 'check-read-failed')).toHaveLength(2);
});

it('xe8y12n real PR read shell enriches the reported missing-family shape from commit evidence', async () => {
  const { defaultReadPrs } = await import('../reconcile-pass.mjs');
  const { planReconcile } = await import('../reconcile-core.mjs');
  const calls = [];
  const prs = defaultReadPrs({ repo: 'o/r', exec: (_bin, args) => {
    calls.push(args);
    return JSON.stringify(args[1] === 'list' ? [{ number: 3239, labels: [], comments: [], statusCheckRollup: [] }]
      : { data: { repository: { pullRequest: { commits: { nodes: [{ commit: { messageHeadline: 'repair', authors: { nodes: [{ name: 'Claude' }] } } }] } } } } });
  } });
  expect(calls.some(args => args.some(arg => arg.includes('commits(first:')))).toBe(true);
  expect(planReconcile({ prs }).notes).toContainEqual(expect.objectContaining({ kind: 'review-label-missing' }));
});

// ── Live deadlock shape, PR #3771 (2026-10-03): a CONFLICTING head never gets pull_request CI ────────────────────
// GitHub runs no CI on a conflicting head, so its required checks can never appear. Hydration used to read the REST
// feed every tick and refuse `check-read-failed: missing required checks`, for a PR whose owed work (a mechanical
// re-sync with main) does not consume CI at all. Absence there is EXPECTED: no read, no refusal, the conflict-fix
// still planned. Every other path (a non-conflicting PR, a real read error, observed evidence) still refuses/reads.
describe('conflicting head: missing required checks are expected (#3771)', () => {
  const real = async () => (await import('node:fs')).readFileSync(
    (await import('node:path')).join(process.cwd(), 'scripts/conveyor/__tests__/fixtures/pr-3771-conflicting-no-ci.json'), 'utf8');
  const livePr = async (patch = {}) => ({ ...JSON.parse(await real()), ...patch });
  const opts = (pr, readChecks) => ({ ...xxOptions(), readPrs: () => [pr], readChecks,
    enrichFixClaims: p => p, enrichTimeouts: p => p, enrichReferralHolds: p => p });
  const dispatchOf = (plan) => plan.dispatch.map(d => [d.prNumber, d.kind, d.isConflict ?? null]);

  it('real #3771 data: the conflict repair is planned, nothing is read, nothing is refused', async () => {
    const { runReconcilePass } = await import('../reconcile-pass.mjs');
    const readChecks = vi.fn(() => []);
    const plan = runReconcilePass(opts(await livePr(), readChecks));
    expect(dispatchOf(plan)).toEqual([[3771, 'fix', true]]);
    expect(plan.refusals.filter(r => r.kind === 'check-read-failed')).toEqual([]);
    expect(readChecks).not.toHaveBeenCalled();
  });

  it.each([
    ['the conflict label alone', { mergeStateStatus: 'CLEAN' }],
    ['mergeStateStatus DIRTY alone', { labels: [{ name: 'review:changes' }] }],
    ['mergeable CONFLICTING alone', { mergeStateStatus: 'CLEAN', mergeable: 'CONFLICTING', labels: [{ name: 'review:changes' }] }],
  ])('%s is enough to expect missing checks', async (_, patch) => {
    const { runReconcilePass } = await import('../reconcile-pass.mjs');
    const readChecks = vi.fn(() => []);
    const plan = runReconcilePass(opts(await livePr(patch), readChecks));
    expect(plan.refusals.filter(r => r.kind === 'check-read-failed')).toEqual([]);
    expect(readChecks).not.toHaveBeenCalled();
  });

  it('a PR that is NOT conflicting and never started its required checks is owed a re-trigger (no read failure)', async () => {
    const { runReconcilePass } = await import('../reconcile-pass.mjs');
    const readChecks = vi.fn(() => []);
    const clean = await livePr({ mergeStateStatus: 'CLEAN',
      labels: [{ name: 'review:changes' }, { name: 'review:human' }] });
    const plan = runReconcilePass(opts(clean, readChecks));
    expect(readChecks).toHaveBeenCalledTimes(1);
    expect(plan.refusals.filter(r => r.kind === 'check-read-failed')).toEqual([]);
    expect(plan.owedTriggers).toEqual([expect.objectContaining({ prNumber: 3771, why: expect.stringContaining('missing required checks') })]);
  });

  it('a conflicting PR with OBSERVED check evidence still reads, and a real read error still refuses', async () => {
    const { runReconcilePass } = await import('../reconcile-pass.mjs');
    const observed = await livePr({ statusCheckRollup: [{ name: 'smoke', status: 'COMPLETED', conclusion: 'CANCELLED' }] });
    const fail = vi.fn(() => { throw new Error('HTTP 502'); });
    const plan = runReconcilePass(opts(observed, fail));
    expect(fail).toHaveBeenCalledTimes(1);
    expect(plan.refusals.filter(r => r.kind === 'check-read-failed')).toHaveLength(1);
    // ...but an incomplete-yet-readable feed on a conflicting head is not a refusal.
    const readable = vi.fn(() => xxRuns().filter(row => row.name === 'soak-replay-gate'));
    const ok = runReconcilePass(opts(observed, readable));
    expect(readable).toHaveBeenCalledTimes(1);
    expect(ok.refusals.filter(r => r.kind === 'check-read-failed')).toEqual([]);
  });

  // Rules as they stand (confirmed, unchanged): `review:human` is NOT a hold on a mechanical re-sync with main, so it
  // never blocks the conflict repair. A recorded stand-down IS terminal until the operator answers it (a fix agent
  // asked a question), and #3771 carries that answer, so the repair is planned. Without the answer it stays refused.
  it('review:human does not block the re-sync; an UNANSWERED stand-down still does', async () => {
    const { runReconcilePass } = await import('../reconcile-pass.mjs');
    const pr = await livePr();
    const withoutHuman = { ...pr, labels: pr.labels.filter(l => l.name !== 'review:human') };
    expect(dispatchOf(runReconcilePass(opts(withoutHuman, () => []))))
      .toEqual(dispatchOf(runReconcilePass(opts(pr, () => []))));
    const unanswered = { ...pr, comments: pr.comments.filter(c => !c.body.includes('conveyor-stand-down-answer')
      && !c.body.startsWith('\u21A9\uFE0F') && !c.body.includes('Recorded by parked-pr-conflict-watch')) };
    const plan = runReconcilePass(opts(unanswered, () => []));
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals.map(r => r.kind)).toContain('stood-down');
    expect(plan.refusals.filter(r => r.kind === 'check-read-failed')).toEqual([]);
  });
});

// LIVE INCIDENT 2026-10-04, PR #3826: card-only PR, an UNTOUCHED test hit the 5000 ms default, 3/3 heals burned.
describe('timeout re-run eligibility — card-only diff + derived red checks (PR #3826)', () => {
  const sources = { 'a.test.mjs': 'import "./b.mjs"; process.env.X;', 'b.mjs': 'export const b = 1;', 'vite.config.mts': 'export default {};' };
  const base = { head: 'h', sourceHead: 'h', sources, roots: ['vite.config.mts', 'a.test.mjs'] };
  it('RED before the fix: a backlog-card-only diff was "changed-input-impact-unknown"; now it is eligible', () => {
    expect(timeoutImpact({ ...base, changed: [{ filename: 'backlog/4999-card.md' }] }, timeoutTs)).toBeNull();
  });
  it('a card plus any non-card (or source) change keeps refusing', () => {
    expect(timeoutImpact({ ...base, changed: [{ filename: 'backlog/x.md' }, { filename: 'README.md' }] }, timeoutTs)).toBe('changed-input-impact-unknown');
    expect(timeoutImpact({ ...base, sources: { ...sources, 'a.test.mjs': 'import "./b.mjs";' }, changed: [{ filename: 'b.mjs' }] }, timeoutTs)).toBe('changed-dependency:b.mjs');
  });
  it('card-only still refuses an unresolvable relative import of the failing test', () => {
    expect(timeoutImpact({ ...base, sources: { 'a.test.mjs': 'import "./gone.mjs";' }, changed: [{ filename: 'backlog/x.md' }] }, timeoutTs)).toMatch(/^unresolved-dependency:/);
  });
  it('review-gate and the shard-derived aggregate `test` are not primary failure evidence', () => {
    const checks = [{ name: 'review-gate', conclusion: 'failure' }, { name: 'test-shard (2)', conclusion: 'failure' }, { name: 'test', conclusion: 'failure' }];
    expect(checks.filter((c) => !isDerivedTimeoutCheck(c, checks)).map((c) => c.name)).toEqual(['test-shard (2)']);
    expect(isDerivedTimeoutCheck({ name: 'test', conclusion: 'failure' }, [{ name: 'test-shard (1)', conclusion: 'success' }])).toBe(false);
    // PR #4141: the daemon-soak aggregator is derived once a soak shard failed; alone it is real evidence.
    const soak = [{ name: 'soak-shard (3)', conclusion: 'failure' }, { name: 'daemon-soak', conclusion: 'failure' }];
    expect(soak.filter((c) => !isDerivedTimeoutCheck(c, soak)).map((c) => c.name)).toEqual(['soak-shard (3)']);
    expect(isDerivedTimeoutCheck({ name: 'daemon-soak', conclusion: 'failure' }, [{ name: 'soak-shard (1)', conclusion: 'success' }])).toBe(false);
    // integration is a sibling aggregate input: a red integration job is the evidence, `test` only mirrors it.
    expect(isDerivedTimeoutCheck({ name: 'test', conclusion: 'failure' }, [{ name: 'integration', conclusion: 'failure' }])).toBe(true);
    expect(isDerivedTimeoutCheck({ name: 'test', conclusion: 'failure' }, [{ name: 'integration', conclusion: 'success' }])).toBe(false);
  });
  it('the re-run is on by default and WE_CI_TIMEOUT_RERUN_ENABLED=0 is only a kill switch', () => {
    const pr = { number: 1, headRefOid: 'h', statusCheckRollup: [{ name: 'test-shard (2)', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/1/job/2' }] };
    const read = () => ({ eligible: true });
    expect(enrichPrsWithTimeoutEvidence([pr], { repo: 'o/r', read, readBudget: () => ({ confirmed: 0 }) })[0].timeoutRetry).toEqual({ eligible: true });
    expect(enrichPrsWithTimeoutEvidence([pr], { repo: 'o/r', read, enabled: false })[0]).toBe(pr);
  });
});

describe('stacked PR required-check absence (#3915)', () => {
  const stacked = () => ({ ...xxPr(), number: 3915, baseRefName: 'lane/base', statusCheckRollup: [] });
  const base = () => ({ ...xxPr(), number: 3889, headRefName: 'lane/base', baseRefName: 'main',
    statusCheckRollup: XX_REQUIRED.map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })) });
  const run = async (prs, extra = {}) => {
    const { runReconcilePass } = await import('../reconcile-pass.mjs');
    const readChecks = vi.fn(() => []);
    const plan = runReconcilePass({ ...xxOptions(), readPrs: () => prs, readChecks,
      enrichTimeouts: p => p, enrichReferralHolds: p => p, ...extra });
    return { plan, readChecks };
  };
  it('waits on the open base PR without reading or promoting', async () => {
    const { plan, readChecks } = await run([stacked(), base()]);
    expect(readChecks).not.toHaveBeenCalled();
    expect(plan.refusals.filter(r => r.kind === 'check-read-failed')).toEqual([]);
    expect(plan.notes).toContainEqual(expect.objectContaining({ kind: 'stacked-awaiting-base', prNumber: 3915,
      baseRefName: 'lane/base', basePrNumber: 3889, why: expect.stringContaining('PR #3889') }));
    expect(plan.dispatch.filter(r => r.prNumber === 3915)).toEqual([]);
    const { formatReport } = await import('../reconcile-pass.mjs');
    expect(formatReport(plan)).toContain('stacked on lane/base (PR #3889)');
  });
  it('surfaces an orphaned base', async () => {
    const { plan, readChecks } = await run([stacked()]);
    expect(readChecks).not.toHaveBeenCalled();
    expect(plan.notes).toContainEqual(expect.objectContaining({ kind: 'stacked-base-orphaned', basePrNumber: null }));
  });
  it.each(['main', 'strict', 'partial', 'truncated'])('keeps hydration for %s', async shape => {
    const pr = stacked();
    if (shape === 'main') pr.baseRefName = 'main';
    if (shape === 'partial') pr.statusCheckRollup = [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }];
    if (shape === 'truncated') pr.statusCheckRollup = Array.from({ length: 100 }, () => ({ name: 'other' }));
    if (shape === 'strict') vi.stubEnv('WE_STACKED_PR_CHECK_POLICY', 'strict');
    try {
      const { plan, readChecks } = await run([pr]);
      expect(readChecks).toHaveBeenCalledOnce();
      expect(plan.refusals.filter(r => r.kind === 'check-read-failed')).toEqual([]);
      expect(plan.owedTriggers).toHaveLength(1);
    } finally { vi.unstubAllEnvs(); }
  });
  it('classifies against the configured default and reads the policy', async () => {
    const { isStackedPr, readStackedPrCheckPolicy } = await import('../reconcile-pass.mjs');
    expect(isStackedPr({ baseRefName: 'release' }, 'release')).toBe(false);
    expect(isStackedPr({}, 'main')).toBe(false);
    expect(isStackedPr({ baseRefName: 'main' }, 'release')).toBe(true);
    expect(readStackedPrCheckPolicy({})).toBe('await-base');
    expect(readStackedPrCheckPolicy({ WE_STACKED_PR_CHECK_POLICY: 'strict' })).toBe('strict');
  });
});

// #3794 live case, 2026-10-04.
describe('main-fixed signature facts reader', () => {
  const args = { repo: 'web-everything/web-everything', root: '/checkout',
    detailsUrl: 'https://github.com/web-everything/web-everything/actions/runs/1/job/42',
    failureCompletedAt: '2026-10-05T00:54:36Z' };
  it('reads job logs, literal emitters and first-parent history with earliest fix time', async () => {
    const { defaultReadMainFixedSignatureFacts } = await import('../reconcile-pass.mjs');
    const exec = vi.fn((file, argv) => {
      if (file === 'gh') return '2026-10-05T00:54:36.1177647Z \u001b[31m error\u001b[0m fixture.json: cites a card by its hash-named FILE PATH (`backlog/card.md`)\n2026-10-05T00:54:36Z ##[error]Process completed with exit code 1.';
      if (argv.includes('grep')) return 'origin/main:scripts/check-standards.mjs\n';
      if (argv.includes('--format=%H%x09%cI')) return 'aaaaaaa\t2026-10-05T02:00:00Z\ne5c22481e\t2026-10-05T01:44:46Z\n';
      if (argv.includes('--format=%cI')) return '2026-10-04T23:00:00Z\n';
      throw new Error('unexpected command');
    });
    expect(defaultReadMainFixedSignatureFacts({ ...args, exec })).toMatchObject({
      signatures: [{ fragments: ['cites a card by its hash-named FILE PATH'],
        emitterFiles: ['scripts/check-standards.mjs'], fixCommits: ['aaaaaaa', 'e5c22481e'] }],
      fixCommits: ['aaaaaaa', 'e5c22481e'], bugIntroducedAt: '2026-10-04T23:00:00Z', fixedAt: '2026-10-05T01:44:46Z',
    });
    expect(exec).toHaveBeenCalledWith('gh', ['api', 'repos/web-everything/web-everything/actions/jobs/42/logs'],
      expect.objectContaining({ maxBuffer: 64 * 1024 * 1024, timeout: expect.any(Number) }));
    expect(exec).toHaveBeenCalledWith('git', ['-C', '/checkout', 'grep', '-l', '-F', '-e',
      'cites a card by its hash-named FILE PATH', 'origin/main', '--', '.',
      ':(exclude)**/__tests__/**', ':(exclude)**/fixtures/**', ':(exclude)backlog/**'], expect.any(Object));
    expect(exec).toHaveBeenCalledWith('git', expect.arrayContaining(['--first-parent', '--since=2026-10-05T00:54:36Z',
      '--end-of-options', 'origin/main', '--', 'scripts/check-standards.mjs']), expect.any(Object));
  });
  it('handles empty logs, no grep matches, command failures and invalid inputs conservatively', async () => {
    const { defaultReadMainFixedSignatureFacts: read } = await import('../reconcile-pass.mjs');
    expect(read({ ...args, exec: () => '' })).toEqual({ signatures: [] });
    expect(read({ ...args, exec: () => { throw new Error('offline'); } })).toBeNull();
    const exec = vi.fn();
    expect(read({ ...args, defaultBranch: '--bad', exec })).toBeNull();
    expect(read({ ...args, detailsUrl: 'no-job', exec })).toBeNull();
    expect(exec).not.toHaveBeenCalled();
    expect(read({ ...args, exec: (file) => {
      if (file === 'gh') return 'error file.mjs: a long unexplained error message';
      throw Object.assign(new Error('no matches'), { status: 1 });
    } })).toMatchObject({ signatures: [{ emitterFiles: [], fixCommits: [] }], fixedAt: null });
  });
  it('enriches only a failing, behind PR not already owed via either older path', async () => {
    const { enrichPrsWithMainRedFacts } = await import('../reconcile-pass.mjs');
    const pr = { number: 3794, headRefOid: 'abc1234', statusCheckRollup: [{ name: 'test', status: 'COMPLETED',
      conclusion: 'FAILURE', completedAt: args.failureCompletedAt, detailsUrl: args.detailsUrl }] };
    const facts = { signatures: [{ emitterFiles: ['gate.mjs'], fixCommits: ['e5c22481e'] }] };
    const readMainFixedSignatureFacts = vi.fn(() => facts);
    const options = { repo: args.repo, readAheadBy: () => 3, readMainRuns: () => [],
      readMainLatestCheckRuns: () => [], readMainFixedSignatureFacts };
    expect(enrichPrsWithMainRedFacts([pr], options).prs[0].mainFixedSignature).toBe(facts);
    expect(readMainFixedSignatureFacts).toHaveBeenCalledWith({ repo: args.repo, detailsUrl: args.detailsUrl,
      failureCompletedAt: args.failureCompletedAt, defaultBranch: 'main' });
    readMainFixedSignatureFacts.mockClear();
    enrichPrsWithMainRedFacts([pr], { ...options, readAheadBy: () => 0 });
    enrichPrsWithMainRedFacts([pr], { ...options, readAheadBy: () => null });
    enrichPrsWithMainRedFacts([pr], { ...options, readMainRuns: () => [{ status: 'completed', conclusion: 'failure',
      updatedAt: '2026-10-05T00:00:00Z', workflowName: 'CI' }] });
    enrichPrsWithMainRedFacts([pr], { ...options, readMainLatestCheckRuns: () => [{ name: 'test', status: 'completed',
      conclusion: 'success', head_sha: 'e5c22481e' }], readMainGreenFixFacts: () => ({ prContainsMainGreenSha: false,
      mergeBaseCheckRuns: [{ name: 'test', status: 'completed', conclusion: 'failure' }] }) });
    expect(readMainFixedSignatureFacts).not.toHaveBeenCalled();
  });
});

it('threads the injected round-cap environment into the fixer decision', async () => {
  const { runReconcilePass } = await import('../reconcile-pass.mjs');
  const { REARM_COMMENT_MARKER } = await import('../rearm-review.mjs');
  const options = {
    repo: 'we', readRequiredChecks: () => ({ checks: ['test'], source: 'live' }),
    readPrs: () => [{
      number: 12, state: 'OPEN', headRefName: 'lane/round-cap', headRefOid: 'a'.repeat(40),
      labels: [{ name: 'review:changes' }], mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      comments: [{ body: '🔁 human review — changes requested\n\nFix the bug.' },
        ...Array.from({ length: 5 }, () => ({ body: REARM_COMMENT_MARKER, author: { login: 'web-everything' } }))],
    }],
    readAgents: () => [], enrich: (agents) => agents,
  };
  expect(runReconcilePass({ ...options, env: {} }).refusals).toContainEqual(expect.objectContaining({ kind: 'cap-exhausted' }));
  expect(runReconcilePass({ ...options, env: { WE_REVIEW_ROUND_CAP: '7' } }).dispatch)
    .toContainEqual(expect.objectContaining({ kind: 'fix' }));
});

describe('item 69 resolveCheckOrigin', () => {
  const repo = 'web-everything/web-everything';
  const base = `https://github.com/${repo}/actions/runs/10`;
  const mk = (name, details_url, slug = 'github-actions') => ({ name, details_url, app: { slug } });
  const get = async (c, api = () => { throw new Error('no api'); }) => {
    const { resolveCheckOrigin } = await import('../reconcile-pass.mjs');
    return resolveCheckOrigin(c, { repo, api });
  };
  it('accepts query strings and attempts', async () => {
    expect((await get(mk('t', `${base}/job/20?pr=1`)))[3]).toBe('20');
    expect((await get(mk('t', `${base}/attempts/2/job/20`)))[3]).toBe('20');
  });
  it('resolves a run-level URL through the jobs list by check name', async () => {
    const api = vi.fn(() => ({ jobs: [{ id: 7, name: 'smoke' }, { id: 8, name: 'other' }] }));
    expect((await get(mk('smoke', base), api))[3]).toBe('7');
    expect(api.mock.calls[0][0]).toContain('/runs/10/jobs');
  });
  it('refuses an ambiguous run-level match naming the check', async () => {
    await expect(get(mk('smoke', base), () => ({ jobs: [] }))).rejects.toThrow('ambiguous-check-job:smoke:0');
  });
  it('refuses a non-Actions app with a stable named reason', async () => {
    await expect(get(mk('Cloudflare Pages', 'https://dash.cloudflare.com/x', 'cloudflare-workers-and-pages')))
      .rejects.toThrow('non-actions-check:cloudflare-workers-and-pages:Cloudflare Pages');
  });
  it('names the check for a null URL', async () => {
    await expect(get(mk('mystery', null))).rejects.toThrow('unknown-check-origin:mystery:github-actions:null');
  });
});
