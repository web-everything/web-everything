/** @file The review-hold reconcile sweep (#x01u7az) — drops a stray review:pending beside a live review:human,
 *  and a stray advisory:* left behind once review:human is gone. No `gh`. */
import { describe, expect, it } from 'vitest';

import { needsReviewHoldCleanup, planReviewHoldCleanup, sweepReviewHoldLabels } from '../review-hold-reconcile.mjs';

const pr = (number, names) => ({ number, labels: names.map((name) => ({ name })) });

function provider() {
  const calls = { set: [], currentRepo: 0 };
  return {
    calls,
    setLabels: (repo, number, spec) => { calls.set.push({ repo, number, spec }); },
    currentRepo: () => { calls.currentRepo += 1; return 'o/n'; },
  };
}

describe('planReviewHoldCleanup', () => {
  // #x01u7az — LIVE, PR #2549 (2026-09-24): review:pending added by a mechanical rearm on top of a still-live
  // review:human, never cleared. At most one review:* hold at a time.
  it('drops a stray review:pending that coexists with review:human', () => {
    expect(planReviewHoldCleanup({ currentLabels: [{ name: 'review:human' }, { name: 'review:pending' }] }))
      .toEqual({ remove: ['review:pending'] });
  });

  it('leaves review:pending alone when review:human is absent (an ordinary parked PR)', () => {
    expect(planReviewHoldCleanup({ currentLabels: [{ name: 'review:pending' }] })).toEqual({ remove: [] });
  });

  it('leaves review:human alone when review:pending is absent (an ordinary gate-self PR)', () => {
    expect(planReviewHoldCleanup({ currentLabels: [{ name: 'review:human' }] })).toEqual({ remove: [] });
  });

  // #x01u7az — LIVE, PR #2578 (2026-09-24): advisory:accepted stamped while review:human, review:human later
  // cleared via clear-human, the advisory label left behind describing a gate that no longer exists.
  it('drops advisory:accepted once review:human is gone', () => {
    expect(planReviewHoldCleanup({ currentLabels: [{ name: 'advisory:accepted' }] }))
      .toEqual({ remove: ['advisory:accepted'] });
  });

  it('drops advisory:changes once review:human is gone', () => {
    expect(planReviewHoldCleanup({ currentLabels: [{ name: 'advisory:changes' }] }))
      .toEqual({ remove: ['advisory:changes'] });
  });

  it('leaves an advisory label alone while review:human is still live — it still means something', () => {
    expect(planReviewHoldCleanup({ currentLabels: [{ name: 'review:human' }, { name: 'advisory:accepted' }] }))
      .toEqual({ remove: [] });
  });

  it('both invariants can fire together on one PR, additively', () => {
    // Not the #2549/#2578 shape (that would require human present for one check and absent for the other on
    // the SAME read) — a PR with a stray pending AND no human but a stray advisory is two independent strays.
    expect(planReviewHoldCleanup({
      currentLabels: [{ name: 'review:pending' }, { name: 'advisory:changes' }, { name: 'checking' }],
    })).toEqual({ remove: ['advisory:changes'] }); // no review:human present → the pending check does not fire
  });

  it('a clean PR (no contradiction) removes nothing', () => {
    expect(planReviewHoldCleanup({ currentLabels: [{ name: 'review:human' }, { name: 'review-round:2' }] }))
      .toEqual({ remove: [] });
    expect(planReviewHoldCleanup({ currentLabels: [] })).toEqual({ remove: [] });
  });

  it('tolerates bare-string label arrays, not just {name} objects', () => {
    expect(planReviewHoldCleanup({ currentLabels: ['review:human', 'review:pending'] }))
      .toEqual({ remove: ['review:pending'] });
  });
});

describe('needsReviewHoldCleanup', () => {
  it('is true exactly when planReviewHoldCleanup would remove something', () => {
    expect(needsReviewHoldCleanup(pr(1, ['review:human', 'review:pending']))).toBe(true);
    expect(needsReviewHoldCleanup(pr(2, ['review:human']))).toBe(false);
    expect(needsReviewHoldCleanup(pr(3, []))).toBe(false);
  });
});

describe('sweepReviewHoldLabels', () => {
  it('drops the stray review:pending from a PR that also carries review:human (PR #2549 shape)', () => {
    const p = provider();
    const results = sweepReviewHoldLabels({
      repo: 'o/n', provider: p,
      listPrs: () => [pr(2549, ['review:human', 'review:pending', 'review-round:5', 'advisory:changes'])],
    });
    expect(results).toEqual([{ num: 2549, remove: ['review:pending'] }]);
    expect(p.calls.set).toEqual([{ repo: 'o/n', number: 2549, spec: { remove: ['review:pending'] } }]);
  });

  it('drops the stale advisory:accepted from a PR whose review:human was already cleared (PR #2578 shape)', () => {
    const p = provider();
    const results = sweepReviewHoldLabels({
      repo: 'o/n', provider: p,
      listPrs: () => [pr(2578, ['review:pending', 'checking', 'review-round:3', 'review-status:review-stalled', 'advisory:accepted'])],
    });
    expect(results).toEqual([{ num: 2578, remove: ['advisory:accepted'] }]);
  });

  it('leaves a clean PR (PR #2582 shape — review:human alone, no advisory yet) untouched', () => {
    const p = provider();
    const results = sweepReviewHoldLabels({
      repo: 'o/n', provider: p,
      listPrs: () => [pr(2582, ['review:human', 'review-status:reviewing', 'review-round:1'])],
    });
    expect(results).toEqual([]);
    expect(p.calls.set).toEqual([]);
  });

  it('dry-run reports the plan and never calls setLabels', () => {
    const p = provider();
    const results = sweepReviewHoldLabels({
      repo: 'o/n', provider: p, dryRun: true,
      listPrs: () => [pr(2549, ['review:human', 'review:pending'])],
    });
    expect(results).toEqual([{ num: 2549, remove: ['review:pending'] }]);
    expect(p.calls.set).toEqual([]);
  });

  it('a setLabels failure is captured on the entry, not thrown — one bad PR must not abort the sweep', () => {
    const p = provider();
    p.setLabels = () => { throw new Error('gh boom'); };
    const results = sweepReviewHoldLabels({
      repo: 'o/n', provider: p,
      listPrs: () => [pr(2549, ['review:human', 'review:pending'])],
    });
    expect(results).toEqual([{ num: 2549, remove: ['review:pending'], error: 'gh boom' }]);
  });

  it('resolves --repo lazily from the provider only when a write is about to happen', () => {
    const p = provider();
    sweepReviewHoldLabels({ repo: null, provider: p, listPrs: () => [pr(1, ['review:human', 'review:pending'])] });
    expect(p.calls.currentRepo).toBe(1);
  });
});
