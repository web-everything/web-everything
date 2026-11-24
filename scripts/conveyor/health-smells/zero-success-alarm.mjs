/**
 * @file scripts/conveyor/health-smells/zero-success-alarm.mjs
 * @description zero-success-alarm (2026-11-24) — any daemon tick loop (prepare, drain catch-up, fix) whose ticks had
 *   work but ZERO successes for an hour. Generic counterpart of the per-daemon builder-starved and
 *   drain-failing-repeatedly smells. One episode per loop per outage (the episode store dedupes); it closes on the
 *   first success. Reads the `loopTicks` probe (`{ records }`); no probe means no verdict. Read-only: it never
 *   changes daemon state, labels or merges.
 */
import { MINUTE, fmtAge } from '../health-watch-core.mjs';
import { zeroSuccessVerdicts, zeroSuccessWindowMinutes, zeroSuccessMinTicks } from '../health-loop-ticks.mjs';

export default {
  id: 'zero-success-alarm',
  scope: 'host',
  cadence: 'every-tick',
  probes: ['loopTicks'],
  openAfter: 1,
  closeAfter: 1,
  severity: 'high',
  action: 'alert',
  recommendationHint: 'A daemon loop has had work but no success for an hour. Read that loop\'s latest tick error, and run the stuck-PR trace for the PRs waiting on it.',
  evaluate({ loopTicks }, { now, env = process.env }) {
    const windowMin = zeroSuccessWindowMinutes(env);
    const verdicts = zeroSuccessVerdicts(loopTicks?.records, { now, windowMs: windowMin * MINUTE, minTicks: zeroSuccessMinTicks(env) });
    return verdicts.map((v) => ({
      subject: v.loop,
      breach: v.breach,
      measure: { ticksWithWork: v.ticks, failures: v.failures, windowMinutes: windowMin, since: v.sinceAt ? new Date(v.sinceAt).toISOString() : null, dominantError: v.dominantError },
      summary: `${v.loop}: ${v.failures} failure(s) over ${v.ticks} tick(s) with work and no success for ${v.sinceAt ? fmtAge(now - v.sinceAt) : `${windowMin}m`}${v.dominantError ? ` — ${v.dominantError}` : ''}.`,
      recommendation: this.recommendationHint,
    }));
  },
};
