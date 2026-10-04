/**
 * @file scripts/lib/rollup-collapse.mjs — @module rollup-collapse
 *
 * `collapseRollupToLatestPerName`/`rollupRowKind`, EXTRACTED from `we:scripts/merge-ai-prs.mjs` (#2925/#xkfv491
 * — see that file's own `latestRequiredCheck` header for the full live-incident history: a rollup can carry a
 * STALE, superseded run beside the check's real latest run, and a reader that does not collapse to the latest
 * run per name first misreads the stale one as still current) into its OWN dependency-free module, we:backlog/
 * fix-review-ciheal-deadlock (LIVE DEADLOCK 2026-09-28/29, PR #2878, web-everything/web-everything).
 *
 * WHY A SEPARATE FILE, NOT JUST "IMPORT IT FROM merge-ai-prs.mjs" (what every existing caller already does —
 * `we:scripts/fetch-parked.mjs`, `we:scripts/readiness/conveyor-state.mjs`, `we:scripts/conveyor/
 * ci-red-recovery-watch.mjs`, `we:scripts/progress-board.mjs`): `we:scripts/operations/pr-status.mjs`'s
 * `reduceCheckState` has the IDENTICAL defect this same PR fixes (see that function's own header), but that
 * file is the DECLARING MODULE of the `pr-reconcile` READ-ONLY operation
 * (`we:scripts/operations/http-adapter.test.mjs#3036` enforces that a read-only operation's declaring module
 * imports NOTHING that can act — no `node:child_process`, no `node:fs` writes, nothing shelling `gh`).
 * `merge-ai-prs.mjs` is a multi-thousand-line file that imports all of those and more; importing
 * `collapseRollupToLatestPerName` from it into `pr-status.mjs` (as this fix's first cut did) transitively
 * contaminated that read-only guarantee and reddened #3036 live. This module has ZERO imports of its own — the
 * pure per-name collapse, and nothing else — so `pr-status.mjs` (and every other caller) can depend on it
 * without depending on anything `merge-ai-prs.mjs` itself pulls in.
 *
 * `merge-ai-prs.mjs` re-exports both names from here unchanged, so every existing importer (and test importing
 * `rollupRowKind`/`collapseRollupToLatestPerName` from `merge-ai-prs.mjs` directly) keeps working with no
 * changes of its own — this is a pure relocation of the implementation, never a behaviour change.
 */

/**
 * Which member of GitHub's `StatusCheckRollupContext` union a rollup row is — `'CheckRun'`, `'StatusContext'`,
 * or `'untagged'` (unknown provenance, never granted CheckRun rank). `__typename` is authoritative when present;
 * only when it is absent entirely do we fall back to shape, and then only for the ONE unambiguous case: a
 * `context` with no `name` is the legacy commit-status shape and nothing else. A bare `name` is NOT taken as
 * proof of a CheckRun — that is exactly the inference `rollupToCheckRows` output would fool. Pure.
 * @param {object|null|undefined} c a single `statusCheckRollup` entry
 * @returns {'CheckRun'|'StatusContext'|'untagged'}
 */
export function rollupRowKind(c) {
  const t = c?.__typename;
  if (t === 'CheckRun' || t === 'StatusContext') return t;
  if (t) return 'untagged';                                     // a union member we don't know — no CheckRun rank
  if (c?.context != null && c?.name == null) return 'StatusContext'; // unambiguous legacy commit-status shape
  return 'untagged';
}

/**
 * #2925 — the SAME per-name collapse `we:scripts/merge-ai-prs.mjs#latestRequiredCheck` implements for ONE check
 * name, generalised to EVERY name in the rollup — `latestRequiredCheck` is a by-name lookup over this
 * function's output, ONE implementation, no fork. Exists because a reader that folds every rollup ENTRY into
 * one verdict (rather than picking one check out) has the SAME defect as `.find(...)`-picks-the-first: a
 * superseded `CANCELLED`/`FAILURE` entry beside a later `SUCCESS` outranks the run that actually finished,
 * whether it is read first or folded in at all. `we:scripts/fetch-parked.mjs#rollupToCheckRows`, `we:scripts/
 * readiness/conveyor-state.mjs#ciRollup`, `we:scripts/progress-board.mjs#ciFailed` and `we:scripts/operations/
 * pr-status.mjs#reduceCheckState` all fold every entry — collapse to the latest entry per name FIRST, then fold.
 *
 * Within a name: take the FIRST non-empty tier of `CheckRun` → untagged → `StatusContext` ({@link
 * rollupRowKind}), then the LATEST entry in that tier ({@link latestOf}). Pure. Order of the returned rows is
 * NOT the input order — one row per distinct name, in first-seen order.
 *
 * A row with NEITHER `name` NOR `context` (unreachable off a real `gh pr view --json statusCheckRollup` — every
 * live row carries one or the other) is passed through UNCOLLAPSED, one output row per such input row: there is
 * no name to group it by, so grouping it with any other nameless row would silently fold two unrelated checks
 * into one and grouping it under a shared empty-string key would do the same. Each gets its own group.
 * @param {Array<object>|null|undefined} rollup
 * @returns {Array<object>} one collapsed entry per distinct check name (nameless rows pass through 1:1).
 */
export function collapseRollupToLatestPerName(rollup) {
  const roll = Array.isArray(rollup) ? rollup : [];
  const byName = new Map();
  for (const c of roll) {
    const name = c?.name || c?.context || Symbol('nameless-rollup-row'); // ungroupable — its own singleton group
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(c);
  }
  const out = [];
  for (const matches of byName.values()) {
    const tier = (k) => matches.filter((c) => rollupRowKind(c) === k);
    const pool = [tier('CheckRun'), tier('untagged'), matches].find((t) => t.length);
    out.push(latestOf(pool));
  }
  return out;
}

/**
 * The latest run among several runs of ONE check. PR #2894 review (CONFIRMED live): the two feeds this module
 * serves disagree on order — `gh pr view --json statusCheckRollup` is oldest→newest (creation order,
 * #xkfv491), but the REST `commits/<sha>/check-runs` feed (`we:scripts/operations/pr-status-io.mjs#checksArgv`)
 * is NEWEST-first, so a positional "last wins" silently kept the OLDEST run there. When EVERY run carries a
 * numeric run `id` (REST rows do — `checksArgv` selects it; GitHub run ids are monotonic by creation), the
 * highest id wins regardless of order. Otherwise (the rollup, which carries no id) the last entry wins, as
 * before. Timestamps are deliberately NOT used: the rollup reports a queued run's `startedAt` as the zero date,
 * which would rank the newest run oldest.
 * @param {Array<object>} runs non-empty
 * @returns {object}
 */
function latestOf(runs) {
  const ids = runs.map((c) => Number(c?.id));
  if (!ids.every((id) => Number.isSafeInteger(id) && id > 0)) return runs[runs.length - 1];
  return runs[ids.indexOf(Math.max(...ids))];
}
