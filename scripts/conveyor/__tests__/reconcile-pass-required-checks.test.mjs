import { vi, it, expect } from 'vitest';


vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal(), execFileSync: vi.fn(),
}));
vi.mock('../../lib/gh-throttle.mjs', async (importOriginal) => {
  const { execFileSync } = await import('node:child_process');
  return {
    // Keep real exports, including the shared denial classifier used by required-status-checks.mjs (#4708).
    ...await importOriginal(),
    execFileSyncThrottled: vi.fn((file, args, opts) => execFileSync(file, args, opts)),
    runGhSync: vi.fn((args, opts) => execFileSync('gh', args, opts)),
  };
});
vi.mock('../../lib/write-all-sync.mjs', () => ({ writeAllSync: vi.fn(), writeLineSync: vi.fn() }));

const XX_REQUIRED = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'];
const XX_HEAD = '4ecb5deb362c81aa28de162db4616bb4c2009347';
const xxPr = () => ({ number: 3336, headRefOid: XX_HEAD, headRefName: 'lane/3336-replay', isDraft: true,
  labels: [], comments: [], statusCheckRollup: Array.from({ length: 100 }, (_, i) => ({
    name: i ? 'review-gate' : 'soak-replay-gate', status: 'COMPLETED', conclusion: 'SUCCESS',
  })) });
const xxOptions = () => ({ repo: 'we', readPrs: () => [xxPr()], readAgents: () => [], enrich: a => a,
  readRequiredChecks: () => ({ checks: XX_REQUIRED }), enrichMainRed: prs => ({ prs, mainRedWindows: [] }),
  enrichAlreadyLanded: prs => prs, enrichBaseRef: prs => prs, enrichSystemFix: prs => prs,
  enrichFixClaims: prs => prs, resolveMainSha: () => null });

it.each([{}, { rowsComplete: null, rowsHead: null }].flatMap(provenance =>
  ['complete', 'unreadable', 'duplicate', 'short'].map(shape => ({ provenance, shape }))))(
  'hydrates short legacy rollups before review admission: %j', async ({ provenance, shape }) => {
  const { runReconcilePass, defaultReadChecks } = await import('../reconcile-pass.mjs');
  const row = { id: 1, name: 'test', status: 'completed', conclusion: 'success', head_sha: XX_HEAD };
  const pr = { ...xxPr(), ...provenance, isDraft: false, labels: ['review:pending'], statusCheckRollup: [row] };
  const exec = vi.fn((_file, args) => {
    if (args.some(arg => arg.includes('/check-runs'))) return JSON.stringify([{ total_count: 1, check_runs: [row] }]);
    if (shape === 'unreadable') throw new Error('status feed unavailable');
    const status = { id: 1, context: 'legacy', state: 'success' };
    return JSON.stringify(shape === 'complete' ? [{ total_count: 0, statuses: [] }]
      : [{ total_count: 2, statuses: shape === 'duplicate' ? [status, { ...status }] : [status] }]);
  });
  let observed;
  const plan = runReconcilePass({ ...xxOptions(), readPrs: () => [pr],
    readRequiredChecks: () => ({ checks: ['test'], source: 'live' }),
    readChecks: args => defaultReadChecks(args, { exec }),
    enrichMainRed: prs => { observed = prs[0]; return { prs, mainRedWindows: [] }; },
    env: { VITEST: 'true', WE_REVIEW_START_AFTER: 'ci-green' } });
  expect(exec).toHaveBeenCalledTimes(2);
  expect(observed).toMatchObject({ rowsComplete: shape === 'complete', rowsHead: shape === 'complete' ? XX_HEAD : null });
  expect(plan.dispatch.filter(d => d.kind === 'review')).toHaveLength(shape === 'complete' ? 1 : 0);
});

it.each([100, 101])('preserves complete current-head %s-row snapshots without rereading', async count => {
  const { runReconcilePass } = await import('../reconcile-pass.mjs');
  const pr = { ...xxPr(), isDraft: false, labels: ['review:pending'], rowsComplete: true, rowsHead: XX_HEAD,
    statusCheckRollup: Array.from({ length: count }, (_, i) => ({
      name: i ? `optional-${i}` : 'test', status: 'COMPLETED', conclusion: 'SUCCESS', head_sha: XX_HEAD,
    })) };
  const readChecks = vi.fn(() => { throw new Error('complete snapshot needs no reread'); });
  const plan = runReconcilePass({ ...xxOptions(), readPrs: () => [pr], readChecks,
    readRequiredChecks: () => ({ checks: ['test'], source: 'live' }),
    env: { VITEST: 'true', WE_REVIEW_START_AFTER: 'ci-green' } });
  expect(plan.dispatch.filter(d => d.kind === 'review')).toHaveLength(1);
  expect(readChecks).not.toHaveBeenCalled();
});

