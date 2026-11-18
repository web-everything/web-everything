import { it, expect } from 'vitest';
import { isRequiredCheckGreen, isRequiredCheckFailed } from '../merge-ai-prs.mjs';
import { everyOtherRequiredGreen } from '../lib/merge-queue-enqueue.mjs';
import { ciRedOnHead, fixReadiness, reviewStartGate } from '../lib/review-timing.mjs';
import { headCiVerdict } from '../conveyor/fix-push-ci.mjs';
import { splitFailingChecks, reviewHoldOnlyRed, reviewHoldGatesOnlyRed } from '../conveyor/reconcile-core.mjs';
import { realRequiredFailures } from '../conveyor/exhausted-retry.mjs';
import { reduceCheckState } from '../operations/pr-status.mjs';
import { ciFailed } from '../progress-board.mjs';
import { ciRollup } from '../readiness/conveyor-state.mjs';
import { rollupToCheckRows } from '../fetch-parked.mjs';
import { latestFailingMergeGate, excuseMergeGateRows } from '../lib/merge-gate-hold-class.mjs';

const failed = { name: 'test', workflow_id: 1, workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-10-28T01:00:00Z' };
const success = { ...failed, conclusion: 'SUCCESS', startedAt: '2026-10-28T02:00:00Z' };
const headSha = 'a'.repeat(40);

it.each(['different workflow', 'display only', 'unknown third producer', 'pending rerun'])('required verdict consumers retain failures: %s', scenario => {
  const rows = scenario === 'different workflow' ? [failed, { ...success, workflow_id: 2 }]
    : scenario === 'display only' ? [{ ...failed, workflow_id: undefined }, { ...success, workflow_id: undefined }]
    : scenario === 'unknown third producer' ? [failed, success, { ...success, workflow_id: undefined, workflowName: 'unrelated' }]
    : [failed, { ...success, status: 'IN_PROGRESS', conclusion: null }];
  for (const rollup of [rows, rows.toReversed()]) {
    const pr = { headRefOid: headSha, statusCheckRollup: rollup };
    expect(isRequiredCheckGreen(pr)).toBe(false);
    expect(isRequiredCheckFailed(pr)).toBe(true);
    expect(everyOtherRequiredGreen(['test'], rollup)).toBe(false);
    expect(ciRedOnHead({ headSha, checks: rollup, requiredChecks: ['test'] })).toBe(true);
    expect(fixReadiness({ headSha, checks: rollup, requiredChecks: ['test'] }).ciFailed).toBe(true);
    expect(reviewStartGate({ headSha, checks: rollup, requiredChecks: ['test'], policy: { startEarly: 'on' } }).allowed).toBe(false);
    expect(headCiVerdict(rollup, ['test'])).toBe('red');
    expect(splitFailingChecks(rollup, ['test']).required).toContain('test');
    expect(reviewHoldOnlyRed([...rollup, { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' }], ['test', 'review-gate'])).toBe(false);
    expect(realRequiredFailures(pr, ['test'])).toContain('test');
    // A separate pending workflow may yield pending here, but it must never turn green.
    expect(reduceCheckState(rollup, ['test']).state).not.toBe('green');
    expect(ciFailed(rollup, ['test'])).toBe(true);
    expect(ciRollup(rollup)).toBe('fail');
    expect(rollupToCheckRows(rollup)).toContainEqual({ name: 'test', bucket: 'fail' });
  }
});
it('required verdict consumers release on a completed success in the same stable workflow', () => {
  for (const rows of [[failed, success], [success, failed]]) {
    expect(isRequiredCheckGreen({ statusCheckRollup: rows })).toBe(true);
    expect(isRequiredCheckFailed({ statusCheckRollup: rows })).toBe(false);
    expect(everyOtherRequiredGreen(['test'], rows)).toBe(true);
    expect(headCiVerdict(rows, ['test'])).toBe('green');
    expect(splitFailingChecks(rows, ['test']).required).toEqual([]);
    expect(ciRedOnHead({ headSha, checks: rows, requiredChecks: ['test'] })).toBe(false);
    expect(reduceCheckState(rows, ['test']).state).toBe('green');
  }
});

it('a newer merge-gate failure cannot use an older workflow hold verdict', () => {
  const hold = { ...failed, name: 'merge-gate', id: 10, mergeGateReviewHold: true };
  const failure = { ...hold, workflow_id: 2, id: 20, mergeGateReviewHold: undefined };
  for (const rows of [[hold, failure], [failure, hold]]) {
    expect(reviewHoldGatesOnlyRed(rows, ['merge-gate'])).toBe(false);
  }
  const result = excuseMergeGateRows([hold, failure], {
    setting: 'on', prNumber: 1, headSha, labels: [],
    readVerdict: ({ jobId }) => jobId === 10 ? ({ num: 1, head_sha: headSha, ok: false,
      results: [{ id: 'candidate-label', status: 'hold', reason: 'labels: ready-to-merge required' }] }) : null,
  });
  expect(result.excused).toBe(false);
  expect(result.rows).toContain(failure);
  expect(isRequiredCheckGreen({ statusCheckRollup: result.rows }, 'merge-gate')).toBe(false);
});

it.each(['NEUTRAL', 'SKIPPED'])('strict required consumers cannot hide %s behind another workflow success', conclusion => {
  const nonSuccess = { ...success, workflow_id: 2, conclusion };
  for (const checks of [[success, nonSuccess], [nonSuccess, success]]) {
    expect(everyOtherRequiredGreen(['test'], checks)).toBe(false);
    expect(reviewStartGate({ headSha, checks, requiredChecks: ['test'], policy: { startEarly: 'on' } }).allowed).toBe(false);
  }
});


it('merge-gate recovery requires a current completed failure, never an older failed run', () => {
  const older = { ...failed, name: 'merge-gate', completedAt: '2026-10-28T01:30:00Z' };
  const running = { ...success, name: 'merge-gate', status: 'IN_PROGRESS', conclusion: null, completedAt: null };
  for (const rows of [[older, running], [running, older]]) expect(latestFailingMergeGate(rows)).toBeNull();
});
