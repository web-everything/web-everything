import { describe, expect, it } from 'vitest';
import { runReconcileFixDispatch } from '../reconcile-fix-dispatch.mjs';

// Live: the open-PR read + plan took 8-15 min against a 5 min fix budget, so the budget was spent before the first
// dispatch and each pass launched ~2 fixers; red-team send-backs (#7120, #7123) starved for hours.
describe('runReconcileFixDispatch — the pass budget bounds dispatch work, not the plan read', () => {
  const run = planMs => {
    let time = 1000;
    return runReconcileFixDispatch({ root: '/repo', checkStaleness: () => ({ fresh: true, behind: 0 }),
      now: () => time, deadlineAt: 1000 + 300, stepLog: () => {},
      reconcile: () => { time += planMs; return { dispatch: [1764, 1765, 1766].map(prNumber => ({ kind: 'fix', prNumber,
        headRefName: `fix-branch-${prNumber}`, labels: ['review:changes'] })), refusals: [] }; },
      findItemFn: () => null, loadItems: () => [], fetchItemlessDiffPaths: pr => [`src/${pr}.ts`],
      pickFreeLanes: () => [2, 9, 10], listBuildClaims: () => [], listFixClaims: () => [],
      priorityShadow: null, tryResumeRound: null, tryResume: () => ({ resumed: false, resumeAttempt: null }),
      dispatchThrottle: { tryAdmit: () => ({ admit: true }) },
      dispatch: entry => { time += 10; return { pr: entry.pr, lane: entry.lane }; } });
  };

  it('dispatches every owed PR even when planning alone outlasts the budget', () => {
    expect(run(900)).toMatchObject({ handled: 3, deferred: [], nextCursor: null });
  });

  it('still defers once dispatch work itself exhausts the budget', () => {
    let time = 1000;
    const result = runReconcileFixDispatch({ root: '/repo', checkStaleness: () => ({ fresh: true, behind: 0 }),
      now: () => time, deadlineAt: 1000 + 5, stepLog: () => {},
      reconcile: () => ({ dispatch: [1764, 1765].map(prNumber => ({ kind: 'fix', prNumber, headRefName: `f-${prNumber}` })), refusals: [] }),
      findItemFn: () => null, loadItems: () => [], fetchItemlessDiffPaths: pr => [`src/${pr}.ts`],
      pickFreeLanes: () => [2, 9], listBuildClaims: () => [], listFixClaims: () => [],
      priorityShadow: null, tryResumeRound: null, tryResume: () => ({ resumed: false, resumeAttempt: null }),
      dispatchThrottle: { tryAdmit: () => ({ admit: true }) },
      dispatch: entry => { time += 10; return { pr: entry.pr, lane: entry.lane }; } });
    expect(result).toMatchObject({ handled: 1, deferred: [1765] });
  });
});
