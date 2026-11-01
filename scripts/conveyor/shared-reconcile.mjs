/**
 * @file scripts/conveyor/shared-reconcile.mjs
 * R365 (perf D fix #3): ONE planner run (`runReconcilePass`) per repo per fix-daemon pass, handed to every
 * step that used to re-run it (fix, ci-heal, promote-draft, notes). Each step keeps its own decision logic;
 * only the planner read is shared.
 *
 * Staleness rule: a step that mutated a PR (dispatched a fix / ci-heal / promotion) calls
 * {@link createSharedReconcile}'s `invalidate(repo, prNumbers)`. The next consumer gets the shared snapshot
 * with ONLY those PRs re-planned (the planner re-run on just those raw rows; its per-PR enrichers — fix claims,
 * live agents, timeouts — read fresh), merged over the base entries keyed by PR number. Untouched PRs are never
 * re-planned and a touched PR is never served stale. Known bound: the re-plan of a touched PR does not see the
 * other PRs' rows, so cross-PR scope fences for it are not recomputed (the next pass recomputes them).
 *
 * Callers passing anything beyond `{repo, allowStandDownAutoProceed}` (a prs-file, hooks) bypass the cache.
 * A snapshot computed with allowStandDownAutoProceed=true serves callers asking for false (the old ci-heal /
 * promote-draft / notes halves ran after the fix half had already applied those effects); a true request after
 * a false snapshot recomputes.
 */
import { runReconcilePass, defaultReadPrs, enrichPrsWithCodeQL, REAL_RECONCILE } from './reconcile-pass.mjs';
import { excusePrMergeGateHolds } from '../lib/merge-gate-hold-class.mjs';

const prKey = (entry) => (entry && typeof entry === 'object' ? (entry.prNumber ?? entry.pr ?? null) : null);

/** Replace the entries of `base` that belong to `dirty` PRs with `fresh`'s; entries without a PR number stay. */
function mergeArray(base, fresh, dirty) {
  const kept = (Array.isArray(base) ? base : []).filter((e) => !dirty.has(prKey(e)));
  return [...kept, ...(Array.isArray(fresh) ? fresh : []).filter((e) => dirty.has(prKey(e)))];
}

export function createSharedReconcile({
  run = runReconcilePass, readPrs = defaultReadPrs, excuseMergeGateHolds = excusePrMergeGateHolds,
  enrichCodeQL = enrichPrsWithCodeQL, clone = structuredClone,
} = {}) {
  const cache = new Map(); // repo -> {plan, raw, final:Map, allow, dirty:Set, patch:Map}
  const stats = { computed: 0, served: 0, refreshed: 0 };

  function compute(repo, allow, rawOverride = null) {
    let raw = [];
    let final = [];
    const plan = run({
      repo, allowStandDownAutoProceed: allow,
      readPrs: (o) => {
        raw = rawOverride ?? readPrs({ ...o, attributionRepo: o?.attributionRepo ?? o?.repo ?? repo });
        final = Array.isArray(raw) ? raw : [];
        return raw;
      },
      excuseMergeGateHolds: (prs, options) => { final = excuseMergeGateHolds(prs, options); return final; },
      enrichCodeQL: (prs, options) => { final = enrichCodeQL(prs, options); return final; },
    });
    // Keep a pristine copy of the raw rows: the planner's enrichers may touch the originals, and a per-PR
    // re-plan must start from the same raw input the first plan did.
    return { plan, raw: Array.isArray(raw) && !rawOverride ? clone(raw) : (Array.isArray(raw) ? raw : null), final: Array.isArray(final) ? final : [] };
  }

  function entryFor(repo, allow) {
    const hit = cache.get(repo);
    if (hit && (hit.allow || !allow)) return hit;
    const c = compute(repo, allow);
    const entry = { plan: c.plan, raw: c.raw, final: new Map(c.final.map((p) => [p.number, p])), allow, dirty: new Set(), patch: new Map() };
    if (c.raw) cache.set(repo, entry); // a deferred/non-array read is never cached: the next step retries it
    stats.computed += 1;
    return entry;
  }

  function refresh(repo, entry) {
    if (!entry.dirty.size) return entry;
    const dirty = new Set(entry.dirty);
    entry.dirty.clear();
    // Only a deferred/error plan or missing raw rows cannot be patched: recompute in full.
    if (!entry.raw || !Array.isArray(entry.plan?.dispatch)) { cache.delete(repo); return entryFor(repo, entry.allow); }
    const rows = entry.raw.filter((p) => dirty.has(p.number)).map((p) => clone({ ...p, ...(entry.patch.get(p.number) ?? {}) }));
    const c = compute(repo, entry.allow, rows);
    const plan = entry.plan;
    entry.plan = {
      ...plan,
      dispatch: mergeArray(plan.dispatch, c.plan?.dispatch, dirty),
      refusals: mergeArray(plan.refusals, c.plan?.refusals, dirty),
      notes: mergeArray(plan.notes, c.plan?.notes, dirty),
      owedTriggers: Array.isArray(plan.owedTriggers) ? mergeArray(plan.owedTriggers, c.plan?.owedTriggers, dirty) : plan.owedTriggers,
    };
    for (const p of rows) entry.final.delete(p.number);
    for (const p of c.final) entry.final.set(p.number, p);
    entry.raw = entry.raw.map((p) => rows.find((r) => r.number === p.number) ?? p);
    stats.refreshed += dirty.size;
    return entry;
  }

  /** Drop-in for `runReconcilePass` in the step ticks' `reconcile` option. */
  function reconcile(input = {}) {
    const { repo, allowStandDownAutoProceed = false, ...rest } = input;
    if (Object.keys(rest).length || repo == null) return run(input);
    const entry = refresh(repo, entryFor(repo, allowStandDownAutoProceed === true));
    stats.served += 1;
    return clone(entry.plan);
  }
  reconcile[REAL_RECONCILE] = true;

  /** Notes-step view: same shape as `defaultReadNotesForRepo`'s return, from the shared snapshot. */
  function readNotes({ repo }) {
    const entry = refresh(repo, entryFor(repo, false));
    stats.served += 1;
    return { notes: Array.isArray(entry.plan?.notes) ? clone(entry.plan.notes) : [], prsByNumber: new Map(entry.final) };
  }

  /** Mark PRs a step just acted on. `patch` is applied to their raw rows on re-plan (e.g. {isDraft:false}). */
  function invalidate(repo, prNumbers, patch = null) {
    const entry = cache.get(repo);
    if (!entry) return;
    for (const n of prNumbers ?? []) {
      if (n == null) continue;
      entry.dirty.add(n);
      if (patch) entry.patch.set(n, { ...(entry.patch.get(n) ?? {}), ...patch });
    }
  }

  return { reconcile, readNotes, invalidate, stats };
}
