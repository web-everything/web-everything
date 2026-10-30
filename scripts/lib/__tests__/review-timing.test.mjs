import { describe, it, expect } from 'vitest';
import { REVIEW_TIMING_DEFAULTS as review, FIX_TIMING_DEFAULTS as fix,
  fixPushGate, reviewStartGate, reviewMustVoid, rereviewMode, joinedFixDecision, fixReadiness, fastChecksFor, NON_HEALABLE_CHECKS, ciRedOnHead } from '../review-timing.mjs';
import { CI_TRUTH_EXCLUDED_CHECKS } from '../../operations/pr-status.mjs';
import { resolveTimingPolicy } from '../review-timing-settings.mjs';
const head = 'a'.repeat(40);
const check = (name, conclusion = 'success', extra = {}) => ({ name, head_sha: head, status: 'completed', conclusion, ...extra });
const fast = review.fastChecks.we;
describe('parallel review start and void', () => {
  it('starts after only fast checks, with full CI still pending', () => {
    const checks = [...fast.map(n => check(n)), check('integration', null, { status: 'in_progress' })];
    expect(reviewStartGate({ headSha: head, repo: 'we', checks, requiredChecks: ['integration'] }).allowed).toBe(true);
    expect(reviewStartGate({ headSha: head, repo: 'we', checks, requiredChecks: ['integration'], policy: { ...review, startAfter: 'ci-green' } }).allowed).toBe(false);
    expect(reviewStartGate({ headSha: head, checks: [], policy: { ...review, startAfter: 'push' } }).allowed).toBe(true);
  });
  it('requires each fast check on the head and refuses a red non-fast check', () => {
    for (const checks of [[], [check('standards')], fast.map(n => check(n, 'success', { head_sha: 'b'.repeat(40) })),
      [...fast.map(n => check(n)), check('integration', 'failure')]])
      expect(reviewStartGate({ headSha: head, repo: 'we', checks, requiredChecks: ['integration'] }).allowed).toBe(false);
  });
  it('a repo whose CI publishes no fast checks waits on its own required checks', () => {
    expect(fastChecksFor(review.fastChecks, 'web-everything/web-everything')).toEqual(fast);
    for (const [repo, required] of [['frontierui', ['test']], ['plateauapp/plateau-app', ['test', 'e2e']], [undefined, ['test']]]) {
      expect(fastChecksFor(review.fastChecks, repo)).toBeNull();
      expect(reviewStartGate({ headSha: head, repo, checks: required.map(n => check(n)), requiredChecks: required }).allowed).toBe(true);
      expect(reviewStartGate({ headSha: head, repo, checks: [check('test', null, { status: 'in_progress' }), check('e2e')], requiredChecks: required }))
        .toMatchObject({ allowed: false, reason: 'required-checks-not-successful' });
    }
    // An explicit list still applies to every repo.
    expect(fastChecksFor(['lint'], 'frontierui')).toEqual(['lint']);
  });
  it('accepts only a name list or a map of known repos to name lists', () => {
    const resolve = value => resolveTimingPolicy({ env: { WE_REVIEW_FAST_CHECKS: JSON.stringify(value) }, read: () => '{}', review: {}, fix: {},
      platformReview: {}, platformFix: {}, log: () => {} }).review.fastChecks;
    expect(resolve({ frontierui: ['test'] })).toEqual({ frontierui: ['test'] });
    expect(resolve({ 'Web-Everything/Web-Everything': ['standards'] })).toEqual({ we: ['standards'] });
    expect(resolve(['lint'])).toEqual({ we: ['lint'], frontierui: ['lint'], 'plateau-app': ['lint'] });
    for (const bad of [{ nope: ['x'] }, { we: [] }, {}, []]) expect(resolve(bad)).toEqual(review.fastChecks);
  });
  it('merges fastChecks per repo across layers, so a lower-layer list never overrides a higher-layer repo entry', () => {
    const resolve = (platform, tool) => resolveTimingPolicy({ env: {}, read: () => '{}', fix: {}, platformFix: {}, log: () => {},
      platformReview: { fastChecks: platform }, review: { fastChecks: tool } }).review.fastChecks;
    const merged = resolve(['lint'], { we: ['x'] });
    expect([fastChecksFor(merged, 'we'), fastChecksFor(merged, 'frontierui')]).toEqual([['x'], ['lint']]);
    const kept = resolve(['lint'], { 'frontier-ui/frontierui': ['test'] });
    expect([fastChecksFor(kept, 'web-everything/web-everything'), fastChecksFor(kept, 'frontierui')]).toEqual([['lint'], ['test']]);
  });
  it('voids red-head and superseded reviews while excluding the review-dependent gates', () => {
    const args = { reviewedHead: head, currentHead: head, checks: [check('integration', 'failure')] };
    expect(reviewMustVoid(args)).toBe(false);
    expect(reviewMustVoid({ ...args, policy: { ...review, cancelOnCiRed: true } })).toBe(true);
    expect(reviewMustVoid({ ...args, policy: { ...review, cancelOnCiRed: false } })).toBe(false);
    expect(reviewMustVoid({ ...args, currentHead: 'b'.repeat(40), policy: { ...review, cancelOnCiRed: false } })).toBe(true);
    expect(reviewMustVoid({ ...args, checks: [check('review-gate', 'failure'), check('merge-gate', 'failure')], policy: { ...review, cancelOnCiRed: true } })).toBe(false);
  });
  it('cancellation voids only for a healable red: an optional check never voids a finished review', () => {
    const cancel = { ...review, cancelOnCiRed: true };
    const args = { reviewedHead: head, currentHead: head, policy: cancel, requiredChecks: ['integration'] };
    expect(reviewMustVoid({ ...args, checks: [check('CodeQL', 'failure'), check('integration')] })).toBe(false);
    expect(reviewMustVoid({ ...args, checks: [check('integration', 'failure')] })).toBe(true);
    // Unknown set: the CI-heal rule — soak-replay-gate is never healable, any other red is.
    expect(reviewMustVoid({ ...args, requiredChecks: null, checks: [check('soak-replay-gate', 'failure')] })).toBe(false);
    expect(reviewMustVoid({ ...args, requiredChecks: null, checks: [check('CodeQL', 'failure')] })).toBe(true);
  });
  it.each([
    ['review-gate red', [check('review-gate', 'failure')], false],
    ['merge-gate red on a review hold', [check('merge-gate', 'failure', { mergeGateReviewHold: { holds: ['review-gate'], jobId: 1 } })], false],
    ['plain merge-gate red', [check('merge-gate', 'failure')], true],
  ])('required %s: healable=%s, the same rule the CI heal uses (#5463)', (_name, rows, healable) => {
    const requiredChecks = ['test', 'review-gate', 'merge-gate'];
    const checks = [...rows, check('test'), ...fast.map(n => check(n))];
    expect(ciRedOnHead({ headSha: head, checks, requiredChecks })).toBe(healable);
    expect(fixReadiness({ headSha: head, checks, requiredChecks }).ciFailed).toBe(healable);
    for (const startAfter of ['fast-checks', 'push'])
      expect(reviewStartGate({ headSha: head, repo: 'we', checks, requiredChecks, policy: { ...review, startAfter } }).allowed).toBe(!healable);
    expect(reviewMustVoid({ reviewedHead: head, currentHead: head, checks, requiredChecks, policy: { ...review, cancelOnCiRed: true } })).toBe(healable);
  });
  it('a review-dependent gate is never healable red, even when branch protection requires it', () => {
    const requiredChecks = ['test', 'review-gate', 'merge-gate'];
    const gates = [check('review-gate', 'failure'), check('merge-gate', 'failure', { mergeGateReviewHold: { holds: ['review-gate'], jobId: 1 } }), check('test')];
    expect(ciRedOnHead({ headSha: head, checks: gates, requiredChecks })).toBe(false);
    expect(fixReadiness({ headSha: head, checks: gates, requiredChecks }).ciFailed).toBe(false);
    for (const startAfter of ['fast-checks', 'push'])
      expect(reviewStartGate({ headSha: head, repo: 'we', checks: [...gates, ...fast.map(n => check(n))], requiredChecks,
        policy: { ...review, startAfter } }).allowed).toBe(true);
    expect(reviewMustVoid({ reviewedHead: head, currentHead: head, checks: gates, requiredChecks, policy: { ...review, cancelOnCiRed: true } })).toBe(false);
    // A required non-gate red still counts.
    expect(ciRedOnHead({ headSha: head, checks: [...gates, check('test', 'failure')], requiredChecks })).toBe(true);
  });
  it('the non-healable list covers the CI-truth exclusions the heal path uses', () => {
    for (const name of CI_TRUTH_EXCLUDED_CHECKS) expect(NON_HEALABLE_CHECKS).toContain(name);
    expect(fixReadiness({ headSha: head, checks: [check('soak-replay-gate', 'failure')] }).ciFailures).toEqual([]);
  });
  it.each(['fast-checks', 'push'])('ignores optional red checks under %s but blocks healable required failures', startAfter => {
    const checks = [...fast.map(n => check(n)), check('CodeQL', 'failure')];
    const args = { headSha: head, repo: 'we', checks, requiredChecks: ['integration'], policy: { ...review, startAfter } };
    expect(reviewStartGate(args).allowed).toBe(true);
    expect(reviewStartGate({ ...args, checks: [...checks, check('integration', 'failure')] })).toMatchObject({ allowed: false, reason: 'ci-red' });
  });
  it('push ignores optional failures even when their names are configured as fast checks', () => {
    expect(reviewStartGate({ headSha: head, checks: [check('standards', 'failure'), check('integration')],
      requiredChecks: ['integration'], policy: { ...review, startAfter: 'push' } }).allowed).toBe(true);
  });
});
describe('delta review and mechanical carry', () => {
  const args = { priorHead: 'b'.repeat(40), head, lines: 50, files: 3 };
  it('uses inclusive limits and fails to full on unknown/binary or oversized deltas', () => {
    expect(rereviewMode(args)).toBe('delta');
    for (const over of [{ lines: 51 }, { files: 4 }, { lines: NaN }, { priorHead: null }, { lines: -1 }])
      expect(rereviewMode({ ...args, ...over })).toBe('full');
  });
  it('carries proved mechanical changes regardless of size, unless disabled', () => {
    expect(rereviewMode({ ...args, lines: 100, mechanical: true })).toBe('carry');
    expect(rereviewMode({ ...args, lines: 100, mechanical: true, policy: { ...review, skipDrainMechanical: false } })).toBe('full');
  });
});
describe('joined fix round', () => {
  const args = { ciFailed: true, firstReadyAt: 1000, otherPending: true, now: 1000 };
  it('waits within cap, dispatches at the cap, and immediately joins both inputs', () => {
    expect(joinedFixDecision(args)).toEqual({ action: 'wait', deadline: 901000 });
    expect(joinedFixDecision({ ...args, now: 901000 })).toEqual({ action: 'dispatch', joined: false });
    expect(joinedFixDecision({ ...args, reviewFindings: true })).toEqual({ action: 'dispatch', joined: true });
    expect(joinedFixDecision({ ...args, policy: { ...fix, joinCiAndReview: false } })).toEqual({ action: 'dispatch', joined: false });
    expect(joinedFixDecision({ ...args, otherPending: false }).action).toBe('dispatch');
  });
  it('waits symmetrically for CI after findings, uses immutable result timestamps, ignores foreign-head CI', () => {
    const facts = fixReadiness({ headSha: head, checks: [check('unit', null, { status: 'in_progress' })], findings: [{ body: 'fix', createdAt: new Date(1000).toISOString() }] });
    expect(joinedFixDecision({ ...facts, now: 2000 }).action).toBe('wait');
    expect(fixReadiness({ headSha: head, checks: [check('unit', 'failure', { head_sha: 'b' })] }).ciFailed).toBe(false);
    expect(joinedFixDecision({ ...args, firstReadyAt: NaN }).action).toBe('dispatch');
  });
  it('counts only required failures when the required set is known', () => {
    const checks = [check('CodeQL', 'failure'), check('unit')];
    expect(fixReadiness({ headSha: head, checks, requiredChecks: ['unit'] })).toMatchObject({ ciFailed: false, ciFailures: [] });
    expect(fixReadiness({ headSha: head, checks: [...checks, check('unit', 'failure')], requiredChecks: ['unit'] }).ciFailures.map(r => r.name)).toEqual(['unit']);
    expect(fixReadiness({ headSha: head, checks }).ciFailed).toBe(true); // unknown set keeps the old reading
  });
});
it('resolves every timing leaf through the cascade, logging sources and rejecting malformed overrides', () => {
  const result = resolveTimingPolicy({ env: { WE_REVIEW_DELTA_MAX_LINES: '12', WE_FIX_JOIN_CI_AND_REVIEW: 'false' },
    review: { deltaMaxFiles: 2, cancelOnCiRed: 'bad' }, fix: {}, platformReview: { cancelOnCiRed: false }, platformFix: { joinWaitMaxMin: 7 } });
  expect(result.review).toMatchObject({ startAfter: 'fast-checks', deltaMaxLines: 12, deltaMaxFiles: 2, cancelOnCiRed: false });
  expect(result.fix).toEqual({ joinCiAndReview: false, joinWaitMaxMin: 7, pushAfterCi: false, pushAfterCiMaxMin: 30 });
  expect(result.sources.review).toMatchObject({ startAfter: 'standard', deltaMaxLines: 'env', deltaMaxFiles: 'tool', cancelOnCiRed: 'platform' });
});
it('logs each timing setting with its effective source, including enabled defaults', () => {
  const logs = [];
  resolveTimingPolicy({ env: { WE_POLICY_CASCADE_LOG: '1' }, read: () => '{}', review: {}, fix: {}, platformReview: {}, platformFix: {}, log: line => logs.push(line) });
  expect(logs.join('\n')).toContain('startAfter="fast-checks" (standard)');
  expect(logs.join('\n')).toContain('cancelOnCiRed=false (standard)');
  expect(logs.join('\n')).toContain('skipDrainMechanical=true (standard)');
  expect(logs.join('\n')).toContain('joinCiAndReview=true (standard)');
  expect(logs.join('\n')).toContain('joinWaitMaxMin=15 (standard)');
});

