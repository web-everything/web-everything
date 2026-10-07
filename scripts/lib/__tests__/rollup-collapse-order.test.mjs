import { describe, it, expect } from 'vitest';
import { collapseRollupToLatestPerName } from '../rollup-collapse.mjs';

const run = (name, conclusion, completedAt, extra = {}) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion, completedAt, ...extra });

describe('rollup collapse is order-independent without run ids (live #4290, 2026-10-07)', () => {
  it('a newer FAILURE listed BEFORE its superseded SUCCESS is still the latest run', () => {
    const rows = collapseRollupToLatestPerName([
      run('soak-replay-gate', 'FAILURE', '2026-10-07T17:27:15Z'),
      run('soak-replay-gate', 'CANCELLED', '2026-10-07T17:26:38Z'),
      run('soak-replay-gate', 'SUCCESS', '2026-10-07T17:13:47Z'),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].conclusion).toBe('FAILURE');
  });
  it('an in-flight rerun (zero-date completedAt) beats every completed run, in any position', () => {
    const rows = collapseRollupToLatestPerName([
      run('test', 'SUCCESS', '2026-10-07T17:00:00Z'),
      { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: '', completedAt: '0001-01-01T00:00:00Z' },
      run('test', 'FAILURE', '2026-10-07T16:00:00Z'),
    ]);
    expect(rows[0].status).toBe('IN_PROGRESS');
  });
  it('rows without usable timestamps keep the positional rule', () => {
    const rows = collapseRollupToLatestPerName([
      { __typename: 'CheckRun', name: 'x', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'CheckRun', name: 'x', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ]);
    expect(rows[0].conclusion).toBe('SUCCESS');
  });
});
