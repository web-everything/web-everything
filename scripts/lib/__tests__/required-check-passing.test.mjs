import { describe, it, expect } from 'vitest';
import { withoutImpliedRequiredChecks } from '../required-check-implication.mjs';
import { requiredCheckPassing, summarize } from '../check-state-predicate.mjs';
import { defaultReadHeadCheckState } from '../../operations/promote-draft-pr-dispatch.mjs';
import { requiredCheckStates, gateOnlyRedStates } from '../../conveyor/ci-heal-verdict-recheck.mjs';
import { reviewHoldOnlyRed, reviewHoldGatesOnlyRed } from '../../conveyor/reconcile-core.mjs';
import { needsHumanGateOnlyRefusal } from '../../conveyor/ci-heal-escalation-mark.mjs';

const check = (conclusion, extra = {}) => ({ name: 'test', status: 'completed', conclusion, ...extra });
const failed = check('failure', { run_id: 42, run_attempt: 1 });
const hold = { name: 'merge-gate', status: 'completed', conclusion: 'failure',
  mergeGateReviewHold: { holds: ['review-acceptance'], jobId: 123 } };
const read = rows => defaultReadHeadCheckState({ repoSlug: 'owner/repo', sha: 'a'.repeat(40),
  runGh: () => rows.map(row => JSON.stringify(row)).join('\n'),
  getRequiredChecks: () => ({ checks: ['test', 'merge-gate'] }), mergeGateSetting: { value: 'off' } });

describe('success conclusions need explicit completion evidence', () => {
  const incomplete = [{ name: 'test', conclusion: 'success' }];

  it('requiredCheckPassing refuses a status-less success', () => {
    expect(requiredCheckPassing(incomplete, 'test')).toBe(false);
  });

  it('summarize refuses green and gate-only red beside a status-less success', () => {
    expect(summarize(incomplete).allRequiredGreen).toBe(false);
    expect(summarize([...incomplete, hold])).toMatchObject({
      redSet: new Set(['test', 'merge-gate']), gateOnlyRed: false, allRequiredGreen: false,
    });
  });

  it('reviewHoldOnlyRed refuses draft-promotion evidence with a status-less success', () => {
    for (const required of [undefined, ['test', 'merge-gate']]) {
      expect(reviewHoldOnlyRed([...incomplete, hold], required)).toBe(false);
      expect(reviewHoldGatesOnlyRed([...incomplete, hold], required)).toBe(false);
    }
  });

  it('defaultReadHeadCheckState keeps a status-less success pending beside a review hold', () => {
    expect(read([...incomplete, hold])).toMatchObject({
      state: 'pending', reviewHoldOnly: false, waitingOnReview: false,
      counts: { running: 1, succeeded: 0 },
    });
  });

  it.each([undefined, null, 0, false, {}, []])(
    'all strict consumers refuse non-string status %j', status => {
      const rows = [check('success', { status })];
      expect(requiredCheckPassing(rows, 'test')).toBe(false);
      expect(summarize(rows).allRequiredGreen).toBe(false);
      expect(reviewHoldOnlyRed([...rows, hold], ['test', 'merge-gate'])).toBe(false);
      expect(read([...rows, hold])).toMatchObject({ reviewHoldOnly: false, waitingOnReview: false });
      expect(requiredCheckStates({ rollup: rows, requiredChecks: ['test'] }).green).toEqual([]);
      expect(gateOnlyRedStates({ rollup: [...rows, hold], requiredChecks: ['test', 'merge-gate'] }).gateOnlyRed).toBe(false);
    });
});

