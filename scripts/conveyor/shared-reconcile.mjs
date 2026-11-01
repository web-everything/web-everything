/**
 * @file scripts/conveyor/shared-reconcile.mjs
 * R365 (perf D fix #3): ONE planner run (`runReconcilePass`) per repo, handed to every later fix-daemon step
 * that used to re-run it. In the daemon this serves ci-heal, promote-draft and notes: the fix half keeps its own
 * planner run (it applies stand-down auto-proceed writes), and ci-heal's run happens AFTER its own pre-plan
 * flushes (attempt polling, owed comments, timeout follow-ups), so it is the freshest snapshot the later steps
 * could have had before. Each step keeps its own decision logic; only the planner read is shared.
 *
 * Staleness rule: every step that acted on PRs (a dispatch, resume, salvage, timeout rerun, promotion, ...)
 * calls `invalidate(repo, prNumbers)`. The next consumer gets the shared snapshot with ONLY those PRs re-planned
 * from a FRESH read (labels, comments, head sha, open/closed all re-read), merged over the base entries keyed by
 * PR number. If that refresh fails, the cached snapshot is dropped and the next request re-plans in full: a
 * failed refresh never falls back to the stale plan. Known bound: the re-plan of a touched PR does not see the
 * other PRs' rows, so cross-PR scope fences for it are not recomputed until the next pass.
 *
 * Callers passing anything beyond `{repo, allowStandDownAutoProceed}` (a prs-file, hooks) bypass the cache.
 * A snapshot computed with allowStandDownAutoProceed=true serves callers asking for false; a true request after
 * a false snapshot recomputes. A refresh always plans with the snapshot's own flag.
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
  const cache = new Map(); // repo -> {plan, raw, final:Map, allow, dirty:Set}
  const stats = { computed: 0, served: 0, refreshed: 0 };

  function compute(repo, allow, readOverride = null) {
    let raw = [];
    let final = [];
    const plan = run({
      repo, allowStandDownAutoProceed: allow,
      readPrs: (o) => {
        const read = readOverride ?? readPrs;
        raw = read({ ...o, attributionRepo: o?.attributionRepo ?? o?.repo ?? repo });
        final = Array.isArray(raw) ? raw : [];
        return raw;
      },
      excuseMergeGateHolds: (prs, options) => { final = excuseMergeGateHolds(prs, options); return final; },
      enrichCodeQL: (prs, options) => { final = enrichCodeQL(prs, options); return final; },
    });
    return { plan, raw: Array.isArray(raw) ? raw : null, final: Array.isArray(final) ? final : [] };
  }

  function entryFor(repo, allow) {
    const hit = cache.get(repo);
    if (hit && (hit.allow || !allow)) return hit;
    const c = compute(repo, allow);
    const entry = { plan: c.plan, final: new Map(c.final.map((p) => [p.number, p])), allow, dirty: new Set() };
    if (c.raw) cache.set(repo, entry); // a deferred/non-array read is never cached: the next step retries it
    stats.computed += 1;
    return entry;
  }

  function refresh(repo, entry) {
    if (!entry.dirty.size) return entry;
    const dirty = new Set(entry.dirty);
    entry.dirty.clear();
    try {
      // Fresh read of just the touched PRs: the base rows may predate the step's own effects.
      const c = compute(repo, entry.allow, (o) => {
        const rows = readPrs(o);
        return Array.isArray(rows) ? rows.filter((p) => dirty.has(p.number)) : rows;
      });
      if (!c.raw) throw new Error('shared-reconcile: refresh read was deferred');
      const plan = entry.plan;
      entry.plan = {
        ...plan,
        dispatch: mergeArray(plan.dispatch, c.plan?.dispatch, dirty),
        refusals: mergeArray(plan.refusals, c.plan?.refusals, dirty),
        notes: mergeArray(plan.notes, c.plan?.notes, dirty),
        owedTriggers: Array.isArray(plan.owedTriggers) ? mergeArray(plan.owedTriggers, c.plan?.owedTriggers, dirty) : plan.owedTriggers,
      };
      for (const n of dirty) entry.final.delete(n);
      for (const p of c.final) entry.final.set(p.number, p);
      stats.refreshed += dirty.size;
      return entry;
    } catch {
      // Never serve the stale plan after a failed refresh: drop it and re-plan in full.
      cache.delete(repo);
      return entryFor(repo, entry.allow);
    }
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

  /** Mark PRs a step just acted on: the next consumer re-plans them from a fresh read. */
  function invalidate(repo, prNumbers) {
    const entry = cache.get(repo);
    if (!entry) return;
    for (const n of prNumbers ?? []) if (n != null) entry.dirty.add(n);
  }

  return { reconcile, readNotes, invalidate, stats };
}
