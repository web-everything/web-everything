/** Six owed conflict repairs must pass an expired per-pass deadline; all admission seams remain in place. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
// Run the target tree's real dispatcher, with every dispatch/claim/GitHub/lane IO seam injected.
const PROBE = `
  const { runReconcileFixDispatch } = await import(process.argv[1]);
  const rows = [1, 2, 3, 4, 5, 6].map(prNumber => ({
    kind: 'fix', prNumber, headRefName: 'conflict-' + prNumber, isConflict: true, baseRefName: 'main',
  }));
  const result = runReconcileFixDispatch({
    root: '/repo', checkStaleness: () => ({ fresh: true, behind: 0 }),
    now: () => 11, deadlineAt: 10,
    reconcile: () => ({ dispatch: rows, refusals: [] }),
    findItemFn: () => null, loadItems: () => [], fetchItemlessDiffPaths: pr => ['src/' + pr + '.ts'],
    pickFreeLanes: () => [1, 2, 3, 4, 5, 6], listBuildClaims: () => [], listFixClaims: () => [],
    priorityShadow: null, tryResumeRound: null, tryResume: () => ({ resumed: false }),
    dispatchThrottle: { tryAdmit: () => ({ admit: true }) },
    fixSettings: { conflictFixesPerPass: 6, conflictFixExemptPerPass: 0 },
    dispatch: entry => ({ pr: entry.pr }),
  });
  console.log(JSON.stringify({ dispatched: result.dispatched, deferred: result.deferred }));
`;

export function probeConflictPass(root = REPO_ROOT) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-',
    pathToFileURL(join(root, 'scripts/conveyor/reconcile-fix-dispatch.mjs')).href], {
    input: PROBE, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024, cwd: root,
  });
  if (child.error || child.status !== 0) return { violations: [{ invariant: 'probe-failed',
    detail: child.error?.message ?? child.stderr }] };
  try {
    const result = JSON.parse(child.stdout);
    const passed = JSON.stringify(result.dispatched) === JSON.stringify([1, 2, 3, 4, 5, 6].map(pr => ({ pr })))
      && result.deferred.length === 0;
    return { ...result, violations: passed ? [] : [{ invariant: 'conflict-one-per-pass', detail: JSON.stringify(result) }] };
  } catch (error) {
    return { violations: [{ invariant: 'probe-unreadable', detail: error.message }] };
  }
}

export default {
  id: 'conflict-fix-parallel-one-per-pass',
  title: 'six conflicted PRs dispatch past an expired deadline instead of stopping after one',
  card: 'operator conflict-fix capacity ruling',
  fixedBy: { sha: 'conflict-fixes-per-pass', where: 'scripts/conveyor/reconcile-fix-dispatch.mjs',
    paths: ['scripts/conveyor/reconcile-fix-dispatch.mjs', 'scripts/conveyor/fix-takeover.mjs'] },
  fixPresent(root) { return probeConflictPass(root).violations.length === 0; },
  async run({ sourceRoot = REPO_ROOT } = {}) { return probeConflictPass(sourceRoot); },
  judge(report) { return report.violations.map(v => '[' + v.invariant + '] ' + v.detail); },
};
