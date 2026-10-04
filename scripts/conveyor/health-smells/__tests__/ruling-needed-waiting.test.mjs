import { describe, it, expect } from 'vitest';
import smell from '../ruling-needed-waiting.mjs';
import { DEFAULT_HEALTH_CONFIG, HOUR } from '../../health-watch-core.mjs';
import { mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord } from '../../../lib/jury-core.mjs';

const repo = 'web-everything/web-everything';
const head = 'a'.repeat(40);
const T0 = Date.parse('2026-10-04T04:32:00Z');
const original = { summary: 'policy pointer files are not listed', file: 'policy/pointer.md', line: 3, verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
const key = referralFindingKey('judge', original);
const record = (rulings = []) => ({ version: 1, repo, pr: 3794, head, runId: 'run-1', reviewer: mandatoryReferralReviewer('run-1'),
  authorBody: '<!-- authored-by-actor: a -->', attempted: true, referrals: [{ key, seat: 'judge', original, finding: normalizeFinding(original) }], rulings });
const pr = (rulings) => ({ repo, number: 3794, title: 't', headRefOid: head,
  comments: [{ body: renderReferralRecord(record(rulings)), createdAt: new Date(T0).toISOString(), author: { login: 'web-everything' } }] });
const config = { ...DEFAULT_HEALTH_CONFIG };

describe('ruling-needed-waiting', () => {
  it('defaults the dimension to 2 hours', () => expect(DEFAULT_HEALTH_CONFIG.rulingNeededAfterMs).toBe(2 * HOUR));
  it('does not breach before the bound, and names the finding with its file', () => {
    const [r] = smell.evaluate({ prs: [pr([])] }, { now: T0 + HOUR, config });
    expect(r.breach).toBe(false);
    expect(r.summary).toMatch(/policy\/pointer\.md:3/);
  });
  it('breaches after 2 h (the live case waited 8 h)', () => {
    const [r] = smell.evaluate({ prs: [pr([])] }, { now: T0 + 8 * HOUR, config });
    expect(r.breach).toBe(true);
    expect(r.measure.waitedMin).toBe(480);
  });
  it('the bound is a config dimension', () => {
    const now = T0 + 90 * 60_000;
    expect(smell.evaluate({ prs: [pr([])] }, { now, config })[0].breach).toBe(false);
    expect(smell.evaluate({ prs: [pr([])] }, { now, config: { ...config, rulingNeededAfterMs: HOUR } })[0].breach).toBe(true);
  });
  it('raises nothing once ruled, or on a new head', () => {
    const ruled = [{ id: 'r0', key, reviewerId: mandatoryReferralReviewer('run-1').id, lens: 'correctness', result: 'block', rationale: 'x', evidence: ['e'] }];
    expect(smell.evaluate({ prs: [pr(ruled)] }, { now: T0 + 8 * HOUR, config })).toEqual([]);
    expect(smell.evaluate({ prs: [{ ...pr([]), headRefOid: 'b'.repeat(40) }] }, { now: T0 + 8 * HOUR, config })).toEqual([]);
  });
});
