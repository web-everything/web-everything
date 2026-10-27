// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { planReconcile } from '../reconcile-core.mjs';
import { buildCiHealEscalationComment, notCiBreakRecordRefusal } from '../ci-heal-escalation-mark.mjs';

const HEAD = 'a'.repeat(40);
const check = (name, conclusion) => ({ name, status: 'COMPLETED', conclusion });
const checks = [check('test', 'SUCCESS'), check('smoke', 'SUCCESS'), check('review-gate', 'FAILURE')];
const fastChecks = [check('standards', 'SUCCESS'), check('test-shard (1)', 'SUCCESS')];
const pr = (over = {}) => ({
  number: 5925, state: 'OPEN', isDraft: false, headRefName: 'lane/review-gate-only', headRefOid: HEAD,
  labels: [{ name: 'review:human' }], mergeStateStatus: 'CLEAN', statusCheckRollup: checks, comments: [], ...over,
});
const plan = (pull, options = {}) => planReconcile({ prs: [{ ...pull, statusCheckRollup: [
  ...fastChecks.filter(row => !pull.statusCheckRollup.some(check => check.name === row.name)), ...pull.statusCheckRollup,
] }], agents: [], now: Date.parse('2026-10-26T12:00:00Z'),
  requiredChecks: ['test', 'smoke'], ...options });

