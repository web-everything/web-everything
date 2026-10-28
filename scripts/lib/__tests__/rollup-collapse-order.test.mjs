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
  it.each([
    { name: 'typed success supersedes cancellation', tagged: true, older: 'CANCELLED', newer: 'SUCCESS' },
    { name: 'untagged success supersedes cancellation', tagged: false, older: 'CANCELLED', newer: 'SUCCESS' },
    { name: 'typed failure supersedes success', tagged: true, older: 'SUCCESS', newer: 'FAILURE' },
    { name: 'untagged cancellation supersedes success', tagged: false, older: 'SUCCESS', newer: 'CANCELLED' },
  ])('completed runs without completedAt use startedAt in either order: $name', ({ tagged, older, newer }) => {
    const row = (conclusion, startedAt) => ({ ...(tagged ? { __typename: 'CheckRun' } : {}),
      name: 'smoke', status: 'COMPLETED', conclusion, startedAt });
    const oldRun = row(older, '2026-10-27T01:00:00Z');
    const newRun = row(newer, '2026-10-27T02:00:00Z');
    for (const rows of [[newRun, oldRun], [oldRun, newRun]]) {
      expect(collapseRollupToLatestPerName(rows)).toEqual([newRun]);
    }
  });
  it('an in-flight rerun outranks completed runs with only startedAt, even with a zero start date', () => {
    const pending = { __typename: 'CheckRun', name: 'test', status: 'QUEUED', startedAt: '0001-01-01T00:00:00Z' };
    const done = run('test', 'SUCCESS', undefined, { startedAt: '2026-10-27T02:00:00Z' });
    for (const rows of [[pending, done], [done, pending]]) {
      expect(collapseRollupToLatestPerName(rows)).toEqual([pending]);
    }
  });
  it('run ids remain authoritative over start timestamps', () => {
    const newestId = run('test', 'FAILURE', undefined, { id: 20, startedAt: '2026-10-27T01:00:00Z' });
    const newestTime = run('test', 'SUCCESS', undefined, { id: 10, startedAt: '2026-10-27T02:00:00Z' });
    expect(collapseRollupToLatestPerName([newestId, newestTime])).toEqual([newestId]);
  });
  it('valid completion timestamps remain authoritative over start timestamps', () => {
    const lastFinished = run('test', 'FAILURE', '2026-10-27T03:00:00Z', { startedAt: '2026-10-27T01:00:00Z' });
    const lastStarted = run('test', 'SUCCESS', '2026-10-27T02:00:00Z', { startedAt: '2026-10-27T01:30:00Z' });
    expect(collapseRollupToLatestPerName([lastFinished, lastStarted])).toEqual([lastFinished]);
  });
  it.each(['0001-01-01T00:00:00Z', 'invalid', null])('unusable completedAt %s falls back to a valid startedAt', completedAt => {
    const newer = run('test', 'FAILURE', completedAt, { startedAt: '2026-10-27T02:00:00Z' });
    const older = run('test', 'SUCCESS', completedAt, { startedAt: '2026-10-27T01:00:00Z' });
    expect(collapseRollupToLatestPerName([newer, older])).toEqual([newer]);
  });
  it.each(['0001-01-01T00:00:00Z', 'invalid', undefined])('unusable startedAt %s preserves the positional fallback', startedAt => {
    const dated = run('test', 'FAILURE', undefined, { startedAt: '2026-10-27T02:00:00Z' });
    const undated = run('test', 'SUCCESS', undefined, { startedAt });
    expect(collapseRollupToLatestPerName([dated, undated])).toEqual([undated]);
    expect(collapseRollupToLatestPerName([undated, dated])).toEqual([dated]);
  });
  it('rows without usable timestamps keep the positional rule', () => {
    const rows = collapseRollupToLatestPerName([
      { __typename: 'CheckRun', name: 'x', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'CheckRun', name: 'x', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ]);
    expect(rows[0].conclusion).toBe('SUCCESS');
  });
});
