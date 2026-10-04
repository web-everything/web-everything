/** PR #3902 (2026-10-04): a ready-to-merge lane PR with no review:* label went red and nothing ever put it in review. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const run = (name, conclusion) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion, completedAt: '2026-10-04T16:24:53Z' });
const aiCommit = { messageHeadline: 'fix(x): y', messageBody: 'Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>', authors: [{ login: 'chalbert' }] };

export default {
  id: 'ready-to-merge-red-pr-never-reviewed',
  title: 'PR #3902: a ready-to-merge lane PR with no review:* label and a red soak-replay-gate was never scored, reviewed, or labelled',
  card: 'conveyor gap C — review label heal (PR #3902)',
  fixedBy: { sha: 'd8b3c4080', where: 'lane/review-label-heal', paths: ['scripts/conveyor/reconcile-core.mjs', 'scripts/operations/promote-draft-pr-dispatch.mjs', 'scripts/pr-land.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'scripts/conveyor/reconcile-core.mjs'), 'utf8').includes("variant: 'stuck'"); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { planReconcile } = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-core.mjs')).href);
    const pr = { number: 3902, state: 'OPEN', isDraft: false, headRefName: 'lane/pool-scan-skip-non-dir-entries',
      headRefOid: '8d0ccb4b51356f760172fb0e79ccc6000a0812a1', mergeStateStatus: 'BLOCKED', comments: [],
      labels: [{ name: 'ready-to-merge' }], commits: [aiCommit],
      statusCheckRollup: [run('test', 'SUCCESS'), run('smoke', 'SUCCESS'), run('daemon-soak', 'SUCCESS'), run('soak-replay-gate', 'FAILURE')] };
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: Date.parse('2026-10-04T17:30:00Z'),
      requiredChecks: ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'] });
    const violations = plan.dispatch.some((d) => d.prNumber === 3902 && d.kind === 'restore-review-label') ? []
      : [`PR #3902 was owed no review label: ${JSON.stringify(plan.refusals.map((r) => r.kind))}`];
    return { violations };
  },
  judge(report) { return report.violations; },
};
