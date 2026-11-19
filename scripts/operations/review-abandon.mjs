/**
 * Abandon a dead review cursor without reconciling or claiming its unknown effects applied.
 * `run.mjs review-abandon [--run=<id>] [--apply] [--json]` previews by default; without
 * --run it sweeps unfinished runs for proven OPEN PRs in the shared review store. The reaper owns settings, liveness and version binding.
 * Restore unreadable evidence and retry; live and operator-answer cursors stay kept.
 * An explicit --run with --allow-resumed --ruling=<id> may override a resumed continuation.
 */
import { reapDeadReviewRuns } from '../lib/reap-dead-review-runs.mjs';
import { isValidRunId } from './run-store.mjs';
import { assertRunnerFreshness } from './runner-freshness.mjs';

/** Standalone CLI dispatch: mutating calls owe the runner's freshness guard before entering main. */
export function cliMain(argv, { assertFresh = assertRunnerFreshness, run = main, err = console.error } = {}) {
  if (argv.includes('--apply')) {
    try {
      // This flag CLI has no engine run declaration; its write policy is an effect, never compute-only.
      assertFresh({ declaration: { name: 'review-abandon', steps: [{ step: { kind: 'effect' } }] },
        moduleUrl: import.meta.url });
    } catch (e) {
      err(String(e?.message ?? e));
      return 1;
    }
  }
  return run(argv);
}

export function main(argv, { out = console.log, err = console.error, reaperOptions = {} } = {}) {
  let run, ruling;
  const flags = new Set();
  for (const arg of argv) {
    if (arg.startsWith('--run=') && run === undefined) run = arg.slice(6);
    else if (arg.startsWith('--ruling=') && ruling === undefined) ruling = arg.slice(9);
    else if (['--apply', '--json', '--allow-resumed'].includes(arg) && !flags.has(arg)) flags.add(arg);
    else { err('review-abandon: expected [--run=<id>] [--allow-resumed --ruling=<id>] [--apply] [--json]'); return 2; }
  }
  if (run !== undefined && (!run.startsWith('review-pr-') || !isValidRunId(run))) {
    err('review-abandon: --run must be a review-pr run id'); return 2;
  }
  if ((flags.has('--allow-resumed') || ruling !== undefined) && run === undefined) {
    err('review-abandon: --allow-resumed and --ruling require an explicit --run'); return 2;
  }
  if (ruling !== undefined && !ruling.trim()) { err('review-abandon: --ruling requires a nonempty id'); return 2; }
  try {
    const result = reapDeadReviewRuns({ ...reaperOptions, log: reaperOptions.log ?? err,
      onlyIds: run === undefined ? undefined : [run], allowResumed: flags.has('--allow-resumed'), ruling, apply: flags.has('--apply') });
    out(flags.has('--json') ? JSON.stringify(result, null, 2)
      : `review-abandon: ${result.scanned} scanned · ${result.reaped.length} abandoned · ${result.wouldReap.length} would abandon`
        + Object.entries(result.kept).map(([why, ids]) => ` · ${why}=${ids.length}`).join(''));
    return 0;
  } catch (e) {
    err(`review-abandon: retained; restore evidence and retry (${String(e.message).replace(/[\x00-\x1f\x7f]/g, ' ')})`);
    return 1;
  }
}