describe('required checks need proven latest success', () => {
  it.each(['skipped', 'neutral', null])('required %s never passes alone or after failure', conclusion => {
    const next = check(conclusion, { run_id: 42, run_attempt: 2 });
    expect(requiredCheckPassing([next], 'test')).toBe(false);
    for (const rows of [[failed, next], [next, failed]]) {
      expect(summarize(rows).redSet).toEqual(new Set(['test']));
      expect(requiredCheckStates({ rollup: rows, requiredChecks: ['test'] }).red).toEqual(['test']);
      expect(read([...rows, hold])).toMatchObject({ state: 'red', waitingOnReview: false });
      expect(reviewHoldOnlyRed([...rows, hold], ['test', 'merge-gate'])).toBe(false);
    }
  });

  it('missing required checks fail closed even when declared optional', () => {
    expect(requiredCheckPassing([], 'test')).toBe(false);
    expect(requiredCheckPassing([], 'test', { optionalNames: ['test'] })).toBe(false);
    expect(summarize([check('neutral')], { optionalNames: ['test'] }).allRequiredGreen).toBe(true);
    expect(summarize([], { requiredNames: ['test'] }).allRequiredGreen).toBe(false);
    expect(read([hold])).toMatchObject({ reviewHoldOnly: false, waitingOnReview: false });
  });

  it.each(['skipped', 'neutral', 'failure', 'cancelled', 'unknown', null])(
    'optional names excuse only present skipped/neutral evidence: %s', conclusion => {
      const rows = [check(conclusion)];
      const options = { optionalNames: ['test'] };
      const excused = ['skipped', 'neutral'].includes(conclusion);
      expect(requiredCheckPassing(rows, 'test', options)).toBe(excused);
      expect(summarize(rows, options).allRequiredGreen).toBe(excused);
      expect(summarize(rows, { ...options, requiredNames: ['test'] }).allRequiredGreen).toBe(false);
    });

  it('explicit required names override optional names for missing and pending evidence', () => {
    const options = { requiredNames: ['test'], optionalNames: ['test'] };
    expect(summarize([], options)).toMatchObject({ allRequiredGreen: false, pendingSet: new Set(['test']) });
    const rows = [check(null, { status: 'queued' })];
    expect(summarize(rows, options).allRequiredGreen).toBe(false);
    expect(summarize(rows, { optionalNames: ['test'] }).allRequiredGreen).toBe(false);
    expect(requiredCheckPassing(rows, 'test', options)).toBe(false);
    expect(requiredCheckPassing([check('success'), check('success')], 'test', options)).toBe(false);
  });

  it('only strictly later success in the same run and exact job clears failure', () => {
    const success = check('success', { run_id: '42', run_attempt: '2' });
    for (const rows of [[failed, success], [success, failed]]) {
      expect(requiredCheckPassing(rows, 'test')).toBe(true);
      expect(requiredCheckStates({ rollup: rows, requiredChecks: ['test'] }).green).toEqual(['test']);
      expect(read([...rows, hold])).toMatchObject({ waitingOnReview: true });
    }
    for (const extra of [{ run_id: 43 }, { run_attempt: 1 }, { run_attempt: null },
      { run_attempt: Number.MAX_SAFE_INTEGER + 1 }, { name: 'Test' }]) {
      expect(requiredCheckPassing([failed, { ...success, ...extra }], 'test')).toBe(false);
    }
  });

  it('timestamp-only ordering is never honored, including unordered successes', () => {
    const success = check('success', { id: 999, completedAt: '2099-01-01T00:00:00Z' });
    expect(requiredCheckPassing([failed, success], 'test')).toBe(false);
    expect(read([failed, success, hold])).toMatchObject({ state: 'red', waitingOnReview: false });
    expect(requiredCheckPassing([success, check('success')], 'test')).toBe(false);
  });

  it('a later pending attempt preserves failure and cannot restore a previous success', () => {
    const pending = check(null, { status: 'in_progress', run_id: 42, run_attempt: 3 });
    expect(requiredCheckPassing([failed, pending], 'test')).toBe(false);
    expect(summarize([failed, pending]).redSet).toEqual(new Set(['test']));
    expect(requiredCheckPassing([check('success', { run_id: 42, run_attempt: 2 }), pending], 'test')).toBe(false);
  });
});

describe('review holds do not escalate as CI failures', () => {
  it('proven review-hold-only red waits on review and refuses human CI escalation', () => {
    const rows = [check('success'), hold];
    expect(read(rows)).toMatchObject({ state: 'red', reviewHoldOnly: true, waitingOnReview: true,
      why: 'waiting-on-review' });
    expect(gateOnlyRedStates({ rollup: rows, requiredChecks: ['test', 'merge-gate'] }).gateOnlyRed).toBe(true);
    expect(needsHumanGateOnlyRefusal({ headSha: 'a'.repeat(40),
      pr: { headRefOid: 'a'.repeat(40), statusCheckRollup: rows }, requiredChecks: ['test', 'merge-gate'] }))
      .toContain('ordinary review is owed');
  });

  it.each([check('failure'), check('skipped'), check('neutral'), check('cancelled')])('hold plus real blocker $conclusion stays red', row => {
    expect(read([row, hold])).toMatchObject({ state: 'red', waitingOnReview: false });
    expect(needsHumanGateOnlyRefusal({ headSha: 'a'.repeat(40),
      pr: { headRefOid: 'a'.repeat(40), statusCheckRollup: [row, hold] }, requiredChecks: ['test', 'merge-gate'] }))
      .toBeNull();
  });

  it('a classified later review hold cannot erase an earlier real merge-gate failure', () => {
    const rows = [check('success'),
      { name: 'merge-gate', id: 111, status: 'completed', conclusion: 'failure',
        completed_at: '2026-01-01T00:00:00Z', run_id: 42, run_attempt: 1 },
      { name: 'merge-gate', id: 222, status: 'completed', conclusion: 'failure',
        completed_at: '2026-01-02T00:00:00Z', run_id: 42, run_attempt: 2 }];
    const result = defaultReadHeadCheckState({ repoSlug: 'owner/repo', prNumber: 7, sha: 'a'.repeat(40),
      runGh: () => rows.map(row => JSON.stringify(row)).join('\n'),
      getRequiredChecks: () => ({ checks: ['test', 'merge-gate'] }), mergeGateSetting: { value: 'on' },
      readPrLabels: () => ['review:pending'], readMergeGateVerdict: () => ({ num: 7, head_sha: 'a'.repeat(40),
        ok: false, results: [{ id: 'review-acceptance', status: 'hold', reason: 'review pending' }] }) });
    expect(result).toMatchObject({ state: 'red', reviewHoldOnly: false, waitingOnReview: false });
  });

  it('implication evidence needs an explicit completed status', () => {
    const rows = [{ name: 'test', conclusion: 'success' }];
    expect(withoutImpliedRequiredChecks(['integration'], rows)).toEqual(['integration']);
    expect(withoutImpliedRequiredChecks(['integration'], [{ ...rows[0], status: 'completed' }])).toEqual([]);
  });

  it('an unreadable merge-gate verdict remains ordinary CI red', () => {
    expect(read([check('success'), { ...hold, mergeGateReviewHold: undefined }]))
      .toMatchObject({ state: 'red', waitingOnReview: false });
  });
});
