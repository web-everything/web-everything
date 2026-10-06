// @vitest-environment node
/** perf C1c — the review daemon reads PR facts first; stale/partial store falls back to GitHub; never a write/merge input. */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookupReviewFacts, readReviewCiGateFactsFirst, withFactsLabels, reviewFactsEnabled } from '../review-facts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const facts = (o = {}) => ({ repo: 'o/r', number: 7, headSha: 'abc', state: 'open', draft: false, labels: ['review:pending'],
  checks: [{ name: 'test', app: 'gha', conclusion: 'success' }], suites: [], review: null, ...o });
const hit = (f) => () => ({ facts: f, source: f ? 'store' : 'github', reason: f ? 'served' : 'ttl-expired' });
const required = (checks = ['test']) => () => ({ source: 'live', checks });

describe('review facts: facts first', () => {
  it("label provider: a facts hit makes 0 gh calls, a null makes exactly today's call", () => {
    const base = { readLabels: vi.fn(() => [{ name: 'gh-label' }]), setLabels: vi.fn() };
    expect(withFactsLabels(base, { lookup: hit(facts()) }).readLabels('o/r', 7)).toEqual([{ name: 'review:pending' }]);
    expect(base.readLabels).not.toHaveBeenCalled();
    expect(withFactsLabels(base, { lookup: hit(null) }).readLabels('o/r', 7)).toEqual([{ name: 'gh-label' }]);
    expect(base.readLabels).toHaveBeenCalledTimes(1);
    withFactsLabels(base, { lookup: hit(null) }).setLabels('o/r', 7, {});
    expect(base.setLabels).toHaveBeenCalledTimes(1); // writes untouched
  });

  it('gate: store hit with green required checks = 1 live head read, no check reads', () => {
    const liveHead = vi.fn(() => 'abc');
    const live = vi.fn();
    const r = readReviewCiGateFactsFirst({ repo: 'o/r', pr: 7, lookup: hit(facts()), live, liveHead, readRequired: required() });
    expect(r).toMatchObject({ allowed: true, headSha: 'abc', factsSource: 'store' });
    expect(liveHead).toHaveBeenCalledTimes(1);
    expect(live).not.toHaveBeenCalled();
  });

  it('count: a 10-PR tick makes 40 gate gh calls on the old path (2 heads + check-runs + status) and 10 on facts-first', async () => {
    const { readReviewCiGate } = await import('../review-ci-gate-io.mjs');
    let calls = 0;
    const readHead = () => { calls += 1; return 'abc'; };
    const readChecks = () => { calls += 2; return [{ name: 'test', status: 'completed', conclusion: 'success', head_sha: 'abc' }]; }; // check-runs + status
    for (let pr = 1; pr <= 10; pr += 1) readReviewCiGate({ repo: 'o/r', pr, readHead, readChecks, readRequired: required() });
    const before = calls;
    calls = 0;
    for (let pr = 1; pr <= 10; pr += 1) readReviewCiGateFactsFirst({ repo: 'o/r', pr, lookup: hit(facts()), liveHead: readHead, readRequired: required() });
    expect({ before, after: calls }).toEqual({ before: 40, after: 10 });
  });

  it('gate: stale store (null) falls back to the live gate unchanged', () => {
    const live = vi.fn(() => ({ allowed: false, reason: 'live' }));
    expect(readReviewCiGateFactsFirst({ repo: 'o/r', pr: 7, lookup: hit(null), live })).toEqual({ allowed: false, reason: 'live' });
    expect(live).toHaveBeenCalledTimes(1);
  });

  it('gate: a required check missing from the store (partial) re-reads GitHub, never refuses from the store', () => {
    const live = vi.fn(() => ({ allowed: true, reason: 'live-ok' }));
    const r = readReviewCiGateFactsFirst({ repo: 'o/r', pr: 7, lookup: hit(facts()), live, liveHead: () => 'abc', readRequired: required(['test', 'legacy-status']) });
    expect(live).toHaveBeenCalledTimes(1);
    expect(r.reason).toBe('live-ok');
  });

  it('gate: a completed failure is trusted from the store (no gh)', () => {
    const live = vi.fn();
    const f = facts({ checks: [{ name: 'test', app: 'gha', conclusion: 'failure' }] });
    const r = readReviewCiGateFactsFirst({ repo: 'o/r', pr: 7, lookup: hit(f), live, liveHead: () => 'abc', readRequired: required() });
    expect(r).toMatchObject({ allowed: false, reason: 'required-checks-not-successful', factsSource: 'store' });
    expect(live).not.toHaveBeenCalled();
  });

  it('gate: head moved since the store was folded is not a trusted store refusal', () => {
    const live = vi.fn(() => ({ allowed: false, reason: 'live' }));
    readReviewCiGateFactsFirst({ repo: 'o/r', pr: 7, lookup: hit(facts()), live, liveHead: () => 'zzz', readRequired: required() });
    expect(live).toHaveBeenCalledTimes(1);
  });

  it('the declared setting WE_REVIEW_FACTS=0 turns it off', () => {
    expect(reviewFactsEnabled({})).toBe(true);
    expect(reviewFactsEnabled({ WE_REVIEW_FACTS: '0' })).toBe(false);
    expect(lookupReviewFacts({ repo: 'o/r', number: 7, env: { WE_REVIEW_FACTS: '0' } })).toMatchObject({ facts: null, source: 'github' });
  });

  it('the label writer, the provider, the gate IO and the merge path never import review-facts', () => {
    for (const rel of ['scripts/merge-ai-prs.mjs', 'scripts/lib/pr-merge-gate.mjs', 'scripts/pr-land.mjs', 'scripts/review-set-label.mjs', 'scripts/lib/review-label-provider.mjs', 'scripts/lib/review-ci-gate-io.mjs']) {
      expect(readFileSync(join(ROOT, rel), 'utf8'), rel).not.toMatch(/['"][^'"]*review-facts(?:\.mjs)?['"]/);
    }
  });
});