describe('review-gate-only red belongs to review', () => {
  it('missing required smoke falls through refused review to stale-base repair', () => {
    const result = plan(pr({ baseRefName: 'main', statusCheckRollup: [checks[0], checks[2]] }),
      { reviewTiming: { startAfter: 'ci-green' } });
    expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'fix', mode: 'stale-base-rebase',
      staleBase: { missing: ['smoke'], defaultBranch: 'main' } })]);
  });

  it('a required merge-gate red only from the non-required review hold dispatches review', () => {
    const result = plan(pr({ statusCheckRollup: [...checks, { ...check('merge-gate', 'FAILURE'),
      mergeGateReviewHold: { holds: ['review-gate'], jobId: 5874001 } }] }),
    { requiredChecks: ['test', 'smoke', 'merge-gate'] });
    expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'review' })]);
  });

  it('retry-eligible cancelled smoke refuses stand-down so pending review retains its retry', () => {
    const pull = pr({ labels: [{ name: 'review:pending' }],
      statusCheckRollup: [checks[0], check('smoke', 'CANCELLED'), checks[2]],
      timeoutRetry: { eligible: true, infraCancelled: true, pr: 5925, head: HEAD, cap: 6,
        jobs: [{ run: 10, job: 20, attempt: 1 }] },
      timeoutRetryBudget: { confirmed: 0, rejected: 0, pending: false } });
    const refusal = notCiBreakRecordRefusal({ headSha: HEAD, pr: pull, requiredChecks: ['test', 'smoke'] });
    if (!refusal) pull.comments.push({ author: { login: 'web-everything' },
      body: buildCiHealEscalationComment({ headSha: HEAD, outcome: 'not-a-ci-break' }) });
    expect(plan(pull, { reviewTiming: { startAfter: 'ci-green' } }).dispatch)
      .toEqual([expect.objectContaining({ kind: 'ci-timeout-rerun' })]);
    expect(refusal).toContain('retry');
  });

  it.each(['review:human', 'review:pending'])('%s dispatches review rather than ci-heal', label => {
    const result = plan(pr({ labels: [{ name: label }] }));
    expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'review', prNumber: 5925 })]);
  });

  it.each(['CANCELLED', 'SKIPPED'])('review-gate with %s smoke still dispatches review', conclusion => {
    const result = plan(pr({ statusCheckRollup: [checks[0], check('smoke', conclusion), checks[2]] }));
    expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'review' })]);
  });

  it.each(['review:human', 'review:pending'].flatMap(label =>
    ['test', 'standards', 'test-shard (1)', 'daemon-soak'].map(name => [label, name])))(
    '%s retains the retry owner for cancelled required %s beside review-gate', (label, name) => {
      const pull = pr({ labels: [{ name: label }], statusCheckRollup: [
        ...checks.filter(row => row.name !== name), check(name, 'CANCELLED'),
      ], timeoutRetry: { eligible: true, infraCancelled: true, repo: 'web-everything/web-everything',
        pr: 5925, head: HEAD, signature: 'infra', jobs: [{ run: 10, job: 20, attempt: 1 }] },
      timeoutRetryBudget: { confirmed: 0, rejected: 0, pending: false } });
      const options = { requiredChecks: [...new Set(['test', 'smoke', name])] };
      for (const includeGate of [false, true]) {
        const result = plan({ ...pull, statusCheckRollup: pull.statusCheckRollup
          .filter(row => includeGate || row.name !== 'review-gate') }, options);
        expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'ci-timeout-rerun' })]);
      }
    });

  it.each(['review:human', 'review:pending'])('%s retains cancelled smoke retry under ci-green timing', label => {
    const pull = pr({ labels: [{ name: label }],
      statusCheckRollup: [checks[0], check('smoke', 'CANCELLED'), checks[2]],
      timeoutRetry: { eligible: true, infraCancelled: true, repo: 'web-everything/web-everything',
        pr: 5925, head: HEAD, signature: 'infra', jobs: [{ run: 10, job: 20, attempt: 1 }] },
      timeoutRetryBudget: { confirmed: 0, rejected: 0, pending: false } });
    expect(plan(pull).dispatch).toEqual([expect.objectContaining({ kind: 'review' })]);
    for (const includeGate of [false, true]) {
      const result = plan({ ...pull, statusCheckRollup: pull.statusCheckRollup
        .filter(row => includeGate || row.name !== 'review-gate') }, { reviewTiming: { startAfter: 'ci-green' } });
      expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'ci-timeout-rerun' })]);
    }
  });

  it.each(['test', 'smoke'])('real red %s plus review-gate still dispatches ci-heal', name => {
    const result = plan(pr({ statusCheckRollup: [...checks.filter(row => row.name !== name), check(name, 'FAILURE')] }));
    expect(result.dispatch).toContainEqual(expect.objectContaining({ kind: 'ci-heal' }));
    expect(result.dispatch.some(row => row.kind === 'review')).toBe(false);
  });

  it('a failed non-required check alongside review-gate retains ci-heal ownership and dispatches no review', () => {
    const result = plan(pr({ statusCheckRollup: [...checks, check('optional-ci', 'FAILURE')] }));
    expect(result.dispatch).toContainEqual(expect.objectContaining({ kind: 'ci-heal' }));
    expect(result.dispatch.some(row => row.kind === 'review')).toBe(false);
  });

  it.each([false, true].flatMap(requiredGate => ['none', 'test', 'optional-ci'].map(realRed => [requiredGate, realRed])))(
    'review-gate required=%s with real red=%s preserves CI ownership', (requiredGate, realRed) => {
      const result = plan(pr({ statusCheckRollup: [
        ...checks.filter(row => row.name !== realRed),
        ...(realRed === 'none' ? [] : [check(realRed, 'FAILURE')]),
      ] }), { requiredChecks: ['test', 'smoke', ...(requiredGate ? ['review-gate'] : [])] });
      if (requiredGate && realRed !== 'test') {
        expect(result.dispatch).toEqual([]);
        expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'review-ci' }));
      } else {
        expect(result.dispatch).toEqual([expect.objectContaining({ kind: realRed === 'none' ? 'review' : 'ci-heal' })]);
      }
    });

  it.each(['test', 'standards', 'test-shard (1)', 'daemon-soak'])('cancelled required %s retains CI repair and refuses review', name => {
    const result = plan(pr({ statusCheckRollup: [
      ...checks.filter(row => row.name !== name), check(name, 'CANCELLED'),
    ] }), { requiredChecks: ['test', 'smoke', name] });
    expect(result.dispatch.some(row => row.kind === 'review')).toBe(false);
    expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal' })]);
  });

  it.each(['review:changes', 'advisory:changes'])('%s with cancelled smoke retains a CI repair owner', label => {
    const result = plan(pr({ labels: [{ name: 'review:human' }, { name: label }],
      statusCheckRollup: [checks[0], check('smoke', 'CANCELLED'), checks[2]] }));
    expect(result.dispatch).toContainEqual(expect.objectContaining({ kind: 'ci-heal' }));
    expect(result.dispatch.some(row => row.kind === 'review')).toBe(false);
  });

  it.each(['review:human', 'review:changes', 'advisory:changes'])('%s preserves block-ruled referral repair before review', label => {
    const result = plan(pr({ labels: [{ name: 'review:human' }, { name: label }],
      blockRuledReferrals: [{ key: 'blocked', finding: { file: 'example.mjs' } }],
      statusCheckRollup: [checks[0], check('smoke', 'CANCELLED'), checks[2]] }));
    expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'fix', mode: 'block-ruled-referral' })]);
  });

  it('review:pending in ci-red preserves its block-ruled referral repair', () => {
    const result = plan(pr({ labels: [{ name: 'review:pending' }],
      blockRuledReferrals: [{ key: 'blocked', finding: { file: 'example.mjs' } }],
      statusCheckRollup: [checks[0], check('smoke', 'CANCELLED'), checks[2]] }));
    expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'fix', mode: 'block-ruled-referral' })]);
  });

  it.each([1, 3])('ignored operator ruling at miss %s retains its fixer ladder owner', misses => {
    const result = plan(pr({ ignoredRulings: { head: HEAD, misses, matches: [
      { finding: { file: 'example.mjs' }, ruling: 'block: repair the finding', priorHead: 'b'.repeat(40), misses },
    ] }, statusCheckRollup: [checks[0], check('smoke', 'CANCELLED'), checks[2]] }));
    expect(result.dispatch.some(row => row.kind === 'review')).toBe(false);
    if (misses === 1) expect(result.dispatch).toContainEqual(expect.objectContaining({ kind: 'fix', mode: 'ruling-not-addressed' }));
    else expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'ruling-dispute' }));
  });

  it('existing review-hold-red routing remains unchanged', () => {
    const result = plan(pr({ statusCheckRollup: [...checks, { ...check('merge-gate', 'FAILURE'),
      mergeGateReviewHold: { holds: ['review-gate'], jobId: 5874001 } }] }),
    { requiredChecks: ['test', 'smoke', 'merge-gate', 'review-gate'] });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals.map(row => row.kind)).toEqual(['review-hold-red']);
  });

  it.each([false, true])('held merge-gate with optional red preserves ownership when review-gate required=%s', requiredGate => {
    const result = plan(pr({ statusCheckRollup: [...checks, check('optional-ci', 'FAILURE'),
      { ...check('merge-gate', 'FAILURE'), mergeGateReviewHold: { holds: ['review-gate'], jobId: 5874001 } },
    ] }), { requiredChecks: ['test', 'smoke', 'merge-gate', ...(requiredGate ? ['review-gate'] : [])] });
    if (requiredGate) {
      expect(result.dispatch).toEqual([]);
      expect(result.refusals.map(row => row.kind)).toEqual(['review-hold-red']);
    } else expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal' })]);
  });

  it('missing check evidence cannot dispatch review', () => {
    const result = planReconcile({ prs: [pr({ statusCheckRollup: [checks[2]] })], agents: [],
      requiredChecks: ['test', 'smoke'], reviewTiming: { startAfter: 'ci-green' } });
    expect(result.dispatch.some(row => row.kind === 'review')).toBe(false);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'review-ci' }));
  });

  it('recorded not-a-ci-break stand-down prevents another ci-heal on the same head', () => {
    // Without a review label the existing escalation path, rather than the review-hold shortcut, owns this head.
    const pull = pr({ labels: [], statusCheckRollup: [checks[0], check('smoke', 'CANCELLED'), checks[2]] });
    expect(plan(pull).dispatch).toContainEqual(expect.objectContaining({ kind: 'ci-heal' }));
    expect(notCiBreakRecordRefusal({ headSha: HEAD, pr: pull, requiredChecks: ['test', 'smoke'] })).toBeNull();
    pull.comments.push({ author: { login: 'web-everything' },
      body: buildCiHealEscalationComment({ headSha: HEAD, outcome: 'not-a-ci-break', reason: 'Only review-gate is red' }) });
    const result = plan(pull);
    expect(result.dispatch.some(row => row.kind === 'ci-heal')).toBe(false);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'ci-heal-escalated', headSha: HEAD }));
  });
});
