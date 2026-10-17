import { describe, it, expect } from 'vitest';
import { REVIEW_TIMING_DEFAULTS as review, FIX_TIMING_DEFAULTS as fix,
  reviewStartGate, reviewMustVoid, rereviewMode, joinedFixDecision, fixReadiness } from '../review-timing.mjs';
import { resolveTimingPolicy } from '../review-timing-settings.mjs';
const head = 'a'.repeat(40);
const check = (name, conclusion = 'success', extra = {}) => ({ name, head_sha: head, status: 'completed', conclusion, ...extra });
describe('parallel review start and void', () => {
  it('starts after only fast checks, with full CI still pending', () => {
    const checks = [...review.fastChecks.map(n => check(n)), check('integration', null, { status: 'in_progress' })];
    expect(reviewStartGate({ headSha: head, checks, requiredChecks: ['integration'] }).allowed).toBe(true);
    expect(reviewStartGate({ headSha: head, checks, requiredChecks: ['integration'], policy: { ...review, startAfter: 'ci-green' } }).allowed).toBe(false);
    expect(reviewStartGate({ headSha: head, checks: [], policy: { ...review, startAfter: 'push' } }).allowed).toBe(true);
  });
  it('requires each fast check on the head and refuses a red non-fast check', () => {
    for (const checks of [[], [check('standards')], review.fastChecks.map(n => check(n, 'success', { head_sha: 'b'.repeat(40) })),
      [...review.fastChecks.map(n => check(n)), check('integration', 'failure')]])
      expect(reviewStartGate({ headSha: head, checks, requiredChecks: ['integration'] }).allowed).toBe(false);
  });
  it('voids red-head and superseded reviews while excluding the review-dependent gates', () => {
    const args = { reviewedHead: head, currentHead: head, checks: [check('integration', 'failure')] };
    expect(reviewMustVoid(args)).toBe(false);
    expect(reviewMustVoid({ ...args, policy: { ...review, cancelOnCiRed: true } })).toBe(true);
    expect(reviewMustVoid({ ...args, policy: { ...review, cancelOnCiRed: false } })).toBe(false);
    expect(reviewMustVoid({ ...args, currentHead: 'b'.repeat(40), policy: { ...review, cancelOnCiRed: false } })).toBe(true);
    expect(reviewMustVoid({ ...args, checks: [check('review-gate', 'failure'), check('merge-gate', 'failure')], policy: { ...review, cancelOnCiRed: true } })).toBe(false);
  });
  it.each(['fast-checks', 'push'])('ignores optional red checks under %s but blocks healable required failures', startAfter => {
    const checks = [...review.fastChecks.map(n => check(n)), check('CodeQL', 'failure')];
    const args = { headSha: head, checks, requiredChecks: ['integration'], policy: { ...review, startAfter } };
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
});
it('resolves every timing leaf through the cascade, logging sources and rejecting malformed overrides', () => {
  const result = resolveTimingPolicy({ env: { WE_REVIEW_DELTA_MAX_LINES: '12', WE_FIX_JOIN_CI_AND_REVIEW: 'false' },
    review: { deltaMaxFiles: 2, cancelOnCiRed: 'bad' }, fix: {}, platformReview: { cancelOnCiRed: false }, platformFix: { joinWaitMaxMin: 7 } });
  expect(result.review).toMatchObject({ startAfter: 'fast-checks', deltaMaxLines: 12, deltaMaxFiles: 2, cancelOnCiRed: false });
  expect(result.fix).toEqual({ joinCiAndReview: false, joinWaitMaxMin: 7 });
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
