import { describe, it, expect } from 'vitest';
import smell from '../review-label-missing.mjs';
import { emptyHealthState, stepEpisodes, runHealthTick } from '../../health-watch-core.mjs';
import { missingReviewLabel, planReconcile } from '../../reconcile-core.mjs';
const commits = [{ messageHeadline: 'repair', authors: [{ name: 'Claude' }] }];
const observed = (observedAt, extra = {}) => ({ state: 'OPEN', labels: [], commits, observedAt, ...extra });
const row = (observation, repo = 'o/r') => ({ repo, number: 3239, reviewObservation: observation });

describe('xe8y12n durable missing review observations', () => {
  it('opens once after two fresh samples, skips failures/cache across restart, closes on restored labels', () => {
    let state = emptyHealthState();
    const proof = [];
    const tick = (time, observation) => {
      const results = smell.evaluate({ prs: [row(observation)] }, { now: time, lastTick: state.lastTick });
      const next = stepEpisodes(state, [{ smell, results }], time);
      state = JSON.parse(JSON.stringify({ ...next.state, lastTick: { completedAt: time } }));
      proof.push({ observedAt: observation?.observedAt, time, transitions: next.transitions.map(t => t.type) });
      return next;
    };
    const start = Date.parse('2026-10-03T12:00:00Z');
    expect(tick(start, observed(start)).transitions).toEqual([]);
    expect(Object.values(state.episodes)[0].breachStreak).toBe(1);
    tick(start + 1000, null);
    tick(start + 2000, observed(start));
    expect(Object.values(state.episodes)[0].breachStreak).toBe(1);
    expect(tick(start + 900000, observed(start + 900000)).transitions.map(t => t.type)).toEqual(['opened']);
    for (let n = 2; n <= 10; n++) expect(tick(start + n * 900000, observed(start + n * 900000)).transitions).toEqual([]);
    tick(start + 11 * 900000, observed(start + 11 * 900000, { labels: null }));
    expect(Object.keys(state.episodes)).toHaveLength(1);
    expect(tick(start + 12 * 900000, observed(start + 12 * 900000, { labels: [{ name: 'review:pending' }] })).transitions.map(t => t.type)).toEqual(['closed']);
    console.info('xe8y12n synthetic health soak', JSON.stringify(proof));
  });
  it.each([
    [{ labels: ['bug'], isDraft: true }, true], [{ labels: ['review:future'] }, false],
    [{ commits: [{ authors: [{ name: 'Human' }] }] }, false],
    [{ commits: [...commits, { authors: [{ name: 'Human' }] }] }, false],
    [{ commits: null }, null], [{ labels: undefined }, null], [{ labels: [null] }, null],
  ])('uses the shared tri-state evidence predicate %j', (extra, expected) => {
    expect(missingReviewLabel(observed(1, extra))).toBe(expected);
  });
  it('keys identical numbers in different repos separately', () => {
    const results = smell.evaluate({ prs: [row(observed(1)), row(observed(1), 'o/other')] }, { now: 1 });
    const next = stepEpisodes(emptyHealthState(), [{ smell, results }], 1);
    expect(Object.keys(next.state.episodes)).toHaveLength(2);
  });
  it('reported #3239 shape is diagnostic-only; pending enables ordinary review selection', () => {
    const pr = { ...observed(1), number: 3239, headRefName: 'lane/3239', headRefOid: 'a'.repeat(40), comments: [], statusCheckRollup: [] };
    const before = planReconcile({ prs: [pr] });
    expect(before.notes).toContainEqual(expect.objectContaining({ kind: 'review-label-missing', prNumber: 3239 }));
    expect(before.dispatch).toEqual([]);
    const after = planReconcile({ requiredChecks: ['gate'], prs: [{ ...pr, labels: [{ name: 'review:pending' }], statusCheckRollup: [{ name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' }] }] });
    expect(after.dispatch).toContainEqual(expect.objectContaining({ kind: 'review' }));
  });
});

it('xe8y12n production tick context skips cached observations and remains alert-only', () => {
  const first = runHealthTick(emptyHealthState(), { prs: [row(observed(100))] }, [smell], 100);
  const persisted = JSON.parse(JSON.stringify({ ...first.state, lastTick: { completedAt: 110 } }));
  const cached = runHealthTick(persisted, { prs: [row(observed(100))] }, [smell], 200);
  expect(Object.values(cached.state.episodes)[0].breachStreak).toBe(1);
  expect(cached.transitions).toEqual([]);
  const fresh = runHealthTick(cached.state, { prs: [row(observed(300))] }, [smell], 300);
  expect(fresh.transitions.map(t => t.type)).toEqual(['opened']);
  expect(smell.action).toBe('alert');
  expect(fresh.plan.every(action => action.kind !== 'file' && action.kind !== 'investigate')).toBe(true);
});
