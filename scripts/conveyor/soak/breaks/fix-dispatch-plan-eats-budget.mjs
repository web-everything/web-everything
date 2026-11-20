/**
 * @file fix-dispatch-plan-eats-budget.mjs
 * @description Live #7120/#7123: the fix pass's 5 min budget was spent by the 8-15 min open-PR read + plan, so each
 * pass launched ~2 fixers and red-team send-backs starved. Behaviour check: with a plan that outlasts the budget,
 * every owed PR is still dispatched in the pass.
 */
import { runReconcileFixDispatch } from '../../reconcile-fix-dispatch.mjs';

export default {
  id: 'fix-dispatch-plan-eats-budget',
  title: 'the fix-pass budget must bound dispatch work, not the plan read that precedes it',
  card: 'red-team send-backs never dispatched (#7120, #7123, #7104)',
  fixedBy: { sha: 'lane/fix-dispatch-planning-deadline', where: 'lane/fix-dispatch-planning-deadline', paths: ['scripts/conveyor/reconcile-fix-dispatch.mjs'] },
  // Decided by behaviour, not a marker string: the scenario itself is the probe.
  fixPresent() { return this.judge(this.run()).length === 0; },
  run({ log } = {}) {
    let time = 1000;
    const result = runReconcileFixDispatch({ root: '/repo', checkStaleness: () => ({ fresh: true, behind: 0 }),
      now: () => time, deadlineAt: 1300, stepLog: () => {},
      reconcile: () => { time += 900; return { dispatch: [1, 2, 3].map(prNumber => ({ kind: 'fix', prNumber, headRefName: `f-${prNumber}`, labels: ['review:changes'] })), refusals: [] }; },
      findItemFn: () => null, loadItems: () => [], fetchItemlessDiffPaths: pr => [`src/${pr}.ts`],
      pickFreeLanes: () => [2, 9, 10], listBuildClaims: () => [], listFixClaims: () => [],
      priorityShadow: null, tryResumeRound: null, tryResume: () => ({ resumed: false, resumeAttempt: null }),
      dispatchThrottle: { tryAdmit: () => ({ admit: true }) },
      dispatch: entry => { time += 10; return { pr: entry.pr, lane: entry.lane }; } });
    const report = { handled: result.handled, deferred: result.deferred }; log?.(JSON.stringify(report)); return report;
  },
  judge(report) {
    return report.handled === 3 ? [] : [`[plan-eats-budget] only ${report.handled} of 3 owed PRs dispatched; ${report.deferred.length} deferred behind a spent budget`];
  },
};
