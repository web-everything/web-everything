/** #7483/#7494: a merge-gate red only by red-main-freeze, while main is red, was planned as the PR's own ci-heal. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { planReconcile } from '../../reconcile-core.mjs';

export default {
  id: 'ci-heal-admission-refuses-main-red',
  title: 'a main-freeze-only merge-gate red plans no ci-heal while main is red',
  card: 'FIXER-L2-CIHEAL-ADMISSION',
  fixedBy: { sha: 'HEAD', where: 'lane/fixer-l2-ciheal-admission', paths: ['scripts/conveyor/ci-heal-admission.mjs'] },
  // Behaviour, not markers: plan the live shape and see whether a ci-heal is dispatched.
  fixPresent: root => existsSync(join(root, 'scripts/conveyor/ci-heal-admission.mjs')),
  async run() {
    const head = 'a'.repeat(40);
    const gate = { name: 'merge-gate', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-11-26T06:30:00Z', id: 123,
      mergeGateAdmission: { class: 'main', why: 'red-main-freeze', jobId: 123 } };
    const pr = { number: 7483, state: 'OPEN', headRefName: 'lane/7483-repair', headRefOid: head, rowsHead: head, rowsComplete: true,
      baseRefName: 'main', mergeStateStatus: 'UNSTABLE', mergeable: 'MERGEABLE', labels: [{ name: 'ci:failed' }], comments: [],
      statusCheckRollup: [gate] };
    const plan = planReconcile({ prs: [pr], agents: [], now: Date.parse('2026-11-26T07:00:00Z'), requiredChecks: ['merge-gate'],
      reviewTiming: { startAfter: 'ci-green' }, mainRedWindows: [{ start: '2026-11-26T06:00:00Z', end: null }] });
    const heals = plan.dispatch.filter(row => row.kind === 'ci-heal');
    const refused = plan.refusals.some(row => row.kind === 'main-red');
    const violations = !heals.length && refused ? []
      : [{ invariant: 'main-red-hold-not-own-failure', detail: JSON.stringify({ heals: heals.length, refusals: plan.refusals.map(r => r.kind) }) }];
    return { violations, heals: heals.length };
  },
  judge(report) { return report.violations.map(v => `${v.invariant}: ${v.detail}`); },
};
