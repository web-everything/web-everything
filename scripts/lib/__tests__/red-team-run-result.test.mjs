import { describe, expect, it } from 'vitest';
import { redTeamStatusWithoutRun } from '../red-team-run-result.mjs';

const at = '2026-10-29T12:00:00.000Z';
const abandoned = { status: 'running', pid: 1234, result: null,
  staleAbandoned: { at, pid: 1234, reason: 'running red team owner is dead' } };

describe('redTeamStatusWithoutRun', () => {
  it.each([null, undefined])('accepts an abandoned stale running pass with result %s only with explicit opt-in', result => {
    expect(redTeamStatusWithoutRun({ ...abandoned, result }, { allowAbandonedRunning: true })).toBe(true);
  });

  it.each([null, undefined])('rejects an abandoned running pass with result %s by default', result => {
    const row = { ...abandoned, result };
    expect(redTeamStatusWithoutRun(row)).toBe(false);
    expect(redTeamStatusWithoutRun(row, {})).toBe(false);
    expect(redTeamStatusWithoutRun(row, { originalStatus: { status: 'queued' } })).toBe(false);
  });

  it.each([false, null, 1, 'true'])('rejects an abandoned running pass with non-true opt-in %j', allowAbandonedRunning => {
    expect(redTeamStatusWithoutRun(abandoned, { allowAbandonedRunning })).toBe(false);
  });

  it('accepts a finite numeric abandonment time', () => {
    expect(redTeamStatusWithoutRun({ ...abandoned,
      staleAbandoned: { at: Date.parse(at), pid: abandoned.pid } }, { allowAbandonedRunning: true })).toBe(true);
  });

  it.each([
    ['absent row', null],
    ['running without abandonment', { ...abandoned, staleAbandoned: undefined }],
    ['null abandonment', { ...abandoned, staleAbandoned: null }],
    ['non-object abandonment', { ...abandoned, staleAbandoned: 'abandoned' }],
    ['queued', { ...abandoned, status: 'queued' }],
    ['finished null without queued provenance', { ...abandoned, status: 'finished' }],
    ['finished real result', { ...abandoned, status: 'finished', result: { status: 'ran', comment: { status: 'posted' } } }],
    ['running real result', { ...abandoned, result: { status: 'ran' } }],
    ['running legacy result', { ...abandoned, result: 'ran' }],
    ['spent retry', { ...abandoned, retryCount: 1 }],
  ])('refuses %s', (_name, row) => {
    expect(redTeamStatusWithoutRun(row)).toBe(false);
    expect(redTeamStatusWithoutRun(row, { allowAbandonedRunning: true })).toBe(false);
  });

  it.each([undefined, null, '', 'invalid', NaN, Infinity, -Infinity])('refuses invalid abandonment time %s', time => {
    expect(redTeamStatusWithoutRun({ ...abandoned, staleAbandoned: { at: time, pid: abandoned.pid } })).toBe(false);
    expect(redTeamStatusWithoutRun({ ...abandoned, staleAbandoned: { at: time, pid: abandoned.pid } },
      { allowAbandonedRunning: true })).toBe(false);
  });

  it.each([undefined, null, 1235, 1234.5, '1234'])('refuses invalid or mismatched abandonment pid %s', pid => {
    expect(redTeamStatusWithoutRun({ ...abandoned, staleAbandoned: { at, pid } })).toBe(false);
    expect(redTeamStatusWithoutRun({ ...abandoned, staleAbandoned: { at, pid } },
      { allowAbandonedRunning: true })).toBe(false);
  });

  it('refuses matching noninteger pids', () => {
    expect(redTeamStatusWithoutRun({ ...abandoned, pid: '1234', staleAbandoned: { at, pid: '1234' } })).toBe(false);
    expect(redTeamStatusWithoutRun({ ...abandoned, pid: '1234', staleAbandoned: { at, pid: '1234' } },
      { allowAbandonedRunning: true })).toBe(false);
  });

  it('keeps finished null recovery limited to original queued provenance', () => {
    const row = { status: 'finished', result: null };
    expect(redTeamStatusWithoutRun(row)).toBe(false);
    expect(redTeamStatusWithoutRun(row, { originalStatus: { status: 'queued' } })).toBe(true);
  });

  it.each(['ran', 'resumed', { status: 'resumed' }])('preserves legacy finished placeholders %j', result => {
    expect(redTeamStatusWithoutRun({ status: 'finished', result })).toBe(true);
  });
});
