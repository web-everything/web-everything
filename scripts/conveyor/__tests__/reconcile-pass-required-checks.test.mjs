import { vi, it, expect } from 'vitest';


vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal(), execFileSync: vi.fn(),
}));
vi.mock('../../lib/gh-throttle.mjs', async () => {
  const { execFileSync } = await import('node:child_process');
  return {
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
