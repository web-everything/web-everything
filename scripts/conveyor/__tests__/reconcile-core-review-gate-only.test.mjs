// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { planReconcile } from '../reconcile-core.mjs';
import { buildCiHealEscalationComment, notCiBreakRecordRefusal } from '../ci-heal-escalation-mark.mjs';
import { planVerdictVoid } from '../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';

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
  it('a silent review decision cannot inherit a previous PR missing-check refusal', () => {
    const pulls = [5924, 5925].map(number => pr({ number, baseRefName: 'main',
      statusCheckRollup: [...fastChecks, checks[0], checks[2]] }));
    const dispatchReviewRow = vi.fn(({ pr: pull, refuse, withPhase }) => {
      if (pull.number === 5924) refuse('review-ci', { ...withPhase,
        ci: { affected: [{ name: 'smoke', reason: 'missing' }] } });
      // The second call deliberately neither dispatches nor refuses.
    });
    const result = planReconcile({ prs: pulls, agents: [], requiredChecks: ['test', 'smoke'],
      reviewTiming: { startAfter: 'ci-green' }, dispatchReviewRow });
    expect(dispatchReviewRow.mock.calls.map(([args]) => args.pr.number)).toEqual([5924, 5925]);
    expect(result.refusals.filter(row => row.kind === 'review-ci')).toEqual([
      expect.objectContaining({ prNumber: 5924 }),
    ]);
    expect(result.dispatch).toEqual([expect.objectContaining({ prNumber: 5924,
      kind: 'fix', mode: 'stale-base-rebase' })]);
  });

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

  it.each(['review:human', 'review:pending'])('%s reports optional red and dispatches review before and after stand-down', label => {
    const pull = pr({ labels: [{ name: label }], statusCheckRollup: [...checks, check('optional-ci', 'FAILURE')] });
    for (let tick = 0; tick < 2; tick++) {
      const result = plan(pull);
      expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'review',
        nonRequiredRed: expect.arrayContaining(['optional-ci']), why: expect.stringContaining('optional-ci') })]);
      pull.comments.push({ author: { login: 'web-everything' },
        body: buildCiHealEscalationComment({ headSha: HEAD, outcome: 'not-a-ci-break' }) });
    }
  });

  it.each([false, true])('authenticated send-back owns review-hold red with optional failure=%s', optional => {
    const pull = pr({ statusCheckRollup: [...checks, ...(optional ? [check('optional-ci', 'FAILURE')] : [])],
      comments: [{ id: 'op-send-back', createdAt: '2026-10-26T11:00:00Z', author: { login: 'chalbert' },
        body: '🔁 review — changes requested\n\nRecorded by chalbert via claude-code-chat.\n\nMUST FIX: rename the export.' }] });
    expect(plan(pull).dispatch).toEqual([expect.objectContaining({ kind: 'fix', mode: 'operator-send-back',
      operatorSendBack: expect.objectContaining({ verdictId: 'op-send-back' }) })]);
  });

  it.each(['untrusted', 'spent'])('%s send-back cannot claim the review owner', variant => {
    const comments = [{ id: 'op-send-back', createdAt: '2026-10-26T11:00:00Z',
      author: { login: variant === 'untrusted' ? 'rando' : 'chalbert' },
      body: '🔁 review — changes requested\n\nRecorded by chalbert via claude-code-chat.\n\nMUST FIX: rename the export.' }];
    if (variant === 'spent') comments.push({ author: { login: 'web-everything' },
      body: '🔧 conveyor fix — re-armed for re-review' });
    expect(plan(pr({ comments })).dispatch).toEqual([expect.objectContaining({ kind: 'review' })]);
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
        expect(result.dispatch).toEqual([expect.objectContaining({ kind: realRed === 'test' ? 'ci-heal' : 'review' })]);
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
    } else expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'review' })]);
  });

  it('missing check evidence cannot dispatch review', () => {
    const result = planReconcile({ prs: [pr({ statusCheckRollup: [checks[2]] })], agents: [],
      requiredChecks: ['test', 'smoke'], reviewTiming: { startAfter: 'ci-green' } });
    expect(result.dispatch.some(row => row.kind === 'review')).toBe(false);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'review-ci' }));
  });

  it('recorded not-a-ci-break stand-down prevents another ci-heal on the same head', () => {
    // Without a review label the existing escalation path, rather than the review-hold shortcut, owns this head.
    const pull = pr({ labels: [], statusCheckRollup: [checks[0], check('smoke', 'CANCELLED'), checks[2]],
      timeoutRetry: { eligible: true, infraCancelled: true, pr: 5925, head: HEAD, cap: 6,
        jobs: [{ run: 10, job: 20, attempt: 1 }] },
      timeoutRetryBudget: { confirmed: 6, rejected: 0, pending: false } });
    expect(plan(pull).dispatch).toContainEqual(expect.objectContaining({ kind: 'ci-heal' }));
    expect(notCiBreakRecordRefusal({ headSha: HEAD, pr: pull, requiredChecks: ['test', 'smoke'] })).toBeNull();
    pull.comments.push({ author: { login: 'web-everything' },
      body: buildCiHealEscalationComment({ headSha: HEAD, outcome: 'not-a-ci-break', reason: 'Only review-gate is red' }) });
    const result = plan(pull);
    expect(result.dispatch.some(row => row.kind === 'ci-heal')).toBe(false);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'ci-heal-escalated', headSha: HEAD }));
    const voidRow = planVerdictVoid({ note: { kind: 'ci-heal-escalated', outcome: 'not-a-ci-break',
      headSha: HEAD, prNumber: pull.number }, pr: pull, repo: 'web-everything/web-everything',
      verdictSettings: { recheckNotCiBreak: true }, readRequiredChecks: () => ['test', 'smoke'] });
    expect(voidRow).toBeNull();
    if (voidRow) pull.comments.push({ author: { login: 'web-everything' }, body: voidRow.body });
    expect(plan(pull).dispatch.some(row => row.kind === 'ci-heal')).toBe(false);
  });
});
