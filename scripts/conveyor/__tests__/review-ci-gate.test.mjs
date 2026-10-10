import { describe, it, expect } from 'vitest';
import { ciGateForReview, resolveReviewCiGate, inheritedProceedWhy } from '../review-ci-gate.mjs';
import { planReconcile } from '../reconcile-core.mjs';

// Live 2026-10-10 ~20:00Z: main red since 18:44Z on this one test; #4708/#4715/#4786/#4805 failed only on it.
const MAIN_TEST = 'scripts/operations/__tests__/record-referral-ruling.test.mjs > #4979 the sanctioned writer';
const MAIN_SHA = 'c0ffee1234567890c0ffee1234567890c0ffee12';
const mainRed = { status: 'red', sha: MAIN_SHA, failing: { jobs: ['test (2)', 'test'], tests: [MAIN_TEST] } };
const required = [{ name: 'test', reason: 'failure' }];
const inheritedPr = { complete: true, failed: [{ name: 'test', tests: [] }, { name: 'test (2)', tests: [MAIN_TEST] }] };

describe('ciGateForReview — review ignores CI failures inherited from main red', () => {
  it('proceeds when every failing job + test is main\'s current red (summary job judged by its shard)', () => {
    const g = ciGateForReview({ prChecks: { ...inheritedPr, required }, mainRed });
    expect(g).toMatchObject({ proceed: true, reason: 'inherited-main-red', own: [], inherited: [{ job: 'test (2)', tests: [MAIN_TEST] }] });
    expect(inheritedProceedWhy(g)).toMatch(/^proceeding: CI failures inherited from main red @c0ffee123/);
  });

  it('waits on ANY own failure: an extra test in the same job', () => {
    const g = ciGateForReview({ prChecks: { required, complete: true, failed: [{ name: 'test (2)', tests: [MAIN_TEST, 'my own broken test'] }] }, mainRed });
    expect(g).toMatchObject({ proceed: false, reason: 'own-failure', own: [{ job: 'test (2)', tests: ['my own broken test'] }] });
  });

  it('waits on a failing job main does not fail', () => {
    const g = ciGateForReview({ prChecks: { required, complete: true, failed: [{ name: 'test (2)', tests: [MAIN_TEST] }, { name: 'soak (1)', tests: ['x'] }] }, mainRed });
    expect(g).toMatchObject({ proceed: false, reason: 'own-failure' });
    expect(g.own.map((o) => o.job)).toEqual(['soak (1)']);
  });

  it('fails closed on unknown or incomplete state', () => {
    const pr = { ...inheritedPr, required };
    expect(ciGateForReview({ prChecks: pr, mainRed: null }).reason).toBe('main-not-red');
    expect(ciGateForReview({ prChecks: pr, mainRed: { status: 'unknown' } }).proceed).toBe(false);
    expect(ciGateForReview({ prChecks: pr, mainRed: { ...mainRed, failing: { jobs: [], tests: [] } } }).reason).toBe('main-red-unknown');
    expect(ciGateForReview({ prChecks: { ...pr, complete: false }, mainRed }).reason).toBe('pr-ci-unknown');
    expect(ciGateForReview({ prChecks: { ...pr, required: [{ name: 'test', reason: 'pending' }] }, mainRed }).reason).toBe('pr-ci-incomplete');
    expect(ciGateForReview({ prChecks: { ...pr, required: [...required, { name: 'review-gate', reason: 'failure' }] }, mainRed }).proceed).toBe(false);
    expect(ciGateForReview({ prChecks: { required, complete: true, failed: [{ name: 'test (2)', tests: null }] }, mainRed }).reason).toBe('own-failure');
    expect(ciGateForReview({ prChecks: { required, complete: true, failed: [{ name: 'test (2)', tests: [] }] }, mainRed }).proceed).toBe(false);
    expect(ciGateForReview({ prChecks: { required, complete: true, failed: [{ name: 'test', tests: [] }] }, mainRed }).reason).toBe('pr-ci-unknown');
  });

  it('green-only setting restores the old behaviour', () => {
    expect(ciGateForReview({ prChecks: { ...inheritedPr, required }, mainRed, setting: 'green-only' }).reason).toBe('setting-green-only');
  });
});

describe('resolveReviewCiGate — cascade with source', () => {
  it('default, then platform → repo → env; invalid layers skipped', () => {
    expect(resolveReviewCiGate()).toEqual({ value: 'ignore-inherited-main-red', source: 'standard' });
    expect(resolveReviewCiGate({ platform: { review: { ciGate: 'green-only' } } })).toEqual({ value: 'green-only', source: 'platform' });
    expect(resolveReviewCiGate({ platform: { review: { ciGate: 'green-only' } }, repo: { ciGate: 'ignore-inherited-main-red' } }).source).toBe('repo');
    expect(resolveReviewCiGate({ repo: { ciGate: 'bogus' }, env: { WE_REVIEW_CI_GATE: 'green-only' } })).toEqual({ value: 'green-only', source: 'env' });
  });
});

describe('reconcile-core review dispatch honours inherited main red (live #4708 shape)', () => {
  const NOW = Date.parse('2026-10-10T20:00:00Z');
  const pr = (over = {}) => ({
    number: 4708, state: 'OPEN', headRefName: 'lane/x', headRefOid: 'aa11bb22cc33dd44ee55ff6677889900aabbccdd',
    labels: [{ name: 'review:pending' }, { name: 'ci:failed' }], mergeStateStatus: 'CLEAN', comments: [],
    statusCheckRollup: [{ name: 'test', status: 'completed', conclusion: 'failure' }],
    requiredCheckCompletedAt: '2026-10-10T19:30:00Z', aheadByOnMain: 3, requiredCheckName: 'test',
    ...over,
  });
  const facts = (prChecks = inheritedPr, setting = 'ignore-inherited-main-red') => ({ reviewCiInheritance: { prChecks, mainRed, setting, settingSource: 'standard' } });
  const MAIN_RED_WINDOWS = [{ start: '2026-10-10T18:44:00Z', end: null }];
  const plan = (p) => planReconcile({ requiredChecks: ['test'], prs: [p], agents: [], now: NOW, mainRedWindows: MAIN_RED_WINDOWS });
  const reviews = (pl) => pl.dispatch.filter((d) => d.kind === 'review');

  it('before: without inheritance facts the review waits on review-ci (owed-ci-rerun row keeps it)', () => {
    const pl = plan(pr());
    expect(reviews(pl)).toEqual([]);
    expect(pl.refusals).toEqual([expect.objectContaining({ kind: 'owed-ci-rerun', reviewRefusal: expect.objectContaining({ kind: 'review-ci' }) })]);
  });

  it('after: inherited-only red dispatches the review, logging the main sha', () => {
    const pl = plan(pr(facts()));
    expect(pl.refusals).toEqual([expect.objectContaining({ kind: 'owed-ci-rerun' })]); // rerun ownership (merge side) intact
    expect(reviews(pl)).toEqual([expect.objectContaining({ prNumber: 4708, owedCiRerun: true, ciInherited: expect.objectContaining({ why: expect.stringMatching(/proceeding: CI failures inherited from main red @c0ffee123/) }) })]);
  });

  it('a PR with its own failure still waits', () => {
    const pl = plan(pr(facts({ complete: true, failed: [{ name: 'test (2)', tests: [MAIN_TEST, 'own'] }] })));
    expect(reviews(pl)).toEqual([]);
  });

  it('green-only setting keeps the review waiting', () => {
    expect(reviews(plan(pr(facts(inheritedPr, 'green-only'))))).toEqual([]);
  });
});