it.each(['complete', 'short-incomplete', 'status-failure', 'status-error', 'status-pending', 'status-unreadable', 'check-unreadable'])('restores truncated evidence only after both REST feeds complete: %s', async shape => {
  const { runReconcilePass, defaultReadChecks } = await import('../reconcile-pass.mjs');
  const runs = Array.from({ length: 101 }, (_, i) => ({ id: i + 1, name: i ? `optional-${i}` : 'test',
    status: 'completed', conclusion: 'success', head_sha: XX_HEAD }));
  const exec = vi.fn((_file, args) => {
    const checks = args.some(arg => arg.includes('/check-runs'));
    if (shape === (checks ? 'check-unreadable' : 'status-unreadable')) throw new Error('unreadable feed');
    return JSON.stringify(checks
      // Complete pages carry the server's total_count (same on every page): rows are attested only when delivered === total.
      ? [{ total_count: runs.length, check_runs: runs.slice(0, 100) }, { total_count: runs.length, check_runs: runs.slice(100) }]
      : [{ total_count: 1, statuses: [{ id: 1, context: 'legacy', state: ['status-failure', 'status-error', 'status-pending'].includes(shape) ? shape.slice(7) : 'success' }] }]);
  });
  let observed;
  const plan = runReconcilePass({ ...xxOptions(),
    readPrs: () => [{ ...xxPr(), isDraft: false, labels: ['review:pending'], rowsComplete: false, rowsHead: null,
      ...(shape === 'short-incomplete' ? { statusCheckRollup: [runs[0], { name: 'legacy', status: 'COMPLETED', conclusion: 'SUCCESS' }] } : {}) }],
    readRequiredChecks: () => ({ checks: ['test', 'legacy'], source: 'live' }),
    readChecks: args => defaultReadChecks(args, { exec }),
    enrichMainRed: prs => { observed = prs[0]; return { prs, mainRedWindows: [] }; },
    env: { VITEST: 'true', WE_REVIEW_START_AFTER: 'ci-green' } });
  expect(plan.dispatch.filter(d => d.kind === 'review')).toHaveLength(['complete', 'short-incomplete'].includes(shape) ? 1 : 0);
  expect(observed.rowsComplete).toBe(!shape.endsWith('unreadable'));
  expect(observed.rowsHead).toBe(shape.endsWith('unreadable') ? null : XX_HEAD);
  if (shape === 'complete') {
    expect(observed.statusCheckRollup).toHaveLength(102);
    expect(observed.statusCheckRollup.find(row => row.name === 'legacy')).toMatchObject({
      __typename: 'StatusContext', context: 'legacy', state: 'success', status: 'COMPLETED', conclusion: 'SUCCESS',
    });
    expect(exec.mock.calls).toHaveLength(2);
    expect(exec.mock.calls.every(([, args]) => args.includes('--paginate') && args.includes('--slurp'))).toBe(true);
  }
});

