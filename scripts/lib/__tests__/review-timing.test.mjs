import { describe, it, expect } from 'vitest';
import { REVIEW_TIMING_DEFAULTS as review, FIX_TIMING_DEFAULTS as fix,
  fixPushGate as rawfixPushGate, reviewStartGate as rawreviewStartGate, reviewMustVoid as rawreviewMustVoid, rereviewMode, joinedFixDecision, fixReadiness as rawfixReadiness, fastChecksFor, NON_HEALABLE_CHECKS, ciRedOnHead as rawciRedOnHead } from '../review-timing.mjs';
import * as reviewTiming from '../review-timing.mjs';
import { CI_TRUTH_EXCLUDED_CHECKS } from '../../operations/pr-status.mjs';
import { reviewCiGate as rawreviewCiGate } from '../review-ci-gate.mjs';
import { resolveTimingPolicy } from '../review-timing-settings.mjs';
import { resetCascadeLogForTest } from '../policy-cascade.mjs';
const head = 'a'.repeat(40);
const provenance = { rowsHead: head, rowsComplete: true, rosterSource: 'live' };
const fixPushGate = input => rawfixPushGate({ ...provenance, ...input });
const reviewStartGate = input => rawreviewStartGate({ ...provenance, ...input });
const reviewMustVoid = input => rawreviewMustVoid({ ...provenance, ...input });
const fixReadiness = input => rawfixReadiness({ ...provenance, ...input });
const ciRedOnHead = input => rawciRedOnHead({ ...provenance, ...input });
const reviewCiGate = input => rawreviewCiGate({ ...provenance, ...input });
const check = (name, conclusion = 'success', extra = {}) => ({ name, head_sha: head, status: 'completed', conclusion, ...extra });
const fast = review.fastChecks.we;
describe('pending-CI start policy', () => {
  it.each(['off', 'shadow', 'on'])('a green test aggregate never implies a missing integration or standards row, under startEarly=%s', startEarly => {
    const policy = { ...review, startAfter: 'fast-checks', startEarly, fastChecks: ['test', 'integration', 'standards'] };
    const result = reviewStartGate({ headSha: head, requiredChecks: ['test', 'integration'], checks: [check('test')], policy });
    expect(result.affected).toEqual([{ name: 'integration', reason: 'missing' }, { name: 'standards', reason: 'missing' }]);
  });
  // PR1 amendment: legacy statuses are valid evidence only for their own required context.
  describe.each(['ci-green', 'fast-checks', 'push'])('a green legacy status test cannot imply integration under startAfter=%s', startAfter => {
    const policy = startEarly => ({ ...review, startAfter, startEarly, fastChecks: ['test', 'integration'] });
    const requiredChecks = ['test', 'integration'];
    it.each([['shadow', 'success'], ['on', 'success'], ['shadow', 'SUCCESS'], ['on', 'SUCCESS']])('startEarly=%s state=%s', (startEarly, state) => {
      const checks = [{ context: 'test', state }];
      expect(reviewCiGate({ headSha: head, checks, requiredChecks })).toMatchObject({ allowed: false, affected: [{ name: 'integration', reason: 'missing' }] });
      expect(reviewStartGate({ headSha: head, requiredChecks, checks, policy: policy(startEarly) })).toMatchObject({ allowed: false, affected: [{ name: 'integration', reason: 'missing' }] });
    });
    it.each(['pending', 'failure', 'error'])('a %s legacy status implies nothing', state => {
      const result = reviewStartGate({ headSha: head, requiredChecks, checks: [{ context: 'test', state }], policy: policy('shadow') });
      expect(result.allowed).toBe(false);
    });
    it.each(['shadow', 'on'])('a status row carrying status:null is not normalized, as in the strict gate (startEarly=%s)', startEarly => {
      const checks = [{ context: 'test', state: 'success', status: null }];
      expect(reviewCiGate({ headSha: head, checks, requiredChecks }).allowed).toBe(false);
      expect(reviewStartGate({ headSha: head, requiredChecks, checks, policy: policy(startEarly) }).allowed).toBe(false);
    });
    // Self-review on 9d3b3764: a contradictory aggregate (`state` red/pending, `conclusion: success`) is NOT green to
    // the strict gate (its `state` wins), so it must not imply integration in the registration gate either.
    it.each([['failure', 'shadow'], ['error', 'on'], ['pending', 'shadow'], ['FAILURE', 'on']])(
      'a contradictory status (state=%s, conclusion=success) implies nothing (startEarly=%s)', (state, startEarly) => {
        const checks = [{ context: 'test', state, conclusion: 'success' }];
        expect(reviewCiGate({ headSha: head, checks, requiredChecks: ['integration'] }).allowed).toBe(false);
        expect(reviewStartGate({ headSha: head, requiredChecks: ['integration'], checks, policy: policy(startEarly) }).allowed).toBe(false);
      });
  });
  it('off preserves the exact pre-early-start ci-green refusal for completed red CI', () => {
    expect(reviewStartGate({ headSha: head, requiredChecks: ['test'], checks: [check('test', 'failure')],
      policy: { ...review, startAfter: 'ci-green', startEarly: 'off' } })).toEqual({ allowed: false,
      headSha: head, reason: 'required-checks-not-successful', affected: [{ name: 'test', reason: 'failure' }] });
  });
  it('off fails closed visibly when the required roster is unknown', () => {
    expect(reviewStartGate({ headSha: head, checks: [check('test', 'failure')],
      policy: { ...review, startAfter: 'fast-checks', fastChecks: ['test'], startEarly: 'off' } })).toEqual({
      allowed: false, headSha: head, reason: 'unknown-required-set', affected: [] });
  });
  it.each(['push', 'fast-checks', 'ci-green'])('requires every prerequisite registered on this head under %s', startAfter => {
    const names = ['standards', 'test'];
    for (const startEarly of ['on', 'shadow']) {
      const input = { headSha: head, requiredChecks: names, policy: { ...review, startAfter, startEarly, fastChecks: names } };
      for (const checks of [[check('unrelated', null, { status: 'queued' })], [check('test', null, { status: 'queued' })]]) {
        const result = reviewStartGate({ ...input, checks });
        expect(result).toMatchObject({ allowed: false, reason: 'ci-not-registered' });
        expect(result.affected).toContainEqual({ name: 'standards', reason: 'missing' });
        expect(result.earlyStartNote).toBeUndefined();
        expect(result.wouldStartEarly).not.toBe(true);
      }
      const checks = names.map(name => check(name, null, { status: 'queued' }));
      expect(reviewStartGate({ ...input, checks }).allowed).toBe(startAfter === 'push' || startEarly === 'on');
      expect(reviewStartGate({ ...input, checks: [check('standards', 'failure'), checks[1]] }))
        .toMatchObject({ allowed: false, reason: 'ci-red' });
      expect(reviewStartGate({ ...input, checks: [check('standards', 'success', { head_sha: 'b'.repeat(40) }), checks[1]] }).allowed).toBe(false);
      for (const conclusion of ['neutral', 'skipped']) expect(reviewStartGate({ ...input, checks: [check('standards', conclusion), checks[1]] }).allowed).toBe(false);
    }
  });
  it.each(['push', 'fast-checks', 'ci-green'])('refuses unknown prerequisites under %s', startAfter => {
    expect(reviewStartGate({ headSha: head, checks: [check('unrelated', null, { status: 'queued' })],
      requiredChecks: [], policy: { ...review, fastChecks: null, startAfter, startEarly: 'on' } }))
      .toMatchObject({ allowed: false, reason: 'unknown-required-set' });
  });
  it('keeps the off-mode strict refusal for missing and pending prerequisites', () => {
    expect(reviewStartGate({ headSha: head, checks: [check('test', null, { status: 'queued' })],
      requiredChecks: ['standards', 'test'], policy: { ...review, startAfter: 'ci-green', startEarly: 'off' } }))
      .toMatchObject({ allowed: false, reason: 'required-checks-not-successful', affected: [
        { name: 'standards', reason: 'missing' }, { name: 'test', reason: 'pending' }] });
  });
  it('resolves shipped R468 timing from review.json as push start, red cancellation, and shadow early policy', () => {
    const resolved = resolveTimingPolicy({ env: {}, fix: {}, platformReview: {}, platformFix: {}, log: () => {} });
    expect(resolved.review).toMatchObject({ startAfter: 'push', cancelOnCiRed: true, startEarly: 'shadow' });
    expect(resolved.sources.review).toMatchObject({ startAfter: 'tool', cancelOnCiRed: 'tool', startEarly: 'tool' });
  });
  it.each(['fast-checks', 'ci-green'])('allows an environment rollback of shipped push timing to %s', startAfter => {
    const resolved = resolveTimingPolicy({ env: { WE_REVIEW_START_AFTER: startAfter }, fix: {}, platformReview: {}, platformFix: {}, log: () => {} });
    expect(resolved.review.startAfter).toBe(startAfter);
    expect(resolved.sources.review.startAfter).toBe('env');
  });
  const args = { headSha: head, repo: 'we', requiredChecks: ['integration'],
    checks: [check('standards'), check('test-shard (1)', null, { status: 'in_progress' })] };
  it('starts early only in on mode; shadow reports the opportunity and off is unchanged', () => {
    const run = startEarly => reviewStartGate({ ...args, policy: { ...review, startEarly } });
    expect(run('on')).toMatchObject({ allowed: true, reason: 'early-pending-ci', earlyStart: true, headSha: head,
      affected: [{ name: 'test-shard (1)', reason: 'pending' }] });
    expect(run('shadow')).toMatchObject({ allowed: false, wouldStartEarly: true,
      earlyStartNote: `review-early-start: would start early on ${head} (pending: test-shard (1)=pending)` });
    expect(run('off')).toEqual({ allowed: false, headSha: head, reason: 'required-checks-not-successful',
      affected: [{ name: 'test-shard (1)', reason: 'pending' }] });
  });
  it.each(['fast-checks', 'ci-green'])('allows all registered prerequisites queued or running under %s', startAfter => {
    const names = startAfter === 'ci-green' ? ['integration', 'second-required'] : fast;
    for (const status of ['queued', 'in_progress']) {
      const checks = names.map(name => check(name, null, { status }));
      expect(reviewStartGate({ ...args, requiredChecks: ['integration', 'second-required'], checks,
        policy: { ...review, startAfter, startEarly: 'on' } }))
        .toMatchObject({ allowed: true, earlyStart: true, headSha: head });
    }
  });
  it.each(['on', 'shadow'])('requires a pending prerequisite rather than an unrelated row for %s bypass', startEarly => {
    for (const startAfter of ['fast-checks', 'ci-green']) {
      for (const checks of [[check('unrelated')], [check('unrelated', null, { status: 'queued' })],
        [check(startAfter === 'ci-green' ? 'integration' : 'standards')]]) {
        const result = reviewStartGate({ ...args, requiredChecks: ['integration', 'second-required'], checks,
          policy: { ...review, startAfter, startEarly } });
        expect(result.allowed).toBe(false);
        expect(result.wouldStartEarly).not.toBe(true);
        expect(result.earlyStartNote).toBeUndefined();
      }
    }
  });
  it('push mode refuses an unknown roster even with registered fast checks or verification', () => {
    const policy = { ...review, startAfter: 'push', fastChecks: ['test'] };
    for (const requiredChecks of [undefined, null, []]) {
      for (const checks of [[], [check('test', 'failure')], [check('test', null, { status: 'queued' })]]) {
        expect(reviewStartGate({ headSha: head, checks, requiredChecks, verifyGreen: true,
          policy: { ...policy, startBeforeCi: true } })).toMatchObject({ allowed: false, reason: 'unknown-required-set' });
      }
    }
  });
  it.each(['on', 'shadow'])('refuses empty or absent registered CI evidence without an early-start note (%s)', startEarly => {
    for (const checks of [[], undefined, null]) {
      const result = reviewStartGate({ ...args, checks, policy: { ...review, startEarly } });
      expect(result.allowed).toBe(false);
      expect(result.wouldStartEarly).not.toBe(true);
      expect(result.earlyStartNote).toBeUndefined();
    }
  });
  it('validates and cascades the early publication wait and poll settings with provenance', () => {
    const base = { env: {}, read: () => '{}', review: {}, fix: {}, platformReview: {}, platformFix: {} };
    expect(resolveTimingPolicy(base).review).toMatchObject({ startEarlyPublishWaitMs: 1500000, startEarlyPollMs: 30000 });
    const logs = [];
    resetCascadeLogForTest();
    const resolved = resolveTimingPolicy({ ...base, platformReview: { startEarlyPublishWaitMs: 700, startEarlyPollMs: 90 },
      review: { startEarlyPublishWaitMs: 500, startEarlyPollMs: 80 },
      env: { WE_REVIEW_START_EARLY_PUBLISH_WAIT_MS: '250', WE_REVIEW_START_EARLY_POLL_MS: '100', WE_POLICY_CASCADE_LOG: '1' },
      log: line => logs.push(line) });
    expect(resolved.review).toMatchObject({ startEarlyPublishWaitMs: 250, startEarlyPollMs: 100 });
    expect(resolved.sources.review).toMatchObject({ startEarlyPublishWaitMs: 'env', startEarlyPollMs: 'env' });
    expect(logs.join('\n')).toContain('startEarlyPublishWaitMs=250 (env)');
    expect(logs.join('\n')).toContain('startEarlyPollMs=100 (env)');
    expect(resolveTimingPolicy({ ...base, platformReview: { startEarlyPublishWaitMs: 700, startEarlyPollMs: 90 },
      review: { startEarlyPublishWaitMs: -1, startEarlyPollMs: 0 },
      env: { WE_REVIEW_START_EARLY_PUBLISH_WAIT_MS: 'invalid', WE_REVIEW_START_EARLY_POLL_MS: '1.5' } }).review)
      .toMatchObject({ startEarlyPublishWaitMs: 700, startEarlyPollMs: 90 });
  });
  it.each(['off', 'shadow', 'on'])('never permits healable red CI in %s mode', startEarly => {
    for (const startAfter of ['fast-checks', 'ci-green']) {
      expect(reviewStartGate({ ...args, checks: [...args.checks, check('integration', 'failure')],
        policy: { ...review, startAfter, startEarly } })).toMatchObject({ allowed: false,
        reason: startEarly === 'off' && startAfter === 'ci-green' ? 'required-checks-not-successful' : 'ci-red' });
    }
  });
  it('fails closed on missing heads, wrong heads, malformed rows, red fast checks and unknown requirements', () => {
    const policy = { ...review, startEarly: 'on' };
    for (const override of [
      { headSha: null }, { checks: null }, { checks: [null] },
      { checks: [check('standards', 'success', { head_sha: 'b'.repeat(40) })] },
      { checks: [check('standards', null, { status: 'queued', head_sha: '' })] },
      { checks: [check('standards', 'failure', { status: 'in_progress' })] },
      { checks: [check('standards', 'failure')] },
      { checks: [check('unrelated', null, { status: 'unknown' })] },
      { checks: [{ name: 'standards', status: 'queued', state: 'success' }] },
      { policy: { ...policy, startAfter: 'ci-green' }, requiredChecks: [] },
    ]) {
      const result = reviewStartGate({ ...args, policy, ...override });
      expect(result.allowed).toBe(false);
      expect(result.wouldStartEarly).not.toBe(true);
      expect(result.earlyStart).not.toBe(true);
    }
  });
  it('resolves startEarly across every layer, rejects invalid values, and logs provenance', () => {
    const base = { env: {}, read: () => '{}', review: {}, fix: {}, platformReview: {}, platformFix: {} };
    expect(resolveTimingPolicy(base).review.startEarly).toBe('shadow');
    expect(resolveTimingPolicy({ ...base, platformReview: { startEarly: 'on' } }).sources.review.startEarly).toBe('platform');
    expect(resolveTimingPolicy({ ...base, platformReview: { startEarly: 'on' }, review: { startEarly: 'off' } }).review.startEarly).toBe('off');
    const logs = [];
    const result = resolveTimingPolicy({ ...base, review: { startEarly: 'off' },
      env: { WE_REVIEW_START_EARLY: 'on', WE_POLICY_CASCADE_LOG: '1' }, log: line => logs.push(line) });
    expect(result.review.startEarly).toBe('on');
    expect(result.sources.review.startEarly).toBe('env');
    expect(logs.join('\n')).toContain('startEarly="on" (env)');
    expect(resolveTimingPolicy({ ...base, review: { startEarly: 'on' }, env: { WE_REVIEW_START_EARLY: 'invalid' } }).review.startEarly).toBe('on');
    expect(resolveTimingPolicy({ ...base, review: { startEarly: true } }).review.startEarly).toBe('shadow');
  });
  it('reads the tool timing block while preserving legacy timing leaves', () => {
    const result = resolveTimingPolicy({ env: {}, platformReview: {}, platformFix: {},
      read: path => path.endsWith('/settings/review.json') ? '{"timing":{"startEarly":"off"}}'
        : path.endsWith('/review-settings.json') ? '{"startAfter":"ci-green"}' : '{}' });
    expect(result.review).toMatchObject({ startAfter: 'ci-green', startEarly: 'off' });
    expect(result.sources.review.startEarly).toBe('tool');
  });
});
describe('parallel review start and void', () => {
  it('starts after only fast checks, with full CI still pending', () => {
    const checks = [...fast.map(n => check(n)), check('integration', null, { status: 'in_progress' })];
    expect(reviewStartGate({ headSha: head, repo: 'we', checks, requiredChecks: ['integration'] }).allowed).toBe(true);
    expect(reviewStartGate({ headSha: head, repo: 'we', checks, requiredChecks: ['integration'], policy: { ...review, startAfter: 'ci-green' } }).allowed).toBe(false);
    expect(reviewStartGate({ headSha: head, requiredChecks: ['test'], repo: 'we', checks: [], policy: { ...review, startAfter: 'push' } }))
      .toMatchObject({ allowed: false, reason: 'ci-not-registered' });
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
    const args = { reviewedHead: head, currentHead: head, requiredChecks: ['integration'], checks: [check('integration', 'failure')] };
    expect(reviewMustVoid(args)).toBe(false);
    expect(reviewMustVoid({ ...args, policy: { ...review, cancelOnCiRed: true } })).toBe(true);
    expect(reviewMustVoid({ ...args, policy: { ...review, cancelOnCiRed: false } })).toBe(false);
    expect(reviewMustVoid({ ...args, currentHead: 'b'.repeat(40), policy: { ...review, cancelOnCiRed: false } })).toBe(true);
    expect(reviewMustVoid({ ...args, requiredChecks: ['review-gate'], checks: [check('review-gate', 'failure'), check('merge-gate', 'failure')], policy: { ...review, cancelOnCiRed: true } })).toBe(false);
  });
  it('cancellation voids only for a healable red: an optional check never voids a finished review', () => {
    const cancel = { ...review, cancelOnCiRed: true };
    const args = { reviewedHead: head, currentHead: head, policy: cancel, requiredChecks: ['integration'] };
    expect(reviewMustVoid({ ...args, checks: [check('CodeQL', 'failure'), check('integration')] })).toBe(false);
    expect(reviewMustVoid({ ...args, checks: [check('integration', 'failure')] })).toBe(true);
    // An unknown roster voids rather than guessing whether an observed name is required.
    expect(reviewMustVoid({ ...args, requiredChecks: null, checks: [check('soak-replay-gate', 'failure')] })).toBe(true);
    expect(reviewMustVoid({ ...args, requiredChecks: null, checks: [check('CodeQL', 'failure')] })).toBe(true);
  });
  it.each([
    ['review-gate red', [check('review-gate', 'failure')], false],
    ['merge-gate red on a review hold', [check('merge-gate', 'failure', { detailsUrl: 'https://github.com/o/r/actions/runs/7/job/1', mergeGateReviewHold: { headSha: head, holdIds: ['review-acceptance'], jobId: 1 } })], false],
    ['plain merge-gate red', [check('merge-gate', 'failure')], true],
  ])('required %s: healable=%s, the same rule the CI heal uses (#5463)', (_name, rows, healable) => {
    const requiredChecks = ['test', 'review-gate', 'merge-gate'];
    const checks = [...rows, ...['review-gate', 'merge-gate'].filter(name => !rows.some(row => row.name === name)).map(name => check(name)),
      check('test'), ...fast.map(n => check(n))];
    expect(ciRedOnHead({ headSha: head, checks, requiredChecks })).toBe(healable);
    expect(fixReadiness({ headSha: head, checks, requiredChecks }).ciFailed).toBe(healable);
    for (const startAfter of ['fast-checks', 'push'])
      expect(reviewStartGate({ headSha: head, repo: 'we', checks, requiredChecks, policy: { ...review, startAfter } }).allowed).toBe(!healable);
    expect(reviewMustVoid({ reviewedHead: head, currentHead: head, checks, requiredChecks, policy: { ...review, cancelOnCiRed: true } })).toBe(healable);
  });
  it('a review-dependent gate is never healable red, even when branch protection requires it', () => {
    const requiredChecks = ['test', 'review-gate', 'merge-gate'];
    const gates = [check('review-gate', 'failure'), check('merge-gate', 'failure', { detailsUrl: 'https://github.com/o/r/actions/runs/7/job/1', mergeGateReviewHold: { headSha: head, holdIds: ['review-acceptance'], jobId: 1 } }), check('test')];
    expect(ciRedOnHead({ headSha: head, checks: gates, requiredChecks })).toBe(false);
    expect(fixReadiness({ headSha: head, checks: gates, requiredChecks }).ciFailed).toBe(false);
    for (const startAfter of ['fast-checks', 'push'])
      expect(reviewStartGate({ headSha: head, repo: 'we', checks: [...gates, ...fast.map(n => check(n))], requiredChecks,
        policy: { ...review, startAfter } }).allowed).toBe(true);
    expect(reviewMustVoid({ reviewedHead: head, currentHead: head, checks: gates, requiredChecks, policy: { ...review, cancelOnCiRed: true } })).toBe(false);
    // A required non-gate red still counts.
    expect(ciRedOnHead({ headSha: head, checks: [...gates, check('test', 'failure')], requiredChecks })).toBe(true);
  });
  it.each([
    undefined,
    { headSha: 'b'.repeat(40), holdIds: ['review-acceptance'], jobId: 1 },
    { headSha: head, holdIds: ['review-acceptance'], jobId: 2 },
    { headSha: head, holdIds: ['ci'], jobId: 1 },
  ])('an unbound merge-gate review hold remains red and blocks start: %j', mergeGateReviewHold => {
    const checks = [...fast.map(n => check(n)), check('merge-gate', 'failure', {
      detailsUrl: 'https://github.com/o/r/actions/runs/7/job/1', mergeGateReviewHold,
    })];
    const input = { headSha: head, checks, requiredChecks: ['merge-gate'] };
    expect(ciRedOnHead(input)).toBe(true);
    expect(fixReadiness(input).ciFailed).toBe(true);
    expect(reviewMustVoid({ ...input, reviewedHead: head, currentHead: head,
      policy: { ...review, cancelOnCiRed: true } })).toBe(true);
    for (const startAfter of ['fast-checks', 'push', 'ci-green'])
      expect(reviewStartGate({ ...input, repo: 'we', verifyGreen: true,
        policy: { ...review, startAfter, startBeforeCi: true } }).allowed).toBe(false);
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
    const facts = fixReadiness({ headSha: head, requiredChecks: ['unit'], checks: [check('unit', null, { status: 'in_progress' })], findings: [{ body: 'fix', createdAt: new Date(1000).toISOString() }] });
    expect(joinedFixDecision({ ...facts, now: 2000 }).action).toBe('wait');
    expect(fixReadiness({ headSha: head, checks: [check('unit', 'failure', { head_sha: 'b' })] }).ciFailed).toBe(false);
    expect(joinedFixDecision({ ...args, firstReadyAt: NaN }).action).toBe('dispatch');
  });
  it('counts only required failures when the required set is known', () => {
    const checks = [check('CodeQL', 'failure'), check('unit')];
    expect(fixReadiness({ headSha: head, checks, requiredChecks: ['unit'] })).toMatchObject({ ciFailed: false, ciFailures: [] });
    expect(fixReadiness({ headSha: head, checks: [...checks, check('unit', 'failure')], requiredChecks: ['unit'] }).ciFailures.map(r => r.name)).toEqual(['unit']);
    expect(fixReadiness({ headSha: head, checks })).toMatchObject({ ciFailed: false, reason: 'roster-unavailable' }); // unknown roster never guesses ownership
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
  resetCascadeLogForTest();
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
    expect(reviewStartGate({ ...args, requiredChecks: [], checks: [check('test', 'failure')] })).toMatchObject({ allowed: false, reason: 'unknown-required-set' });
  });
});
describe('fix push gate', () => {
  const policy = { ...fix, pushAfterCi: true, pushAfterCiMaxMin: 1 };
  const args = { headSha: head, previousHeadChecks: [check('test', null, { status: 'in_progress' })], requiredChecks: ['test'], firstHeldAt: 1000, now: 1000, policy };
  it('is immediate when off, waits with a fixed deadline when on, and pushes at the bound', () => {
    expect(fixPushGate({ ...args, policy: fix })).toEqual({ action: 'push', reason: 'off' });
    expect(fixPushGate(args)).toEqual({ action: 'wait', reason: 'ci-pending', evidenceReason: 'pending', deadline: 61000 });
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
  const args = { headSha: head, previousHeadChecks: [check('test')], firstHeldAt: 0, now: 0, policy: { ...fix, pushAfterCi: true } };
  for (const requiredChecks of [null, undefined, []]) expect(fixPushGate({ ...args, requiredChecks }).action).toBe('wait');
  expect(fixPushGate({ ...args, requiredChecks: ['test', 'smoke'], previousHeadChecks: [check('test', 'failure'), check('smoke', null, { status: 'queued' })] }).action).toBe('wait');
});


describe('R359 early start shadow (xtxt36v / xrz0ezn)', () => {
  const policy = { ...review, earlyStartShadow: true, earlyStartCare: ['none', 'low'],
    earlyStartMaxLines: 400, earlyStartMaxFiles: 12, earlyStartKinds: ['code'] };
  const args = { headSha: head, checks: [check('test', null, { status: 'in_progress' })],
    requiredChecks: ['test'], verifyGreen: true, care: 'low', lines: 100, files: 3,
    kinds: ['code'], isDraft: false, policy };
  const shadow = overrides => reviewTiming.earlyStartShadow({ ...provenance, ...args, ...overrides });
  const waits = result => {
    expect(result).toEqual({ wouldStartEarly: false, reason: expect.any(String), mergeAllowed: false });
    expect(result.reason.length).toBeGreaterThan(0);
  };

  it('waits on incomplete or malformed CI evidence and never throws', () => {
    for (const requiredChecks of [null, undefined, []]) waits(shadow({ requiredChecks }));
    for (const checks of [[], [{}], [null], null, undefined]) waits(shadow({ checks }));
  });
  it('waits when a required check row is missing, unreadable, or belongs to another head', () => {
    waits(shadow({ requiredChecks: ['test', 'smoke'] }));
    waits(shadow({ checks: [{ name: 'test' }] }));
    waits(shadow({ checks: [check('test', null, { status: 'in_progress', head_sha: 'other-head' })] }));
  });
  it('waits on unknown status values and completed checks without a conclusion', () => {
    waits(shadow({ checks: [check('test', null, { status: 'garbage' })] }));
    waits(shadow({ checks: [check('test', null, { status: 'completed' })] }));
  });
  it('waits on a malformed conclusion or head_sha field', () => {
    waits(shadow({ checks: [check('test', null, { status: 'in_progress', conclusion: 'garbage' })] }));
    waits(shadow({ checks: [check('test', null, { status: 'in_progress', head_sha: 0 })] }));
  });
  it('waits on padded or upper-case conclusions that ciRedOnHead would not read as red', () => {
    for (const conclusion of [' failure ', 'FAILURE']) waits(shadow({ checks: [check('test', conclusion, { status: 'completed' })] }));
  });
  it('waits when an unrelated row has a malformed head_sha', () => {
    waits(shadow({ checks: [...args.checks, { name: 'smoke', status: 'in_progress', head_sha: 123 }] }));
  });
  it('waits on sparse arrays', () => {
    waits(shadow({ kinds: new Array(1) }));
    waits(shadow({ requiredChecks: new Array(1) }));
    waits(shadow({ checks: new Array(1) }));
  });
  it('waits on a conclusion without a status', () => {
    waits(shadow({ checks: [{ name: 'test', conclusion: 'success' }] }));
  });
  it('waits on a sparse array that also carries an extra property', () => {
    const holey = Object.assign(new Array(1), { extra: true });
    waits(shadow({ kinds: holey }));
    waits(shadow({ requiredChecks: holey }));
  });
  it('waits when an explicit row kind does not match its fields', () => {
    waits(shadow({ checks: [{ __typename: 'CheckRun', name: 'test', state: 'success' }] }));
    waits(shadow({ checks: [{ __typename: 'Mystery', name: 'test', status: 'in_progress' }] }));
  });
  it('waits on raw rows that collapse away or contradict themselves', () => {
    waits(shadow({ checks: [{ name: 'test', status: 'in_progress', head_sha: 123 }, ...args.checks] }));
    waits(shadow({ checks: [{ name: 'test', state: 'failure', conclusion: 'success' }] }));
  });
  it('waits on an unfinished check that already carries a conclusion', () => {
    waits(shadow({ checks: [{ name: 'test', status: 'in_progress', conclusion: 'success' }] }));
  });
  it('exports a pure earlyStartShadow decision', () => {
    expect(reviewTiming.earlyStartShadow).toBeTypeOf('function');
  });
  it('defaults to shadow-off and explicitly disables evaluation', () => {
    for (const off of [review, { ...policy, earlyStartShadow: false }])
      expect(shadow({ policy: off })).toEqual({ wouldStartEarly: false, reason: 'shadow-off', mergeAllowed: false });
  });
  it.each(['none', 'low'])('would start verified %s-care code, including drafts, at inclusive limits', care => {
    for (const isDraft of [false, true]) {
      const result = shadow({ care, isDraft, lines: 400, files: 12 });
      expect(result).toEqual({ wouldStartEarly: true, reason: expect.any(String), mergeAllowed: false });
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
  it.each(['elevated', 'high'])('waits for %s care', care => waits(shadow({ care })));
  it.each(['docs', 'config', 'data'])('waits when kinds contain %s alongside code', kind => {
    waits(shadow({ kinds: ['code', kind] }));
  });
  it.each(['care', 'lines', 'files', 'kinds', 'verifyGreen', 'headSha'])('fails closed on absent %s', key => {
    for (const value of [undefined, null]) {
      const result = shadow({ [key]: value });
      waits(result);
      if (key === 'care') expect(result.reason).toBe('missing-care');
    }
  });
  it.each([
    ['care', 'unknown'], ['care', ''], ['lines', NaN], ['lines', -1], ['lines', '100'],
    ['files', NaN], ['files', -1], ['files', '3'], ['kinds', []], ['kinds', ['unknown']],
    ['kinds', 'code'], ['verifyGreen', false], ['verifyGreen', 'true'], ['headSha', ''],
  ])('fails closed on unknown or invalid %s=%j', (key, value) => waits(shadow({ [key]: value })));
  it.each([{ lines: 401 }, { files: 13 },
    { lines: 101, policy: { ...policy, earlyStartMaxLines: 100 } },
    { files: 4, policy: { ...policy, earlyStartMaxFiles: 3 } },
  ])('waits beyond configured bounds: %j', over => waits(shadow(over)));
  it('waits on healable CI red on the current head', () => {
    expect(shadow({ checks: [check('test', 'failure')] }))
      .toEqual({ wouldStartEarly: false, reason: 'ci-red', mergeAllowed: false });
    expect(shadow({ checks: [check('test', 'failure', { head_sha: 'b'.repeat(40) }), ...args.checks] }).wouldStartEarly).toBe(false);
  });
  it.each(['fast-checks', 'ci-green', 'push'])('never changes reviewStartGate under %s', startAfter => {
    for (const checks of [args.checks, [check('test')], [check('test', 'failure')]]) {
      const input = { ...args, checks, policy: { ...policy, startAfter } };
      expect(reviewStartGate(input)).toEqual(reviewStartGate({ ...input, policy: { ...input.policy, earlyStartShadow: false } }));
    }
  });
  it('never grants merge permission, even after CI turns green', () => {
    for (const checks of [args.checks, [check('test')], [check('test', 'failure')]])
      for (const earlyStartShadow of [false, true])
        expect(shadow({ checks, policy: { ...policy, earlyStartShadow } }).mergeAllowed).toBe(false);
  });
  it('does not mutate inputs and returns the same decision for the same evidence', () => {
    const input = structuredClone(args);
    const before = structuredClone(input);
    expect(reviewTiming.earlyStartShadow(input)).toEqual(reviewTiming.earlyStartShadow(input));
    expect(input).toEqual(before);
  });
});

describe('strict timing evidence regressions', () => {
  const input = { ...provenance, headSha: head, requiredChecks: ['unit', 'slow'],
    checks: [check('unit', 'failure', { detailsUrl: 'https://example.test/failure', completedAt: new Date(1000).toISOString() }),
      check('slow', null, { status: 'in_progress' })] };
  it('reports a finished required failure promptly with ciFailures context while another job runs', () => {
    expect(rawfixReadiness(input)).toMatchObject({ ciFailed: true, firstReadyAt: 1000,
      ciFailures: [{ name: 'unit', conclusion: 'failure', detailsUrl: 'https://example.test/failure' }] });
    expect(rawfixReadiness({ ...input, rowsComplete: false }).ciFailed).toBe(true);
  });
  it('a failed job followed by passing same-named evidence stays red in either order', () => {
    const checks = [check('unit', 'failure'), check('unit')];
    const run = checks => rawfixReadiness({ ...input, requiredChecks: ['unit'], checks });
    expect(run(checks)).toEqual(run([...checks].reverse()));
    expect(run(checks)).toMatchObject({ ciFailed: true, ciFailures: [{ name: 'unit', conclusion: 'failure' }] });
  });
  it('cancelled required CI voids with cancelOnCiRed and refuses verification-marker start', () => {
    const args = { ...input, requiredChecks: ['unit'], checks: [check('unit', 'cancelled')],
      policy: { ...review, startBeforeCi: true, cancelOnCiRed: true } };
    expect(rawreviewMustVoid({ ...args, reviewedHead: head, currentHead: head })).toBe(true);
    expect(rawreviewStartGate({ ...args, verifyGreen: true })).toMatchObject({ allowed: false, reason: 'ci-red' });
    expect(rawreviewMustVoid({ ...args, reviewedHead: head, currentHead: head, policy: { ...args.policy, cancelOnCiRed: false } })).toBe(false);
  });
  it.each([{ rowsComplete: false }, { rowsHead: 'b'.repeat(40) }, { rosterSource: 'declared' }, { rosterSource: undefined }])(
    'unknown provenance cannot admit early review or an unbounded fix push: %j', over => {
      const args = { ...input, ...over, checks: [check('unit'), check('slow')], verifyGreen: true,
        policy: { ...review, startBeforeCi: true } };
      expect(rawreviewStartGate(args).allowed).toBe(false);
      expect(rawfixReadiness(args).reason).toEqual(expect.any(String));
      expect(rawfixPushGate({ ...args, previousHeadChecks: args.checks, firstHeldAt: 0, now: 0,
        policy: { ...fix, pushAfterCi: true } })).toMatchObject({ action: 'wait', evidenceReason: expect.any(String) });
    });
});


it.each(['timed_out', 'startup_failure', 'action_required', 'cancelled', 'stale', 'neutral', 'skipped', 'in_progress'])('a required review-gate %s refuses every early review path', state => {
  const checks = [check('test'), state !== 'in_progress' ? check('review-gate', state)
    : check('review-gate', null, { status: 'in_progress' })];
  for (const startAfter of ['ci-green', 'fast-checks', 'push']) {
    for (const startEarly of ['off', 'shadow', 'on']) {
      const result = reviewStartGate({ headSha: head, checks, requiredChecks: ['test', 'review-gate'], verifyGreen: true,
        policy: { ...review, startAfter, startEarly, startBeforeCi: true, fastChecks: ['test'] } });
      expect(result).toMatchObject({ allowed: false, reason: 'required-review-gate-conflict' });
      expect(result.wouldStartEarly).not.toBe(true);
    }
  }
});
