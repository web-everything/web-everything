/**
 * Abandon a dead review cursor without reconciling or claiming its unknown effects applied.
 * `run.mjs review-abandon [--run=<id>] [--apply] [--json]` previews by default; without
 * --run it sweeps the shared review store. The reaper owns settings, liveness and version binding.
 * Restore unreadable liveness evidence and retry; live, resumed and operator-answer cursors stay kept.
 */
import { reapDeadReviewRuns } from '../lib/reap-dead-review-runs.mjs';
import { isValidRunId } from './run-store.mjs';

export function main(argv, { out = console.log, err = console.error, reaperOptions = {} } = {}) {
  let run;
  const flags = new Set();
  for (const arg of argv) {
    if (arg.startsWith('--run=') && run === undefined) run = arg.slice(6);
    else if (['--apply', '--json'].includes(arg) && !flags.has(arg)) flags.add(arg);
    else { err('review-abandon: expected [--run=<id>] [--apply] [--json]'); return 2; }
  }
  if (run !== undefined && (!run.startsWith('review-pr-') || !isValidRunId(run))) {
    err('review-abandon: --run must be a review-pr run id'); return 2;
  }
  try {
    const result = reapDeadReviewRuns({ ...reaperOptions, log: reaperOptions.log ?? err,
      onlyIds: run === undefined ? undefined : [run], apply: flags.has('--apply') });
    out(flags.has('--json') ? JSON.stringify(result, null, 2)
      : `review-abandon: ${result.scanned} scanned · ${result.reaped.length} abandoned · ${result.wouldReap.length} would abandon`
        + Object.entries(result.kept).map(([why, ids]) => ` · ${why}=${ids.length}`).join(''));
    return 0;
  } catch (e) {
    err(`review-abandon: retained; restore evidence and retry (${String(e.message).replace(/[\x00-\x1f\x7f]/g, ' ')})`);
    return 1;
  }
}
