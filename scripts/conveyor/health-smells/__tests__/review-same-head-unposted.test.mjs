import { describe, it, expect } from 'vitest';
import smell from '../review-same-head-unposted.mjs';
import { SMELLS } from '../index.mjs';
import { DEFAULT_HEALTH_CONFIG, HOUR } from '../../health-watch-core.mjs';

const now = Date.parse('2026-10-05T12:00:00Z');
const head = 'a'.repeat(40);
const run = (minutes, overrides = {}) => ({ op: 'review-pr', input: { repo: 'plateauapp/plateau-app', pr: 202 },
  findings: { read: { netBasis: { rev: head } } },
  stepTimings: [{ step: 'read', startedAt: new Date(now - minutes * 60_000).toISOString() }],
  effects: [], ...overrides });
const evaluate = (operationRuns, config = {}) => smell.evaluate({ operationRuns }, { now, config });

describe('review-same-head-unposted', () => {
  it('is registered and has configurable defaults', () => {
    expect(SMELLS.find(s => s.id === smell.id)).toBe(smell);
    expect(DEFAULT_HEALTH_CONFIG).toMatchObject({ sameHeadReviewWindowMs: 6 * HOUR, sameHeadUnpostedReviews: 3 });
  });
  it('breaches on three unposted reviews, but not two', () => {
    expect(evaluate([run(30), run(20), run(10)])[0]).toMatchObject({ breach: true,
      subject: 'plateauapp/plateau-app#202@aaaaaaaaa', measure: { count: 3 } });
    expect(evaluate([run(20), run(10)])[0].breach).toBe(false);
  });
  it.each(['review.advisory-note', 'review.write-up', 'review.label-swap'])('a posted %s resets the count', type => {
    const prior = [run(30), run(20), run(10)];
    const posted = run(5, { effects: [{ type, status: 'applied' }] });
    expect(evaluate([posted, ...prior])[0]).toMatchObject({ breach: false, measure: { count: 0 } });
    expect(evaluate([...prior, posted, run(1)])[0].measure.count).toBe(1);
    expect(evaluate([...prior, run(5, { effects: [{ type, status: 'failed' }] })])[0].breach).toBe(true);
  });
  it('does not combine different heads', () => {
    const other = run(10, { findings: { read: { netBasis: { rev: 'b'.repeat(40) } } } });
    expect(evaluate([run(30), run(20), other]).every(r => !r.breach)).toBe(true);
  });
  it('ignores incomplete records and observations outside the window', () => {
    expect(evaluate([{}, run(1, { input: {} }), run(1, { findings: {} }), run(1, { stepTimings: [] }),
      run(1, { effects: undefined }), run(361), run(-1)])).toEqual([]);
    expect(evaluate([run(30), run(20), run(10)], { sameHeadReviewWindowMs: 15 * 60_000 })[0].breach).toBe(false);
    expect(evaluate([run(20), run(10)], { sameHeadUnpostedReviews: 2 })[0].breach).toBe(true);
  });
});
