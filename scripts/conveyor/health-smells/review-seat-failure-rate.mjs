/**
 * review-seat-failure-rate — too many review juror seats are failing (held item 223, item 5).
 *
 * Live 2026-10-10: 17 seats across 15 of 119 review runs died on "judge-spawn: the juror did not emit parseable JSON
 * on stdout" (judgeSecurity 11, judge 6), rising through the day. Each one ended its review `blocked-on-infra`, the
 * PR waited ~17 min for the next review start, and the health report said nothing — the loss was found by hand
 * from the review-job logs. `we:scripts/lib/judge-spawn.mjs` now retries such a seat once; this smell is what says
 * when the retry is no longer enough.
 *
 * WHAT IS COUNTED, over `review-pr` run records whose `read` step started inside the window:
 *   - a SEAT is one juror spawn: a telemetry row whose step is a `judge*` step;
 *   - a FAILED seat is a row carrying `failure` (written from the spawn error's telemetry, `we:scripts/operations/
 *     run-record.mjs` allow-list), OR — for records written before that row existed — a run stopped on a judge
 *     step with no row for it, once that seat started more than `inFlightMs` ago (a seat still running is not a
 *     failure). That second case also counts as one seat.
 *   - a RETRIED seat (`attempts > 1`) answered on its retry; reported, not counted as a failure.
 *
 * THE THRESHOLD IS A CASCADE SETTING: env `WE_REVIEW_SEAT_FAILURE_RATE_MAX` > `we:scripts/settings/review.json`
 * key `seatFailureRateMax` > built-in 0.05. 0.05 sits just above the measured 2026-10-10 rate BEFORE the retry (17
 * failed of ~400 seats ≈ 4 %), so with the retry working this should be quiet, and a breach means the retry is not
 * absorbing the losses. No breach below `minSeats` seats: a rate over a handful of seats is noise.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOUR, MINUTE, fmtAge } from '../health-watch-core.mjs';

const REVIEW_SETTINGS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'settings', 'review.json');

/** The threshold's cascade: env > settings file > built-in. */
export const SEAT_FAILURE_RATE_SETTING = Object.freeze({ key: 'seatFailureRateMax', env: 'WE_REVIEW_SEAT_FAILURE_RATE_MAX', builtIn: 0.05 });

/** A failure-rate threshold in (0, 1], or null when the layer says nothing usable. PURE. */
function validRate(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 1 ? n : null;
}

/**
 * Resolve the threshold. Never throws: an unreadable or invalid settings file is the built-in.
 * @returns {{value: number, source: 'env'|'settings'|'default'}}
 */
export function resolveSeatFailureRateMax({ env = process.env, readFile = (p) => readFileSync(p, 'utf8'), file = REVIEW_SETTINGS_FILE } = {}) {
  const fromEnv = validRate(env?.[SEAT_FAILURE_RATE_SETTING.env]);
  if (fromEnv !== null) return { value: fromEnv, source: 'env' };
  try {
    const fromFile = validRate(JSON.parse(readFile(file))?.[SEAT_FAILURE_RATE_SETTING.key]);
    if (fromFile !== null) return { value: fromFile, source: 'settings' };
  } catch { /* built-in */ }
  return { value: SEAT_FAILURE_RATE_SETTING.builtIn, source: 'default' };
}

const isJudgeStep = (step) => typeof step === 'string' && step.startsWith('judge');

/**
 * PURE: count seats, failed seats and retried seats over the window's review runs.
 * @returns {{seats: number, failed: number, retried: number, runs: number, failedByStep: Record<string, number>}}
 */
export function summarizeSeatFailures(operationRuns, { now, windowMs = 3 * HOUR, inFlightMs = 30 * MINUTE } = {}) {
  const s = { seats: 0, failed: 0, retried: 0, runs: 0, failedByStep: {} };
  const fail = (step) => { s.failed += 1; s.failedByStep[step] = (s.failedByStep[step] || 0) + 1; };
  for (const run of operationRuns ?? []) {
    if (run?.op !== 'review-pr') continue;
    const timings = Array.isArray(run.stepTimings) ? run.stepTimings : [];
    const started = Date.parse(timings.find((t) => t.step === 'read')?.startedAt ?? '');
    if (!Number.isFinite(started) || started < now - windowMs || started > now + MINUTE) continue;
    s.runs += 1;
    const rows = (Array.isArray(run.telemetry) ? run.telemetry : []).filter((t) => isJudgeStep(t?.step));
    for (const row of rows) {
      s.seats += 1;
      if (typeof row.failure === 'string' && row.failure) fail(row.step);
      else if (typeof row.attempts === 'number' && row.attempts > 1) s.retried += 1;
    }
    const p = run.pending;
    if (p?.kind === 'judge' && !rows.some((r) => r.stepIndex === p.stepIndex)) {
      const seatStart = Date.parse(timings.find((t) => t.stepIndex === p.stepIndex)?.startedAt ?? '');
      if (Number.isFinite(seatStart) && now - seatStart > inFlightMs) { s.seats += 1; fail(p.step); }
    }
  }
  return s;
}

export default {
  id: 'review-seat-failure-rate',
  scope: 'host',
  cadence: 'every-tick',
  probes: ['operationRuns'],
  openAfter: 1,
  closeAfter: 2,
  severity: 'high',
  action: 'investigate',
  windowMs: 3 * HOUR,
  inFlightMs: 30 * MINUTE,
  minSeats: 20,
  recommendationHint: 'Review juror seats are failing faster than the retry absorbs; each failure stops a review blocked-on-infra.',
  evaluate({ operationRuns }, { now, env = process.env, readSettings } = {}) {
    const s = summarizeSeatFailures(operationRuns, { now, windowMs: this.windowMs, inFlightMs: this.inFlightMs });
    const threshold = resolveSeatFailureRateMax({ env, ...(readSettings ? { readFile: readSettings } : {}) });
    const rate = s.seats ? s.failed / s.seats : 0;
    const top = Object.entries(s.failedByStep).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(', ');
    return [{
      subject: 'review-seats',
      breach: s.seats >= this.minSeats && rate >= threshold.value,
      measure: {
        seats: s.seats, failed: s.failed, rate: Math.round(rate * 1000) / 1000, retried: s.retried, runs: s.runs,
        failedByStep: s.failedByStep, threshold: threshold.value, thresholdSource: threshold.source, windowMs: this.windowMs,
      },
      summary: `review seats in ${fmtAge(this.windowMs)}: ${s.failed}/${s.seats} failed (${Math.round(rate * 1000) / 10}%, threshold ${threshold.value * 100}% from ${threshold.source})`
        + `${top ? `; ${top}` : ''}${s.retried ? `; ${s.retried} answered on a retry` : ''}.`,
      recommendation: 'Read the failed seats\' exitCode / signal / stderrTail on their run records (telemetry rows with `failure`) to see '
        + 'whether the jurors were killed, crashed or printed nothing; the retry count is `judgeUnparseableRetries` '
        + '(env WE_JUDGE_UNPARSEABLE_RETRIES).',
    }];
  },
};
