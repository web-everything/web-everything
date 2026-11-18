import { describe, it, expect } from 'vitest';
import { reviewHoldRollupRows } from '../review-hold-rollup.mjs';

const check = (conclusion, extra = {}) => ({ name: 'test', status: 'COMPLETED', conclusion,
  run_id: 42, run_attempt: 1, ...extra });
const earlier = { startedAt: '2026-11-17T09:00:00Z', completedAt: '2026-11-17T10:00:00Z' };
const later = { startedAt: '2026-11-17T10:00:00Z', completedAt: '2026-11-17T11:00:00Z' };

describe('review-hold supersession requires a strictly later attempt of the same run and job', () => {
  it.each([
    ['equal attempts', {}, {}],
    ['older attempt', { run_attempt: 2 }, { run_attempt: 1 }],
    ['missing attempts', { run_attempt: undefined }, { run_attempt: undefined }],
    ['missing failed attempt', { run_attempt: undefined }, { run_attempt: 2 }],
    ['missing successful attempt', {}, { run_attempt: undefined }],
    ['invalid attempt', {}, { run_attempt: 'invalid' }],
    ['different run', {}, { run_id: 43, run_attempt: 2 }],
    ['missing failed run', { run_id: undefined }, { run_attempt: 2 }],
    ['missing successful run', {}, { run_id: undefined, run_attempt: 2 }],
    ['different job', {}, { name: 'build', run_attempt: 2 }],
    ['missing job names', { name: undefined }, { name: undefined, run_attempt: 2 }],
  ])('%s retains failure despite later completion and start timestamps', (_label, failed, passed) => {
    const rows = [check('FAILURE', { ...earlier, ...failed }), check('SUCCESS', { ...later, ...passed })];
    for (const ordered of [rows, rows.toReversed()]) {
      expect(reviewHoldRollupRows(ordered)).toEqual(ordered);
    }
  });

  it.each([
    [{ run_id: 42, run_attempt: 1 }, { run_id: 42, run_attempt: 2 }],
    [{ runId: 42, runAttempt: 1 }, { runId: 42, runAttempt: 2 }],
    [{ workflowRun: { databaseId: 42, runAttempt: 1 } }, { workflowRun: { databaseId: 42, runAttempt: 2 } }],
    [{ checkSuite: { workflowRun: { databaseId: 42, runAttempt: 1 } } },
      { checkSuite: { workflowRun: { databaseId: 42, runAttempt: 2 } } }],
  ])('a genuine later successful attempt supersedes failure without timestamp proof (%j)', (failed, passed) => {
    const rows = [check('FAILURE', { run_id: undefined, run_attempt: undefined, ...failed }),
      check('SUCCESS', { run_id: undefined, run_attempt: undefined, ...passed })];
    for (const ordered of [rows, rows.toReversed()]) {
      expect(reviewHoldRollupRows(ordered)).toEqual([rows[1]]);
      expect(ordered).toContain(rows[0]);
    }
  });
});