it.each([false, true])('Plateau #198 green checks promote with repo-local 403 fallback (hydrate: %s)', async hydrate => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { getRequiredStatusChecks } = await import('../../lib/required-status-checks.mjs');
  const { runReconcilePass } = await import('../reconcile-pass.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'plateau-required-checks-'));
  try {
    // Reported #198 check list, 2026-10-02. IDs are fixture IDs; deployment skips are intentional.
    const rows = ['test', 'admit', 'e2e', 'build', 'deploy'].map((name, i) => ({
      id: i + 1, name, status: 'completed', conclusion: i < 3 ? 'success' : 'skipped',
    }));
    const pr = { ...xxPr(), number: 198, headRefName: 'lane/198-replay',
      ...(!hydrate ? { rowsComplete: true, rowsHead: XX_HEAD } : {}),
      statusCheckRollup: hydrate ? rows.filter(row => row.name !== 'e2e') : rows };
    const readChecks = vi.fn(() => rows);
    const readRequiredChecks = args => getRequiredStatusChecks({ ...args,
      cachePath: join(dir, 'cache.json'), readChecks: () => {
        throw new Error('HTTP 403: Upgrade to GitHub Pro or make this repository public to enable this feature');
      } });
    const plan = runReconcilePass({ ...xxOptions(), repo: 'plateau-app',
      readPrs: () => [pr], readRequiredChecks, readChecks });
    expect(plan.refusals.filter(row => row.kind === 'check-read-failed')).toEqual([]);
    expect(plan.dispatch).toEqual([expect.objectContaining({ prNumber: 198, kind: 'promote-draft' })]);
    expect(readChecks).toHaveBeenCalledTimes(hydrate ? 1 : 0);
    if (hydrate) expect(readChecks).toHaveBeenCalledWith({ repo: 'plateauapp/plateau-app', sha: XX_HEAD });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each([
  ['red', [{ name: 'test', status: 'completed', conclusion: 'failure' }]],
  ['pending', [{ name: 'test', status: 'in_progress', conclusion: null }]],
  ['unchecked', []],
])('an unavailable required set never promotes %s observed checks', async (_, rows) => {
  const { runReconcilePass } = await import('../reconcile-pass.mjs');
  const plan = runReconcilePass({ ...xxOptions(), repo: 'plateau-app',
    readPrs: () => [{ ...xxPr(), statusCheckRollup: rows }],
    readRequiredChecks: () => ({ checks: [], source: 'unavailable' }) });
  expect(plan.dispatch.filter(row => row.kind === 'promote-draft')).toEqual([]);
});


it.each(['live', 'cache', 'unavailable'])('attaches rosterSource %s after hydration and logs exact evidence coverage once', async source => {
  const { runReconcilePass } = await import('../reconcile-pass.mjs');
  const complete = { ...xxPr(), statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    rowsHead: XX_HEAD, rowsComplete: true };
  const prs = [complete,
    { ...complete, number: 2, rowsComplete: false },
    { ...complete, number: 3, rowsHead: 'b'.repeat(40) },
    { ...complete, number: 4, rowsComplete: 'true' },
    { ...complete, number: 5, rowsHead: null, rowsComplete: false, statusCheckRollup: [] }];
  const readRequiredChecks = vi.fn(() => ({ checks: ['test'], source }));
  const readChecks = vi.fn(() => [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }]);
  let observed;
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    runReconcilePass({ ...xxOptions(), readPrs: () => prs, readRequiredChecks, readChecks,
      enrichMainRed: rows => { observed = rows; return { prs: rows, mainRedWindows: [] }; } });
    expect(observed).toHaveLength(5);
    expect(observed.every(pr => pr.rosterSource === source)).toBe(true);
    expect(observed[4].statusCheckRollup).toEqual([expect.objectContaining({ name: 'test', status: 'COMPLETED' })]);
    expect(readRequiredChecks).toHaveBeenCalledTimes(1);
    expect(readChecks).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.filter(([line]) => line.startsWith('check-evidence-coverage:'))).toEqual([
      ['check-evidence-coverage: 1/5 PRs rowsComplete===true && rowsHead===headRefOid'],
    ]);
  } finally { log.mockRestore(); }
});

it.each([{}, { rowsComplete: false, rowsHead: XX_HEAD }, { rowsComplete: true, rowsHead: 'b'.repeat(40) }])(
  'replacement rows without complete current-head provenance clear the old claim: %j', async provenance => {
  const { runReconcilePass } = await import('../reconcile-pass.mjs');
  const stale = { ...xxPr(), statusCheckRollup: [], rowsHead: XX_HEAD, rowsComplete: true };
  let observed;
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    runReconcilePass({ ...xxOptions(), readPrs: () => [stale], readRequiredChecks: () => ({ checks: ['test'], source: 'live' }),
      readChecks: () => Object.assign([{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }], provenance),
      enrichMainRed: rows => { observed = rows; return { prs: rows, mainRedWindows: [] }; } });
    expect(observed[0]).toMatchObject({ rowsComplete: false, rowsHead: null });
    expect(log.mock.calls.map(([l]) => l)).toContain('check-evidence-coverage: 0/1 PRs rowsComplete===true && rowsHead===headRefOid');
  } finally { log.mockRestore(); }
});
