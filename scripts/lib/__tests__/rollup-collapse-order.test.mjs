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
  it('mixed completion and fallback start timestamps fail closed to the non-passing run in either order', () => {
    const olderA = run('test', 'SUCCESS', '2026-10-27T10:30:00Z');
    const newerB = run('test', 'FAILURE', '0001-01-01T00:00:00Z', { startedAt: '2026-10-27T10:10:00Z' });
    expect(collapseRollupToLatestPerName([olderA, newerB])).toEqual([newerB]);
    expect(collapseRollupToLatestPerName([newerB, olderA])).toEqual([newerB]);
  });
  it('mixed timestamp kinds keep FAILURE started at 11:00 before SUCCESS completed at 10:00', () => {
    const failure = run('test', 'FAILURE', undefined, { startedAt: '2026-10-27T11:00:00Z' });
    const success = run('test', 'SUCCESS', '2026-10-27T10:00:00Z');
    expect(collapseRollupToLatestPerName([failure, success])).toEqual([failure]);
  });
  it.each(['FAILURE', 'ERROR', 'cAnCeLlEd', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'sTaLe'])('mixed timestamp kinds select the LAST failed conclusion: %s', conclusion => {
    const first = run('test', 'FAILURE', '2026-10-27T10:00:00Z');
    const last = run('test', conclusion, undefined, { startedAt: '2026-10-27T11:00:00Z' });
    const success = run('test', 'SUCCESS', '2026-10-27T12:00:00Z');
    expect(collapseRollupToLatestPerName([first, last, success])).toEqual([last]);
  });
  it.each(['UNKNOWN', '', null, undefined])('mixed timestamp kinds keep FAILURE over an odd conclusion in either order: %s', conclusion => {
    const failure = run('test', 'FAILURE', '2026-10-27T12:00:00Z');
    const odd = run('test', conclusion, undefined, { startedAt: '2026-10-27T11:00:00Z' });
    expect(collapseRollupToLatestPerName([failure, odd])).toEqual([failure]);
    expect(collapseRollupToLatestPerName([odd, failure])).toEqual([failure]);
  });
  it.each(['UNKNOWN', '', null, undefined])('mixed timestamp kinds select the LAST non-passing run when none failed: %s', conclusion => {
    const first = run('test', 'UNKNOWN', '2026-10-27T10:00:00Z');
    const last = run('test', conclusion, undefined, { startedAt: '2026-10-27T11:00:00Z' });
    const success = run('test', 'SUCCESS', '2026-10-27T12:00:00Z');
    expect(collapseRollupToLatestPerName([first, last, success])).toEqual([last]);
  });
  it('mixed timestamp kinds use state on state-style rows', () => {
    const failure = { context: 'test', state: 'fAiLuRe', status: 'COMPLETED', startedAt: '2026-10-27T11:00:00Z' };
    const success = { context: 'test', state: 'sUcCeSs', completedAt: '2026-10-27T10:00:00Z' };
    expect(collapseRollupToLatestPerName([failure, success])).toEqual([failure]);
  });
  it.each(['SUCCESS', 'sUcCeSs', 'nEuTrAl', 'sKiPpEd'])('overlapping all-passing mixed timestamp kinds keep the positional last run: %s', conclusion => {
    const started = run('test', 'SUCCESS', undefined, { startedAt: '2026-10-27T09:00:00Z' });
    const completed = run('test', conclusion, '2026-10-27T10:00:00Z');
    expect(collapseRollupToLatestPerName([started, completed])).toEqual([completed]);
    expect(collapseRollupToLatestPerName([completed, started])).toEqual([started]);
  });
  it.each(['SUCCESS', 'NEUTRAL', 'SKIPPED', 'FAILURE', 'CANCELLED', 'STALE'])(
    'a completed rerun starting after every other completion supersedes prior failures: %s', conclusion => {
      const older = run('merge-gate', 'FAILURE', '2026-10-27T10:00:00Z');
      const newest = run('merge-gate', conclusion, undefined, { startedAt: '2026-10-27T11:00:00Z' });
      for (const rows of [[older, newest], [newest, older]]) {
        expect(collapseRollupToLatestPerName(rows)).toEqual([newest]);
      }
    });
  it.each(['SUCCESS', 'sUcCeSs', 'nEuTrAl', 'sKiPpEd'])(
    'a sole start after all completions proves the latest run even when all runs pass: %s', conclusion => {
      const started = run('test', 'SUCCESS', undefined, { startedAt: '2026-10-27T11:00:00Z' });
      const completed = run('test', conclusion, '2026-10-27T10:00:00Z');
      expect(collapseRollupToLatestPerName([started, completed])).toEqual([started]);
      expect(collapseRollupToLatestPerName([completed, started])).toEqual([started]);
    });
  it('equal start and completion timestamps do not prove the failure was superseded', () => {
    const failure = run('test', 'FAILURE', '2026-10-27T10:00:00Z');
    const success = run('test', 'SUCCESS', undefined, { startedAt: '2026-10-27T10:00:00Z' });
    expect(collapseRollupToLatestPerName([failure, success])).toEqual([failure]);
    expect(collapseRollupToLatestPerName([success, failure])).toEqual([failure]);
  });
  it('a later start cannot prove ordering against another start-only completed run', () => {
    const failure = run('test', 'FAILURE', '2026-10-27T10:00:00Z');
    const started = run('test', 'SUCCESS', undefined, { startedAt: '2026-10-27T11:00:00Z' });
    const alsoStarted = run('test', 'SUCCESS', undefined, { startedAt: '2026-10-27T12:00:00Z' });
    for (const rows of [[failure, started, alsoStarted], [alsoStarted, started, failure]]) {
      expect(collapseRollupToLatestPerName(rows)).toEqual([failure]);
    }
  });
  it('an in-flight rerun outranks both completed timestamp kinds in every input order', () => {
    const pending = { __typename: 'CheckRun', name: 'test', status: 'QUEUED', completedAt: '0001-01-01T00:00:00Z' };
    const started = run('test', 'SUCCESS', '0001-01-01T00:00:00Z', { startedAt: '2026-10-27T10:10:00Z' });
    const completed = run('test', 'SUCCESS', '2026-10-27T10:30:00Z');
    for (const rows of [
      [pending, started, completed], [pending, completed, started],
      [started, pending, completed], [completed, pending, started],
      [started, completed, pending], [completed, started, pending],
    ]) {
      expect(collapseRollupToLatestPerName(rows)).toEqual([pending]);
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
