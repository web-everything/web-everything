/**
 * @file review-seat-failure-rate.test.mjs — held item 223, item 5: a health smell when the share of review juror
 * seats that fail passes a cascade setting. Pure `evaluate()` over plain `operationRuns` fixtures (no fs).
 *
 * Live 2026-10-10: 17 seats across 15 of 119 review runs died on "the juror did not emit parseable JSON on stdout"
 * and nothing in the health report said so — the loss surfaced only as PRs waiting ~17 min for the next review.
 */
import { describe, it, expect } from 'vitest';
import smell, { resolveSeatFailureRateMax, SEAT_FAILURE_RATE_SETTING, summarizeSeatFailures } from '../review-seat-failure-rate.mjs';
import { SMELLS } from '../index.mjs';

const now = Date.parse('2026-10-10T23:00:00Z');
const at = (min) => new Date(now - min * 60_000).toISOString();
const ok = (step, extra = {}) => ({ step, stepIndex: 1, costUsd: 0.3, ...extra });
const failedRow = (step) => ({ step, stepIndex: 2, sessionId: 's', wallMs: 60_000, exitCode: 143, attempts: 2, failure: 'unparseable-stdout' });
/** A review run whose seats all answered. */
const goodRun = (min, rows = [ok('judge'), ok('judgeSecurity'), ok('judgeAdvisory')]) => ({
  op: 'review-pr', id: `r-${min}-${Math.random()}`, input: { pr: 1 }, stepTimings: [{ step: 'read', stepIndex: 0, startedAt: at(min) }],
  telemetry: rows, pending: null,
});
/** A run stopped on a failed seat, recorded with the new failure row. */
const failedRun = (min) => ({ ...goodRun(min, [ok('judge'), failedRow('judgeSecurity')]), pending: { kind: 'judge', step: 'judgeSecurity', stepIndex: 2 } });
/** A run from before the failure row existed: stopped on a judge seat with no row for it, long past. */
const legacyFailedRun = (min) => ({
  ...goodRun(min, [ok('judge')]), pending: { kind: 'judge', step: 'judgeSecurity', stepIndex: 2 },
  stepTimings: [{ step: 'read', stepIndex: 0, startedAt: at(min) }, { step: 'judgeSecurity', stepIndex: 2, startedAt: at(min - 1) }],
});
const evaluate = (operationRuns, env = {}) => smell.evaluate({ operationRuns }, { now, env, readSettings: () => '{}' });

describe('review-seat-failure-rate', () => {
  it('is registered as a smell over the operation runs', () => {
    expect(SMELLS.find((s) => s.id === smell.id)).toBe(smell);
    expect(smell.probes).toEqual(['operationRuns']);
  });

  it('breaches when the failed share of seats passes the threshold', () => {
    const runs = [...Array.from({ length: 9 }, (_, i) => goodRun(10 + i)), failedRun(5), failedRun(6)];
    const [r] = evaluate(runs, { [SEAT_FAILURE_RATE_SETTING.env]: '0.05' });
    expect(r.breach).toBe(true);
    expect(r.measure).toMatchObject({ seats: 31, failed: 2, threshold: 0.05, thresholdSource: 'env' });
    expect(r.summary).toMatch(/2\/31/);
  });

  it('stays quiet under the threshold, and under the minimum sample', () => {
    const runs = [...Array.from({ length: 20 }, (_, i) => goodRun(10 + i)), failedRun(5)];
    expect(evaluate(runs)[0].breach).toBe(false); // 1/62 < 5 %
    expect(evaluate([failedRun(5), goodRun(6)])[0].breach).toBe(false); // too few seats to judge a rate
  });

  it('counts a legacy stopped seat (no failure row) once it is past the in-flight allowance, but not a seat still running', () => {
    expect(summarizeSeatFailures([legacyFailedRun(60)], { now, windowMs: 3 * 3_600_000 }).failed).toBe(1);
    expect(summarizeSeatFailures([legacyFailedRun(2)], { now, windowMs: 3 * 3_600_000 }).failed).toBe(0);
  });

  it('ignores runs outside the window and non-review operations, and reports retried seats', () => {
    const s = summarizeSeatFailures([goodRun(5, [ok('judge', { attempts: 2 })]), goodRun(400), { ...failedRun(5), op: 'explore' }], { now, windowMs: 3 * 3_600_000 });
    expect(s).toMatchObject({ seats: 1, failed: 0, retried: 1 });
  });
});

describe('resolveSeatFailureRateMax — the threshold is a cascade setting', () => {
  const k = SEAT_FAILURE_RATE_SETTING.key;
  const e = SEAT_FAILURE_RATE_SETTING.env;
  it('env > settings file > built-in; an out-of-range value falls through', () => {
    expect(resolveSeatFailureRateMax({ env: {}, readFile: () => '{}' })).toEqual({ value: SEAT_FAILURE_RATE_SETTING.builtIn, source: 'default' });
    expect(resolveSeatFailureRateMax({ env: {}, readFile: () => JSON.stringify({ [k]: 0.1 }) })).toEqual({ value: 0.1, source: 'settings' });
    expect(resolveSeatFailureRateMax({ env: { [e]: '0.2' }, readFile: () => JSON.stringify({ [k]: 0.1 }) })).toEqual({ value: 0.2, source: 'env' });
    expect(resolveSeatFailureRateMax({ env: { [e]: '7' }, readFile: () => JSON.stringify({ [k]: 'x' }) }).source).toBe('default');
    expect(resolveSeatFailureRateMax({ env: {}, readFile: () => { throw new Error('ENOENT'); } }).source).toBe('default');
  });
});
