/** PR #3830 (2026-10-03/04): an open, green lane PR with no review:* label was `nothing-owed` forever. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const done = (name) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS' });

export default {
  id: 'green-lane-pr-without-review-label-in-limbo',
  title: 'PR #3830: an open green lane PR carrying no review:* label is refused nothing-owed forever and no daemon ever labels it',
  card: 'unstick PRs #3850/#3830/#3826 (epic #3383/#4075)',
  fixedBy: { sha: '274c4400b2f756feb89f19430fb7c64c404d3c37', where: 'lane/unstick-3850-3830-3826', paths: ['scripts/conveyor/reconcile-core.mjs', 'scripts/operations/promote-draft-pr-dispatch.mjs', 'scripts/pr-land.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'scripts/conveyor/reconcile-core.mjs'), 'utf8').includes("kind: 'restore-review-label'"); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { planReconcile } = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-core.mjs')).href);
    const pr = { number: 3830, state: 'OPEN', headRefName: 'lane/xw4yqe9-prevention-card', headRefOid: '5dbb97875768544344368071250e485f1b43ebb2',
      isDraft: false, labels: [], comments: [], mergeStateStatus: 'CLEAN',
      statusCheckRollup: ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'].map(done) };
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: Date.parse('2026-10-04T11:50:00Z'),
      requiredChecks: ['test', 'smoke', 'daemon-soak'] });
    const violations = [];
    if (!plan.dispatch.some((d) => d.prNumber === 3830 && d.kind === 'restore-review-label')) {
      violations.push(`PR #3830 (open, green, no review label) was not owed a label: ${JSON.stringify(plan.refusals.map((r) => r.kind))}`);
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