describe('verified early review', () => {
  it.each(['fast-checks', 'ci-green'])('starts with an exact-head verification under %s', startAfter => {
    const args = { headSha: head, checks: [], requiredChecks: ['test'], verifyGreen: true,
      policy: { ...review, startAfter, startBeforeCi: true } };
    expect(reviewStartGate(args)).toMatchObject({ allowed: true, reason: 'verify-marker' });
    for (const verifyGreen of [false, undefined, 'true'])
      expect(reviewStartGate({ ...args, verifyGreen }).allowed).toBe(false);
    expect(reviewStartGate({ ...args, headSha: null }).allowed).toBe(false);
    expect(reviewStartGate({ ...args, policy: { ...args.policy, startBeforeCi: false } }).allowed).toBe(false);
    expect(reviewStartGate({ ...args, checks: [check('test', 'failure')] })).toMatchObject({ allowed: false, reason: 'ci-red' });
    // Unknown required set: a red check still blocks the marker path.
    expect(reviewStartGate({ ...args, requiredChecks: [], checks: [check('test', 'failure')] })).toMatchObject({ allowed: false, reason: 'ci-red' });
  });
});
describe('fix push gate', () => {
  const policy = { ...fix, pushAfterCi: true, pushAfterCiMaxMin: 1 };
  const args = { previousHeadChecks: [check('test', null, { status: 'in_progress' })], requiredChecks: ['test'], firstHeldAt: 1000, now: 1000, policy };
  it('is immediate when off, waits with a fixed deadline when on, and pushes at the bound', () => {
    expect(fixPushGate({ ...args, policy: fix })).toEqual({ action: 'push', reason: 'off' });
    expect(fixPushGate(args)).toEqual({ action: 'wait', reason: 'ci-pending', deadline: 61000 });
    expect(fixPushGate({ ...args, now: 61000 })).toMatchObject({ action: 'push', reason: 'bound' });
  });
  it('folds completed required failures and ignores pending optional checks', () => {
    expect(fixPushGate({ ...args, previousHeadChecks: [check('test', 'failure'), check('optional', null, { status: 'queued' })] }))
      .toMatchObject({ action: 'push', reason: 'ci-complete', ciFailures: [{ name: 'test', conclusion: 'failure' }] });
    expect(fixPushGate({ ...args, previousHeadChecks: [check('test')] })).toMatchObject({ action: 'push', reason: 'ci-complete', ciFailures: [] });
  });
  it.each([undefined, null, [], [{ name: 'test', status: 'completed', conclusion: null }]])('waits on missing or unreadable evidence: %j', previousHeadChecks => {
    expect(fixPushGate({ ...args, previousHeadChecks }).action).toBe('wait');
    expect(fixPushGate({ ...args, previousHeadChecks, now: 61000 }).reason).toBe('bound');
  });
});

it('push gating refuses unknown required evidence and waits for remaining required checks after a failure', () => {
  const args = { previousHeadChecks: [check('test')], firstHeldAt: 0, now: 0, policy: { ...fix, pushAfterCi: true } };
  for (const requiredChecks of [null, undefined, []]) expect(fixPushGate({ ...args, requiredChecks }).action).toBe('wait');
  expect(fixPushGate({ ...args, requiredChecks: ['test', 'smoke'], previousHeadChecks: [check('test', 'failure'), check('smoke', null, { status: 'queued' })] }).action).toBe('wait');
});
