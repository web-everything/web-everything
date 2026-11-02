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
const plan = (pull) => planReconcile({ prs: [{ ...pull, statusCheckRollup: [...fastChecks, ...pull.statusCheckRollup] }], agents: [], now: Date.parse('2026-10-26T12:00:00Z'),
  requiredChecks: ['test', 'smoke'] });

describe('review-gate-only red belongs to review', () => {
  it.each(['review:human', 'review:pending'])('%s dispatches review rather than ci-heal', label => {
    const result = plan(pr({ labels: [{ name: label }] }));
    expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'review', prNumber: 5925 })]);
  });

  it.each(['CANCELLED', 'SKIPPED'])('review-gate with %s smoke still dispatches review', conclusion => {
    const result = plan(pr({ statusCheckRollup: [checks[0], check('smoke', conclusion), checks[2]] }));
    expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'review' })]);
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

  it('missing check evidence cannot dispatch review', () => {
    const result = planReconcile({ prs: [pr({ statusCheckRollup: [checks[2]] })], agents: [],
      requiredChecks: ['test', 'smoke'], reviewTiming: { startAfter: 'ci-green' } });
    expect(result.dispatch.some(row => row.kind === 'review')).toBe(false);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'review-ci' }));
  });

  it('completed CANCELLED required smoke refuses recording not-a-ci-break despite review-gate failure', () => {
    const pull = pr({ statusCheckRollup: [checks[0], check('smoke', 'CANCELLED'), checks[2]] });
    expect(notCiBreakRecordRefusal({ headSha: HEAD, pr: pull, requiredChecks: ['test', 'smoke'] }))
      .toContain('still running: smoke');
  });

  it('recorded not-a-ci-break stand-down prevents another ci-heal on the same head', () => {
    // Required CI is green for recording; the optional failure keeps ci-heal ownership despite the review hold.
    const pull = pr({ statusCheckRollup: [...checks, check('optional-ci', 'FAILURE')] });
    expect(plan(pull).dispatch).toContainEqual(expect.objectContaining({ kind: 'ci-heal' }));
    expect(notCiBreakRecordRefusal({ headSha: HEAD, pr: pull, requiredChecks: ['test', 'smoke'] })).toBeNull();
    pull.comments.push({ author: { login: 'web-everything' },
      body: buildCiHealEscalationComment({ headSha: HEAD, outcome: 'not-a-ci-break', reason: 'Required CI is green; review-gate and optional-ci are red' }) });
    const result = plan(pull);
    expect(result.dispatch.some(row => row.kind === 'ci-heal')).toBe(false);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'ci-heal-escalated', headSha: HEAD }));
  });
});
