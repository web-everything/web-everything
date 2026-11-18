import { describe, it, expect } from 'vitest';
import { collapseRollupToLatestPerName, latestCheckNamed } from '../rollup-collapse.mjs';

const check = (id, conclusion, extra = {}) => ({ name: 'review-gate', id, status: 'COMPLETED', conclusion, ...extra });
const strict = rows => collapseRollupToLatestPerName(rows, { preserveUnknownJobs: true });

describe('rollup job identity', () => {
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
    // Preserve the legacy API for consumers without per-row evidence guards.
    expect(collapseRollupToLatestPerName(rows)).toEqual([rows[1]]);
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

  it('same-job reruns use check ID regardless of input order', () => {
    const rows = [check(10, 'FAILURE', { check_suite: { id: 42 } }), check(20, 'SUCCESS', { check_suite: { id: 42 } })];
    expect(strict(rows)).toEqual([rows[1]]);
    expect(strict(rows.toReversed())).toEqual([rows[1]]);
  });
});
