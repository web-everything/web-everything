/** The owed ci-timeout-rerun executor refused every rerun because the daemon's own clone was behind origin/main. */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default {
  id: 'owed-ci-rerun-stale-daemon-clone-refused',
  title: 'A review daemon whose own clone is behind main refuses every owed ci-timeout-rerun',
  card: 'owed ci rerun executor must not depend on the daemon clone being fresh',
  fixedBy: { sha: 'HEAD', where: 'review-daemon', paths: ['scripts/conveyor/owed-ci-rerun-executor.mjs'] },
  // The fix ships in this tree, so the scenario is always REQUIRED to pass: a regression must fail CI, not flip
  // into an expected failure (a behaviour-derived fixPresent would do exactly that).
  fixPresent() { return true; },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { executeOwedCiReruns } = await import(pathToFileURL(join(root, 'scripts/conveyor/owed-ci-rerun-executor.mjs')).href);
    const violations = [];
    const rows = [{ kind: 'ci-timeout-rerun', prNumber: 7263, timeoutRetry: { pr: 7263 } }];
    const calls = [];
    const dispatchRetry = async (evidence) => { calls.push(evidence.pr); return { status: 'requested' }; };
    // Same injected verdict the old guard refused on: the clone is behind and cannot be fast-forwarded.
    const out = await executeOwedCiReruns({ rows, repo: 'o/r', root: '/nonexistent', dispatchRetry,
      checkStaleness: () => ({ fresh: true, behind: 12 }) });
    if (!calls.length || out.requested.length !== 1) violations.push('a clone behind origin/main refused the owed rerun');
    calls.length = 0;
    const offline = await executeOwedCiReruns({ rows, repo: 'o/r', root: '/nonexistent', dispatchRetry,
      checkStaleness: () => ({ offline: true }) });
    if (calls.length || offline.requested.length) violations.push('unknown main freshness (offline) executed a rerun');
    return { violations };
  },
  judge(report) { return report.violations; },
};
