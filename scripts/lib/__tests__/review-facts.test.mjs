// @vitest-environment node
import { completeCheckRows } from './helpers/complete-check-rows.mjs';
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
  // Gate fixtures below pin ci-green/off so store decisions retain their original strict-CI contract.
  it("label provider: a facts hit makes 0 gh calls, a null makes exactly today's call", () => {
    const base = { readLabels: vi.fn(() => [{ name: 'gh-label' }]), setLabels: vi.fn() };
    expect(withFactsLabels(base, { lookup: hit(facts()) }).readLabels('o/r', 7)).toEqual([{ name: 'review:pending' }]);
    expect(base.readLabels).not.toHaveBeenCalled();
    expect(withFactsLabels(base, { lookup: hit(null) }).readLabels('o/r', 7)).toEqual([{ name: 'gh-label' }]);
    expect(base.readLabels).toHaveBeenCalledTimes(1);
    withFactsLabels(base, { lookup: hit(null) }).setLabels('o/r', 7, {});
    expect(base.setLabels).toHaveBeenCalledTimes(1); // writes untouched
  });

  it('gate: completed-only store cannot attest all rows, so green checks require the live gate', () => {
    const liveHead = vi.fn(() => 'abc');
    const liveResult = { allowed: true, headSha: 'abc', reason: 'required-checks-successful' };
    const live = vi.fn(() => liveResult);
    const r = readReviewCiGateFactsFirst({ policy: { startAfter: 'ci-green', startEarly: 'off' }, repo: 'o/r', pr: 7, lookup: hit(facts()), live, liveHead, readRequired: required() });
    expect(r).toBe(liveResult);
    expect(liveHead).toHaveBeenCalledTimes(1);
    expect(live).toHaveBeenCalledTimes(1);
  });

  it('count: incomplete store checks retain the full live gate plus a live head reread', async () => {
    const { readReviewCiGate } = await import('../review-ci-gate-io.mjs');
    let calls = 0;
    const readHead = () => { calls += 1; return 'abc'; };
    const readChecks = () => { calls += 2; return completeCheckRows([{ name: 'test', status: 'completed', conclusion: 'success', head_sha: 'abc' }], 'abc'); }; // check-runs + status
    for (let pr = 1; pr <= 10; pr += 1) readReviewCiGate({ policy: { startAfter: 'ci-green', startEarly: 'off' }, repo: 'o/r', pr, readHead, readChecks, readRequired: required() });
    const before = calls;
    calls = 0;
    for (let pr = 1; pr <= 10; pr += 1) readReviewCiGateFactsFirst({ policy: { startAfter: 'ci-green', startEarly: 'off' }, repo: 'o/r', pr, lookup: hit(facts()), liveHead: readHead, readRequired: required(),
      live: args => readReviewCiGate({ ...args, readHead, readChecks }) });
    expect({ before, after: calls }).toEqual({ before: 40, after: 50 });
  });

  it('gate: stale store (null) falls back to the live gate unchanged', () => {
    const live = vi.fn(() => ({ allowed: false, reason: 'live' }));
    expect(readReviewCiGateFactsFirst({ policy: { startAfter: 'ci-green', startEarly: 'off' }, repo: 'o/r', pr: 7, lookup: hit(null), live })).toEqual({ allowed: false, reason: 'live' });
    expect(live).toHaveBeenCalledTimes(1);
  });

  it('gate: a required check missing from the store (partial) re-reads GitHub, never refuses from the store', () => {
    const live = vi.fn(() => ({ allowed: true, reason: 'live-ok' }));
    const r = readReviewCiGateFactsFirst({ policy: { startAfter: 'ci-green', startEarly: 'off' }, repo: 'o/r', pr: 7, lookup: hit(facts()), live, liveHead: () => 'abc', readRequired: required(['test', 'legacy-status']) });
    expect(live).toHaveBeenCalledTimes(1);
    expect(r.reason).toBe('live-ok');
  });

  it('gate: completed-only store cannot attest failure either; live refusal remains authoritative', () => {
    const liveResult = { allowed: false, reason: 'required-checks-not-successful', affected: [{ name: 'test', reason: 'failure' }] };
    const live = vi.fn(() => liveResult);
    const f = facts({ checks: [{ name: 'test', app: 'gha', conclusion: 'failure' }] });
    const r = readReviewCiGateFactsFirst({ policy: { startAfter: 'ci-green', startEarly: 'off' }, repo: 'o/r', pr: 7, lookup: hit(f), live, liveHead: () => 'abc', readRequired: required() });
    expect(r).toBe(liveResult);
    expect(live).toHaveBeenCalledTimes(1);
  });

  it('gate: head moved since the store was folded is not a trusted store refusal', () => {
    const live = vi.fn(() => ({ allowed: false, reason: 'live' }));
    readReviewCiGateFactsFirst({ policy: { startAfter: 'ci-green', startEarly: 'off' }, repo: 'o/r', pr: 7, lookup: hit(facts()), live, liveHead: () => 'zzz', readRequired: required() });
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
