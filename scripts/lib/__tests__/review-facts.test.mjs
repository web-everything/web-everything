// @vitest-environment node
/** perf C1c — the review daemon reads PR facts first; stale/partial store falls back to GitHub; never a write/merge input. */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookupReviewFacts, readReviewCiGateFactsFirst, withFactsLabels, reviewFactsEnabled } from '../review-facts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const facts = (o = {}) => ({ repo: 'o/r', number: 7, headSha: 'a'.repeat(40), state: 'open', draft: false, labels: ['review:pending'],
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

  it('gate: green store hit falls back live because completed runs cannot prove completeness', () => {
    const liveHead = vi.fn(() => 'a'.repeat(40));
    const live = vi.fn(() => ({ allowed: true, headSha: 'a'.repeat(40), reason: 'live-ok' }));
    const r = readReviewCiGateFactsFirst({ policy: { startAfter: 'ci-green', startEarly: 'off' }, repo: 'o/r', pr: 7, lookup: hit(facts()), live, liveHead, readRequired: required() });
    expect(r).toMatchObject({ allowed: true, headSha: 'a'.repeat(40), reason: 'live-ok' });
    expect(liveHead).toHaveBeenCalledTimes(1);
    expect(live).toHaveBeenCalledTimes(1);
  });

  it('count: a 10-PR tick makes 40 gate gh calls on the old path (2 heads + check-runs + status) and 50 on facts-first (store head verification plus live fallback)', async () => {
    const { readReviewCiGate } = await import('./helpers/review-checks.mjs');
    let calls = 0;
    const readHead = () => { calls += 1; return 'a'.repeat(40); };
    const readChecks = () => { calls += 2; return [{ name: 'test', status: 'completed', conclusion: 'success', head_sha: 'a'.repeat(40) }]; }; // check-runs + status
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
    const r = readReviewCiGateFactsFirst({ policy: { startAfter: 'ci-green', startEarly: 'off' }, repo: 'o/r', pr: 7, lookup: hit(facts()), live, liveHead: () => 'a'.repeat(40), readRequired: required(['test', 'legacy-status']) });
    expect(live).toHaveBeenCalledTimes(1);
    expect(r.reason).toBe('live-ok');
  });

  it('gate: a completed failure is trusted despite the incomplete store feed (no live gate)', () => {
    const live = vi.fn(() => ({ allowed: true, headSha: 'a'.repeat(40), reason: 'live-ok' }));
    const f = facts({ checks: [{ name: 'test', app: 'gha', conclusion: 'failure' }] });
    const r = readReviewCiGateFactsFirst({ policy: { startAfter: 'ci-green', startEarly: 'off' }, repo: 'o/r', pr: 7, lookup: hit(f), live, liveHead: () => 'a'.repeat(40), readRequired: required() });
    expect(r).toMatchObject({ allowed: false, reason: 'required-checks-not-successful', factsSource: 'store' });
    expect(live).not.toHaveBeenCalled();
  });

  it.each([
    ['pending', [{ name: 'test', conclusion: null }]],
    ['missing', []],
    ['malformed', [{ name: '', conclusion: 'failure' }]],
    ['unknown conclusion', [{ name: 'test', conclusion: 'unrecognized' }]],
  ])('gate: %s store evidence falls back live', (_kind, checks) => {
    const live = vi.fn(() => ({ allowed: false, reason: 'live-refusal' }));
    expect(readReviewCiGateFactsFirst({ policy: { startAfter: 'ci-green', startEarly: 'off' },
      repo: 'o/r', pr: 7, lookup: hit(facts({ checks })), live, liveHead: () => 'a'.repeat(40),
      readRequired: required() })).toEqual({ allowed: false, reason: 'live-refusal' });
    expect(live).toHaveBeenCalledTimes(1);
  });

  it('gate: a completed failure beside a missing required status still falls back live', () => {
    const live = vi.fn(() => ({ allowed: false, reason: 'live-refusal' }));
    readReviewCiGateFactsFirst({ policy: { startAfter: 'ci-green', startEarly: 'off' },
      repo: 'o/r', pr: 7, lookup: hit(facts({ checks: [{ name: 'test', conclusion: 'failure' }] })),
      live, liveHead: () => 'a'.repeat(40), readRequired: required(['test', 'legacy-status']) });
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
