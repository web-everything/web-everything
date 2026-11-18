import { describe, it, expect } from 'vitest';
import { collapseRollupToLatestPerName, latestCheckNamed } from '../rollup-collapse.mjs';
import { reduceCheckState } from '../../operations/pr-status.mjs';
import { isRequiredCheckGreen } from '../../merge-ai-prs.mjs';

const check = (id, conclusion, extra = {}) => ({ name: 'review-gate', id, status: 'COMPLETED', conclusion, ...extra });
const strict = rows => collapseRollupToLatestPerName(rows, { preserveUnknownJobs: true });

describe('rollup job identity', () => {
  it.each([
    ['startedAt', 'completedAt', true],
    ['startedAt', 'completedAt', false],
    ['started_at', 'completed_at', true],
    ['started_at', 'completed_at', false],
  ])('overlapping executions: older completion cannot erase a newer pending job (%s, %s, older start known=%s)', (start, done, olderStartKnown) => {
    const success = check(20, 'SUCCESS', { name: 'test', workflowName: 'ci',
      ...(olderStartKnown ? { [start]: '2026-11-17T17:00:00Z' } : {}),
      [done]: '2026-11-17T19:00:00Z' });
    const pending = check(10, null, { name: 'test', workflowName: 'ci', status: 'IN_PROGRESS',
      [start]: '2026-11-17T18:00:00Z', [done]: '0001-01-01T00:00:00Z' });
    for (const rows of [[success, pending], [pending, success]]) {
      expect(collapseRollupToLatestPerName(rows)).toEqual([pending]);
      expect(strict(rows)).toContain(pending);
      expect(latestCheckNamed(rows, 'test')).toBe(pending);
      expect(reduceCheckState(rows, ['test']).state).toBe('pending');
      expect(isRequiredCheckGreen({ statusCheckRollup: rows })).toBe(false);
    }
  });

  it('comparable start times prove a later execution supersedes an older pending job', () => {
    const pending = check(20, null, { workflowName: 'ci', status: 'IN_PROGRESS', startedAt: '2026-11-17T17:00:00Z' });
    const success = check(10, 'SUCCESS', { workflowName: 'ci', startedAt: '2026-11-17T18:00:00Z', completedAt: '2026-11-17T19:00:00Z' });
    for (const rows of [[pending, success], [success, pending]]) {
      expect(collapseRollupToLatestPerName(rows)).toEqual([success]);
      expect(strict(rows)).toEqual([success]);
    }
  });

  it.each([
    ['failure', 'FAILURE', 'COMPLETED', 'red'],
    ['pending', null, 'IN_PROGRESS', 'pending'],
    ['unreadable', 'UNKNOWN', 'COMPLETED', 'unchecked'],
  ])('audit regression: unordered same-suite %s cannot be erased by a higher check ID', (_kind, conclusion, status, state) => {
    const blocked = check(10, conclusion, { name: 'test', status, checkSuite: { id: 42 } });
    const success = check(20, 'SUCCESS', { name: 'test', checkSuite: { id: 42 } });
    for (const rows of [[blocked, success], [success, blocked]]) {
      expect(collapseRollupToLatestPerName(rows)).toEqual([blocked]);
      expect(latestCheckNamed(rows, 'test')).toBe(blocked);
      expect(reduceCheckState(rows, ['test']).state).toBe(state);
      expect(isRequiredCheckGreen({ statusCheckRollup: rows })).toBe(false);
    }
  });

  it.each(['run_attempt', 'runAttempt'])('audit regression: a genuine later %s supersedes failure despite a lower check ID', field => {
    const failed = check(20, 'FAILURE', { checkSuite: { id: 42 }, run_id: 100, [field]: 1 });
    const success = check(10, 'SUCCESS', { checkSuite: { id: 42 }, run_id: 100, [field]: 2 });
    for (const rows of [[failed, success], [success, failed]]) {
      expect(collapseRollupToLatestPerName(rows)).toEqual([success]);
      expect(strict(rows)).toEqual([success]);
    }
  });

  it.each([
    ['workflowRun.id', id => ({ workflowRun: { id } })],
    ['run_id', id => ({ run_id: id })],
    ['runId', id => ({ runId: id })],
    ['checkSuite.workflowRun.id', id => ({ checkSuite: { id: 42, workflowRun: { id } } })],
    ...['completedAt', 'completed_at', 'startedAt', 'started_at'].map(field =>
      [field, id => ({ [field]: `2026-11-17T0${id}:00:00Z` })]),
  ])('same-job %s ordering wins over check IDs and input order', (_field, evidence) => {
    const failed = check(20, 'FAILURE', { checkSuite: { id: 42 }, ...evidence(1) });
    const success = check(10, 'SUCCESS', { checkSuite: { id: 42 }, ...evidence(2) });
    for (const rows of [[failed, success], [success, failed]]) {
      expect(collapseRollupToLatestPerName(rows)).toEqual([success]);
      expect(strict(rows)).toEqual([success]);
    }
  });

  it.each([
    ['run_id', id => ({ run_id: id })],
    ['runId', id => ({ runId: id })],
    ['workflowRun.id', id => ({ workflowRun: { id } })],
  ])('cross-run reset: newer %s success supersedes an older failure at a higher attempt', (_field, evidence) => {
    const failed = check(20, 'FAILURE', { name: 'test', workflowName: 'ci', run_attempt: 2,
      ...evidence(1), completedAt: '2026-11-17T02:00:00Z' });
    const success = check(10, 'SUCCESS', { name: 'test', workflowName: 'ci', runAttempt: 1,
      ...evidence(2), completedAt: '2026-11-17T01:00:00Z' });
    for (const rows of [[failed, success], [success, failed]]) {
      expect(collapseRollupToLatestPerName(rows)).toEqual([success]);
      expect(strict(rows)).toEqual([success]);
      expect(latestCheckNamed(rows, 'test')).toBe(success);
      expect(reduceCheckState(rows, ['test']).state).toBe('green');
      expect(isRequiredCheckGreen({ statusCheckRollup: rows })).toBe(true);
    }
  });

  it('same-run attempts outrank check IDs and completion timestamps', () => {
    const failed = check(10, 'FAILURE', { workflowName: 'ci', run_attempt: 2, run_id: 42, completedAt: '2026-11-17T01:00:00Z' });
    const success = check(20, 'SUCCESS', { workflowName: 'ci', runAttempt: 1, run_id: 42, completedAt: '2026-11-17T02:00:00Z' });
    for (const rows of [[failed, success], [success, failed]]) {
      expect(collapseRollupToLatestPerName(rows)).toEqual([failed]);
      expect(strict(rows)).toEqual([failed]);
    }
  });

  it.each([undefined, 0, 'unreadable'])('unknown workflow run identity (%s) cannot borrow another run\'s attempt ordering', run_id => {
    const failed = check(10, 'FAILURE', { workflowName: 'ci', run_id, run_attempt: 1 });
    const success = check(20, 'SUCCESS', { workflowName: 'ci', run_id: 42, runAttempt: 2 });
    for (const rows of [[failed, success], [success, failed]]) {
      expect(collapseRollupToLatestPerName(rows)).toEqual([failed]);
      expect(strict(rows)).toEqual(rows);
    }
  });

  it.each([{}, { run_attempt: 0 }, { run_attempt: 'unreadable' }])('missing or invalid attempt evidence remains in force (%j)', extra => {
    const failed = check(10, 'FAILURE', { workflowName: 'ci', ...extra });
    const success = check(20, 'SUCCESS', { workflowName: 'ci', run_attempt: 2 });
    for (const rows of [[failed, success], [success, failed]]) {
      expect(collapseRollupToLatestPerName(rows)).toEqual([failed]);
      expect(strict(rows)).toEqual(rows);
    }
  });

  it('equal explicit attempts cannot supersede a failure using check IDs or timestamps', () => {
    const rows = [
      check(10, 'FAILURE', { workflowName: 'ci', run_attempt: 2, completedAt: '2026-11-17T01:00:00Z' }),
      check(20, 'SUCCESS', { workflowName: 'ci', runAttempt: 2, completedAt: '2026-11-17T02:00:00Z' }),
    ];
    for (const input of [rows, rows.toReversed()]) {
      expect(collapseRollupToLatestPerName(input)).toEqual([rows[0]]);
      expect(strict(input)).toEqual(input);
    }
  });

  it.each([
    [{ workflowName: 'ci' }, { workflowName: 'review' }],
    [{ workflowRun: { workflow: { id: 'ci' } } }, { workflowRun: { workflow: { id: 'review' } } }],
    [{ checkSuite: { id: 'suite-a' } }, { checkSuite: { id: 'suite-b' } }],
    [{ workflowName: 'ci', check_suite: { id: 1 } }, { workflowName: 'ci', check_suite: { id: 2 } }],
  ])('different sources never supersede same-name failures (%j, %j)', (a, b) => {
    const rows = [check(10, 'FAILURE', a), check(20, 'SUCCESS', b)];
    for (const input of [rows, rows.toReversed()]) {
      expect(collapseRollupToLatestPerName(input)).toEqual(input);
      expect(strict(input)).toEqual(input);
      expect(latestCheckNamed(input, 'review-gate')).toBe(rows[0]);
    }
  });

  it('unknown sources stay separate even with ordered check IDs', () => {
    const rows = [check(10, 'FAILURE'), check(20, 'SUCCESS')];
    expect(strict(rows)).toEqual(rows);
    // Check IDs alone never prove a rerun, including for scalar consumers.
    expect(collapseRollupToLatestPerName(rows)).toEqual([rows[0]]);
  });

  it('a scalar lookup retains unfinished evidence from another workflow beside success', () => {
    const rows = [check(10, 'SUCCESS', { workflowName: 'ci' }),
      check(20, null, { workflowName: 'review', status: 'IN_PROGRESS' })];
    expect(latestCheckNamed(rows, 'review-gate')).toBe(rows[1]);
    expect(latestCheckNamed(rows.toReversed(), 'review-gate')).toBe(rows[1]);
  });

  it('unordered attempts of a known job remain separate', () => {
    const rows = [check(undefined, 'FAILURE', { workflowName: 'ci' }), check(undefined, 'SUCCESS', { workflowName: 'ci' })];
    expect(strict(rows)).toEqual(rows);
  });

  it.each(['completedAt', 'completed_at'])('same-job reruns use %s when check IDs are absent', field => {
    const rows = [
      check(undefined, 'FAILURE', { workflowName: 'ci', [field]: '2026-11-17T01:00:00Z' }),
      check(undefined, 'SUCCESS', { workflowName: 'ci', [field]: '2026-11-17T02:00:00Z' }),
    ];
    expect(strict(rows)).toEqual([rows[1]]);
    expect(strict(rows.toReversed())).toEqual([rows[1]]);
  });

  it.each(['completedAt', 'completed_at'])('equal %s completion timestamps preserve conflicting attempts in both input orders', field => {
    const rows = [
      check(undefined, 'FAILURE', { workflowName: 'ci', [field]: '2026-11-17T01:00:00Z' }),
      check(undefined, 'SUCCESS', { workflowName: 'ci', [field]: '2026-11-17T01:00:00Z' }),
    ];
    expect(strict(rows)).toEqual(rows);
    expect(strict(rows.toReversed())).toEqual(rows.toReversed());
  });

  it('same-suite check IDs alone do not supersede conflicting evidence', () => {
    const rows = [check(10, 'FAILURE', { check_suite: { id: 42 } }), check(20, 'SUCCESS', { check_suite: { id: 42 } })];
    expect(strict(rows)).toEqual(rows);
    expect(strict(rows.toReversed())).toEqual(rows.toReversed());
  });
});
