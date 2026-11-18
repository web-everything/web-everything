// @vitest-environment node
/** perf C1c — the review daemon reads PR facts first; stale/partial store falls back to GitHub; never a write/merge input. */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookupReviewFacts, readReviewCiGateFactsFirst, withFactsLabels, reviewFactsEnabled } from '../review-facts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HEAD = 'a'.repeat(40);
const facts = (o = {}) => ({ repo: 'o/r', number: 7, headSha: HEAD, state: 'open', draft: false, labels: ['review:pending'],
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

  it('gate: green store rows without completeness proof require one live recheck', () => {
    const liveHead = vi.fn(() => HEAD);
    const live = vi.fn(() => ({ allowed: true, headSha: HEAD, reason: 'live-success' }));
    const r = readReviewCiGateFactsFirst({ policy: { startAfter: 'ci-green', startEarly: 'off' }, repo: 'o/r', pr: 7, lookup: hit(facts()), live, liveHead, readRequired: required() });
    expect(r).toEqual({ allowed: true, headSha: HEAD, reason: 'live-success' });
    expect(liveHead).toHaveBeenCalledTimes(1);
    expect(live).toHaveBeenCalledTimes(1);
  });

  it('count: ten incomplete store snapshots each recheck the head and the complete live feed', async () => {
    const { readReviewCiGate } = await import('../review-ci-gate-io.mjs');
    let calls = 0;
    const readHead = () => { calls += 1; return HEAD; };
    const readChecks = () => { calls += 2; return Object.defineProperty([{ name: 'test', status: 'completed', conclusion: 'success', head_sha: HEAD }], 'rowsComplete', { value: true }); }; // check-runs + status
    for (let pr = 1; pr <= 10; pr += 1) readReviewCiGate({ policy: { startAfter: 'ci-green', startEarly: 'off' }, repo: 'o/r', pr, readHead, readChecks, readRequired: required() });
    const before = calls;
    calls = 0;
    const live = vi.fn(args => readReviewCiGate({ ...args, readHead, readChecks }));
    for (let pr = 1; pr <= 10; pr += 1) {
      expect(readReviewCiGateFactsFirst({ policy: { startAfter: 'ci-green', startEarly: 'off' }, repo: 'o/r', pr, lookup: hit(facts()), live, liveHead: readHead, readRequired: required() }).allowed).toBe(true);
    }
    expect({ before, after: calls }).toEqual({ before: 40, after: 50 });
    expect(live).toHaveBeenCalledTimes(10);
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

  it('gate: a completed failure without completeness proof requires a live recheck', () => {
    const live = vi.fn(() => ({ allowed: false, reason: 'live-failure' }));
    const f = facts({ checks: [{ name: 'test', app: 'gha', conclusion: 'failure' }] });
    const r = readReviewCiGateFactsFirst({ policy: { startAfter: 'ci-green', startEarly: 'off' }, repo: 'o/r', pr: 7, lookup: hit(f), live, liveHead: () => HEAD, readRequired: required() });
    expect(r).toEqual({ allowed: false, reason: 'live-failure' });
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
