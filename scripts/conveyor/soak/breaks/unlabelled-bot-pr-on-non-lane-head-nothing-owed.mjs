/** PR #6254 (2026-11-02, D-R338): an open, green, non-draft BOT PR on a non-lane head with no review:* label was `nothing-owed` 13x. */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const done = (name) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-11-02T15:20:00Z' });

export default {
  id: 'unlabelled-bot-pr-on-non-lane-head-nothing-owed',
  title: 'PR #6254: an unlabelled open green bot PR on a non-lane head (ci/refresh-test-timings) is refused nothing-owed forever and never reviewed',
  card: 'D-R338 reconcile treats no labels as already reviewed',
  fixedBy: { sha: '2665d4226207d8f4c81a970c06cafa60f1cc08da,49e6b4224b463a6a6d6a0092369d0d42a6295e1a,99634539ae2deccbd1f6bfa73759bb038708ee80,28b0aa9fb78fbfe4e723229a1d21974f8e38e678', where: 'lane/reconcile-unlabelled-nonlane-pr', paths: ['scripts/conveyor/reconcile-core.mjs'] },
  // Always present: the fix ships in the same PR as this break, so a reproduced violation must FAIL the gate (never an expected-fail escape).
  fixPresent() { return true; },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { planReconcile } = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-core.mjs')).href);
    const pr = { number: 6254, state: 'OPEN', headRefName: 'ci/refresh-test-timings', headRefOid: 'f81bcb488ef9fdb3a38ea92fac80830b17753b69',
      author: { login: 'app/web-everything', is_bot: true }, isDraft: false, labels: [], comments: [], mergeStateStatus: 'CLEAN',
      statusCheckRollup: ['test', 'smoke', 'daemon-soak'].map(done) };
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: Date.parse('2026-11-02T16:00:00Z'),
      requiredChecks: ['test', 'smoke', 'daemon-soak'] });
    const violations = [];
    if (!plan.dispatch.some((d) => d.prNumber === 6254 && d.kind === 'restore-review-label')) {
      violations.push(`PR #6254 (open, green, bot, no review label) was not owed a label: ${JSON.stringify(plan.refusals.map((r) => r.kind))}`);
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
