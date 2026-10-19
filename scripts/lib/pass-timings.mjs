/**
 * @file scripts/lib/pass-timings.mjs
 * @description Per-step wall-clock timing for one drain pass (we:scripts/merge-ai-prs.mjs) — filed against
 *   "why so slow" (the resident drain daemon, `com.plateau.drain-daemon`, was seen taking 9-18 min per pass
 *   to merge 2-3 PRs with NO per-step breakdown anywhere: `we:.drain-daemon/history.jsonl` and its `daemon.log`
 *   recorded only the pass's total `ms`, so nobody could tell where the time went).
 *
 * Dependency-free and pure (the caller supplies `now`, default `Date.now`), so this is unit-testable without
 * any real I/O or timers. `we:scripts/merge-ai-prs.mjs`'s `sweepOnce()` is the one caller: it creates ONE
 * `createStepTimer()` per pass, wraps/marks the major steps (listing, per-PR classify/gate reads,
 * rebase-drop-manifest, the merge cascade + the actual `gh pr merge` call inside it, the post-merge local/
 * primary sync, JIT numbering, resolve-on-land, the numbering push, the duplicate-id tripwire scan, and the
 * derived-artifact regen), and attaches the resulting `{ ...steps, total }` map onto `result.timings` (so it
 * rides the pass's own `--json` output) plus renders `formatTimingsSummary` as ONE unconditional stderr log
 * line (see `we:scripts/merge-ai-prs.mjs`'s `sweepOnce` — the line prints regardless of `--json`, unlike this
 * file's other progress lines, because the resident daemon always passes `--json` and its stderr is the ONLY
 * channel that reaches `we:.drain-daemon/daemon.log`).
 *
 * Persisting `timings` into `history.jsonl` itself is a SEPARATE, plateau-app-side change (its
 * `tools/drain-daemon/lib.mjs#parsePassResult` reshapes the child's `--json` into the persisted entry through
 * a fixed field allow-list, so an unlisted field — `timings` included — is silently dropped today). That is
 * plateau-app product code and lands through a plateau-app lane, never from here (see this WE PR's own body).
 */

/**
 * A per-pass accumulator: every step this pass's clock touches, keyed by a short label, summed in
 * milliseconds. Multiple `time`/`timeAsync`/`add` calls against the SAME label accumulate (never overwrite)
 * so a step that runs more than once in a pass (e.g. "listing" = the context listing + the candidate listing,
 * two separate awaited calls) reports its TOTAL cost under one key.
 * @param {() => number} [now] - injectable clock (default `Date.now`), so tests can supply a deterministic one
 * @returns {{
 *   time: <T>(label: string, fn: () => T) => T,
 *   timeAsync: <T>(label: string, fn: () => Promise<T>) => Promise<T>,
 *   add: (label: string, deltaMs: number) => void,
 *   mark: () => number,
 *   snapshot: () => Record<string, number>,
 * }}
 */
export function createStepTimer(now = () => Date.now()) {
  const ms = Object.create(null);
  const add = (label, deltaMs) => {
    if (typeof label !== 'string' || !label) return; // defensive — never let a bad label throw mid-pass
    const d = Number(deltaMs);
    if (!Number.isFinite(d) || d <= 0) return; // a clock going backwards (clock skew) or a 0-cost call contributes nothing, never NaN/negative
    ms[label] = (ms[label] || 0) + d;
  };
  const time = (label, fn) => {
    const start = now();
    try { return fn(); } finally { add(label, now() - start); }
  };
  const timeAsync = async (label, fn) => {
    const start = now();
    try { return await fn(); } finally { add(label, now() - start); }
  };
  return { time, timeAsync, add, mark: () => now(), snapshot: () => ({ ...ms }) };
}

/**
 * Render a pass's timings as ONE compact, log-friendly line — `label=NNNms` pairs in a stable, caller-chosen
 * order (steps not named in `order` follow, in their own insertion order, so a NEW step never gets silently
 * dropped from the line just because this formatter's order list wasn't updated), then a trailing `total=`.
 * Pure. `total` defaults to the sum of every step (the common case); the caller may pass the pass's REAL
 * measured wall time instead (it always exceeds the sum of the parts it bothered to label — unlabelled gaps,
 * e.g. flag parsing or the lease acquire, are real time too), so the line never implies full coverage it
 * doesn't have.
 * @param {Record<string, number>} timings
 * @param {{ total?: number|null, order?: string[]|null }} [o]
 * @returns {string}
 */
export function formatTimingsSummary(timings, { total = null, order = null } = {}) {
  const t = timings && typeof timings === 'object' ? timings : {};
  const known = Array.isArray(order) ? order.filter((k) => k in t) : [];
  const rest = Object.keys(t).filter((k) => !known.includes(k));
  const keys = [...known, ...rest];
  const totalMs = (total != null && Number.isFinite(Number(total))) ? Number(total) : keys.reduce((s, k) => s + (t[k] || 0), 0);
  const parts = keys.map((k) => `${k}=${Math.round(t[k])}ms`);
  parts.push(`total=${Math.round(totalMs)}ms`);
  return parts.join(' ');
}

/** The canonical step order for `we:scripts/merge-ai-prs.mjs`'s pass summary line — purely cosmetic (the
 *  timings object itself is an unordered map), kept here so the CLI and its tests read the same list. */
export const PASS_STEP_ORDER = [
  'listing',
  // Operator 2026-10-19 hotfix: separate context listing from per-PR reads.
  'listing.context',
  'listing.context.list',
  'listing.context.reads',
  'classifyGateReads',
  'rebaseDropManifest',
  'mergeCascade',
  'mergeCall',
  'postMergeSync',
  'jitNumbering',
  'resolveOnLand',
  'numberingPush',
  'duplicateCheck',
  'derivedRegen',
];
