/** Review planned owed CI reruns, but only the slow fix-daemon ci-heal phase executed them. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default {
  id: 'owed-ci-rerun-planned-but-never-executed',
  title: 'PRs owed a ci-timeout-rerun, not a review, wait for the slow fix-daemon ci-heal phase',
  card: 'execute owed CI reruns promptly in the review daemon',
  fixedBy: { sha: 'HEAD', where: 'review-daemon', paths: ['skills-src/conveyor/review-daemon.mjs', 'scripts/conveyor/owed-ci-rerun-executor.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'skills-src/conveyor/review-daemon.mjs'), 'utf8').includes('executeOwedCiReruns'); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { executeOwedCiReruns } = await import(pathToFileURL(join(root, 'scripts/conveyor/owed-ci-rerun-executor.mjs')).href);
    const violations = [];
    const plan = { dispatch: Array.from({ length: 13 }, (_, i) => ({
      kind: 'ci-timeout-rerun', prNumber: 20 - i, timeoutRetry: { pr: 20 - i },
    })) };
    const calls = [];
    const dispatchRetry = async (evidence) => { calls.push(evidence.pr); return { status: 'requested' }; };
    const out = await executeOwedCiReruns({ rows: plan.dispatch, repo: 'o/r', root, max: 10,
      dispatchRetry, checkStaleness: () => ({ fresh: true, behind: 0 }) });
    if (calls.length < 10 || out.requested.length < 10) violations.push('fewer than 10 owed reruns executed in one call');
    if (calls.length > 10 || out.requested.length > 10) violations.push('more than 10 owed reruns executed in one call');
    const expected = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
    if (JSON.stringify(calls) !== JSON.stringify(expected) || JSON.stringify(out.requested) !== JSON.stringify(expected)) {
      violations.push('owed reruns did not execute oldest-first');
    }
    if (out.refused.length) violations.push('fresh owed reruns were refused');
    if (out.skippedOverCap !== 3) violations.push('three over-cap reruns were not left owed for the next tick');
    calls.length = 0;
    try {
      const offline = await executeOwedCiReruns({ rows: plan.dispatch, repo: 'o/r', root, max: 10,
        dispatchRetry, checkStaleness: () => ({ offline: true }) });
      if (calls.length || offline.requested.length) violations.push('offline freshness executed owed reruns');
      if (offline.refused.length !== 13) violations.push('offline freshness did not refuse every owed rerun');
    } catch (error) { violations.push(`offline freshness threw: ${error.message}`); }
    return { violations };
  },
  judge(report) { return report.violations; },
};
