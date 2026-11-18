/**
 * @file owed-explanation.test.mjs — an `owed` soak violation names WHY the daemon did not dispatch the PR.
 * Main CI went red twice on "PR #10 owed review for N review ticks with no dispatch" with nothing else in the log to
 * diagnose it; the violation now carries the daemon's own reported reason for that PR.
 */
import { describe, expect, it } from 'vitest';
import { checkTick, DEFAULT_BOUNDS, explainNoDispatch } from '../invariants.mjs';

describe('explainNoDispatch', () => {
  it('names the not-started reason, the log lines and the tick totals for the PR', () => {
    const why = explainNoDispatch({
      result: { reviewsOwed: 2, dispatched: [{ prNumber: 12 }], notStarted: [{ prNumber: 10, reason: 'lane-cooloff' }, { prNumber: 11, reason: 'other' }],
        deferredForLanes: 1 },
      logs: ['review-daemon: web-everything/web-everything#10 not dispatched — lane-cooloff', 'review-daemon: #11 unrelated', 'review-daemon: #100 is another PR'],
    }, 10);
    expect(why).toContain('notStarted: lane-cooloff');
    expect(why).toContain('deferredForLanes=1');
    expect(why).toContain('log: review-daemon: web-everything/web-everything#10 not dispatched');
    expect(why).not.toContain('#11');
    expect(why).not.toContain('#100');
    expect(why).toContain('reviewsOwed=2 dispatched=[12]');
  });

  it('reads the pending-not-dispatched reasons and live-process holds', () => {
    const why = explainNoDispatch({ result: { pendingNotDispatched: [{ prNumber: 10, reasons: ['live-process', 'ci pending'] }], liveProcessPrs: [{ repo: 'we', prNumber: 10 }] } }, 10);
    expect(why).toContain('pendingNotDispatched: live-process; ci pending');
    expect(why).toContain('a live process still holds this PR');
  });

  it('still says something when the tick reported nothing for the PR', () => {
    expect(explainNoDispatch({}, 10)).toBe('reviewsOwed=? dispatched=[]');
  });
});

describe('checkTick owed violation', () => {
  const base = { daemon: 'review', index: 21, entry: { ms: 1 }, facts: { dirty: [], behind: 0 }, stale: false, staleStreak: 0 };

  it('appends the daemon explanation when present', () => {
    const [v] = checkTick({ ...base, owed: [{ pr: 10, kind: 'review', sinceTick: 15, why: 'notStarted: lane-cooloff' }] });
    expect(v.invariant).toBe('owed');
    expect(v.detail).toBe(`PR #10 owed review for 7 review ticks with no dispatch (grace ${DEFAULT_BOUNDS.owedGraceTicks}); daemon said: notStarted: lane-cooloff`);
  });

  it('keeps the original text without one', () => {
    const [v] = checkTick({ ...base, owed: [{ pr: 10, kind: 'review', sinceTick: 15 }] });
    expect(v.detail).toBe(`PR #10 owed review for 7 review ticks with no dispatch (grace ${DEFAULT_BOUNDS.owedGraceTicks})`);
  });
});
