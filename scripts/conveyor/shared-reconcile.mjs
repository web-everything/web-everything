/**
 * @file scripts/conveyor/shared-reconcile.mjs
 * R365 (perf D fix #3): one planner run (`runReconcilePass`) per repo, handed to a later fix-daemon step that
 * used to re-run it. In the daemon this is ci-heal's run (taken AFTER its own pre-plan flushes) reused by
 * promote-draft. Each step keeps its own decision logic; only the planner read is shared.
 *
 * Why not fix and notes too: the fix half applies stand-down auto-proceed writes (it plans with the writer
 * enabled) and the R242 audit requires notes to write from fresh evidence after the dispatch steps, so both keep
 * their own planner run. Nothing here changes what they read.
 *
 * Staleness rule (exact, no partial re-plan): any step that may have changed PR state calls
 * `invalidate(repo)`, which drops the repo's snapshot; the next request re-runs the planner in full from fresh
 * reads, i.e. the old behaviour. A snapshot is also never kept when discovery was incomplete or deferred, or when
 * the request carries anything beyond `{repo, allowStandDownAutoProceed}` (those bypass the cache).
 * A snapshot computed with allowStandDownAutoProceed=true serves callers asking for false; a true request after
 * a false snapshot recomputes.
 */
import { runReconcilePass, defaultReadPrs } from './reconcile-pass.mjs';
import { CONSTELLATION_REPOS, repoKeyForSlug } from '../lib/constellation-repos.mjs';

/** Refusal kinds that are read-only decisions (no PR mutation behind them). Anything else invalidates. */
export const READ_ONLY_REFUSAL_KINDS = new Set([
  'queue-cap', 'no-lane', 'fix-loop-hold', 'fix-dispatch-killed', 'fix-hold-label', 'heal-unsettled',
  'heal-accounting-owed', 'held', 'unsupported-repo', 'nothing-owed',
]);

/** True when a step's result may have mutated PR state for that repo (a dispatch, or a non-read-only refusal). */
export function stepMayHaveMutated(entry) {
  return (entry?.dispatched?.length ?? 0) > 0
    || (entry?.refusals ?? []).some((r) => !READ_ONLY_REFUSAL_KINDS.has(r?.kind));
}

export function createSharedReconcile({ run = runReconcilePass, readPrs = defaultReadPrs, clone = structuredClone } = {}) {
  const cache = new Map(); // repo -> {plan, allow}
  const stats = { computed: 0, served: 0 };

  function compute(repo, allow) {
    let complete = true;
    const key = repoKeyForSlug(repo);
    const attributionRepo = key == null ? undefined : CONSTELLATION_REPOS[key]?.slug;
    const plan = run({
      repo, allowStandDownAutoProceed: allow,
      readPrs: (o) => {
        const rows = readPrs({ ...o, ...(attributionRepo ? { attributionRepo } : {}) });
        if (!Array.isArray(rows) || rows.discoveryIncomplete === true) complete = false;
        return rows;
      },
    });
    stats.computed += 1;
    return { plan, complete };
  }

  /** Drop-in for `runReconcilePass` in a step tick's `reconcile` option. */
  function reconcile(input = {}) {
    const { repo, allowStandDownAutoProceed = false, ...rest } = input;
    if (Object.keys(rest).length || repo == null) return run(input);
    const allow = allowStandDownAutoProceed === true;
    const hit = cache.get(repo);
    if (hit && (hit.allow || !allow)) { stats.served += 1; return clone(hit.plan); }
    const { plan, complete } = compute(repo, allow);
    if (complete) cache.set(repo, { plan, allow }); else cache.delete(repo);
    return clone(plan);
  }

  /** A step may have changed PR state in `repo`: the next request re-plans in full from fresh reads. */
  function invalidate(repo) { cache.delete(repo); }

  return { reconcile, invalidate, stats };
}
