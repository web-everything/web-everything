/** Shared abandonment and replacement-review deadlines, with standard/platform/tool/env provenance. */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCascade, readPlatformPreferences, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { boundedText } from './host-overload-settings.mjs';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const HOUR = 3600000, MINUTE = 60000;

export function resolveReviewRunReaperSettings({ env, log, tool, thresholdMs }) {
  const p = readPlatformPreferences({ env, readFile: path => boundedText(path) });
  if (p.errors.length) throw Error(p.errors.join('; '));
  if (tool === undefined) {
    try { tool = JSON.parse(boundedText(join(ROOT, 'scripts/settings/review-run-reaper.json'))).reviewRunReaper; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const r = resolveCascade({ standard: { abandonAfterHours: 6, abandonStuckAfterMinutes: 30, abandonStuckJudgeAfterMinutes: 30 }, platform: p.prefs.reviewRunReaper, tool,
    envValues: { abandonAfterHours: env.WE_REAP_DEAD_REVIEW_RUNS_AFTER_HOURS === undefined ? undefined : Number(env.WE_REAP_DEAD_REVIEW_RUNS_AFTER_HOURS),
      abandonStuckAfterMinutes: env.WE_REAP_DEAD_REVIEW_RUNS_STUCK_AFTER_MINUTES === undefined ? undefined : Number(env.WE_REAP_DEAD_REVIEW_RUNS_STUCK_AFTER_MINUTES),
      abandonStuckJudgeAfterMinutes: env.WE_REAP_DEAD_REVIEW_RUNS_STUCK_JUDGE_AFTER_MINUTES === undefined ? undefined : Number(env.WE_REAP_DEAD_REVIEW_RUNS_STUCK_JUDGE_AFTER_MINUTES) },
    valid: Object.fromEntries(['abandonAfterHours', 'abandonStuckAfterMinutes', 'abandonStuckJudgeAfterMinutes'].map(k => [k, v => typeof v === 'number' && Number.isFinite(v) && v > 0])) });
  log(formatCascadeSourcesLine('reviewRunReaper', r));
  if (thresholdMs !== undefined && (!Number.isFinite(thresholdMs) || thresholdMs <= 0)) throw Error('thresholdMs must be positive and finite');
  const ms = thresholdMs ?? r.value.abandonAfterHours * HOUR;
  const source = thresholdMs === undefined ? r.sources.abandonAfterHours : 'argument';
  log(`reviewRunReaper: threshold=${ms / HOUR}h (${source})`);
  return { thresholdMs: ms, thresholdSource: source, stuckThresholdMs: r.value.abandonStuckAfterMinutes * MINUTE,
    stuckThresholdSource: r.sources.abandonStuckAfterMinutes,
    stuckJudgeThresholdMs: r.value.abandonStuckJudgeAfterMinutes * MINUTE, stuckJudgeThresholdSource: r.sources.abandonStuckJudgeAfterMinutes };
}

/** Confirm/referral holds are excluded by the caller. Other non-effect cursors get their own deadline. */
export const stuckReviewKind = run => run.pending != null && run.pending.kind !== 'effect' ? 'judge' : 'effect';
export function stuckReviewThreshold(run, settings) {
  return stuckReviewKind(run) === 'judge'
    ? { ms: settings.stuckJudgeThresholdMs, source: settings.stuckJudgeThresholdSource }
    : { ms: settings.stuckThresholdMs, source: settings.stuckThresholdSource };
}
