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
 * the plan carries a read-failure/deferral refusal (so the next step retries the read), or when the request carries anything beyond `{repo, allowStandDownAutoProceed}` (those bypass the cache).
 * Serve-time freshness re-check (cheap, local): before a cached plan is served, the inputs the planner reads
 * that change independently of this daemon are re-read with the planner's OWN functions (the same
 * `readAgents`+`enrichAgents` for agent liveness, the same `enrichPrsWithFixClaims`/`readLiveFixClaim` and so
 * the same claim expiry rule for fix claims) and compared with what the plan was built on. Any difference drops
 * the snapshot and re-plans in full, so liveness and ownership are never read stale.
 * A snapshot computed with allowStandDownAutoProceed=true serves callers asking for false; a true request after
 * a false snapshot recomputes.
 */
import {
  runReconcilePass, defaultReadPrs, defaultReadAgents, enrichAgents, enrichPrsWithFixClaims,
} from './reconcile-pass.mjs';
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

const INCOMPLETE_KIND = /read-failed|deferred|unavailable|unreadable|incomplete/i;
/** A plan built on a failed or deferred read must not be reused: the next step retries the read. */
export function planIsIncomplete(plan) {
  return (plan?.refusals ?? []).some((r) => INCOMPLETE_KIND.test(String(r?.kind ?? '')))
    || (plan?.notes ?? []).some((n) => typeof n === 'string');
}

export function createSharedReconcile({
  run = runReconcilePass, readPrs = defaultReadPrs, clone = structuredClone,
  readAgents = defaultReadAgents, enrichAgentRows = enrichAgents, enrichFixClaims = enrichPrsWithFixClaims,
} = {}) {
  const canon = (rows) => JSON.stringify((Array.isArray(rows) ? rows : []).map((r) => JSON.stringify(r, Object.keys(r ?? {}).sort())).sort());
  const claimsKey = (prs, repoKey) => JSON.stringify((prs ?? []).map((p) => {
    const [row] = enrichFixClaims([{ number: p.number }], { repo: repoKey });
    return [p.number, row?.fixClaim?.who ?? null, row?.fixClaim?.claimedAt ?? null];
  }));
  const cache = new Map(); // repo -> {plan, allow, agents, claims, prs, repoKey}
  const stats = { computed: 0, served: 0 };

  function compute(repo, allow) {
    let complete = true;
    const key = repoKeyForSlug(repo);
    const attributionRepo = key == null ? undefined : CONSTELLATION_REPOS[key]?.slug;
    let agents = null;
    let claims = null;
    let prs = [];
    const plan = run({
      repo, allowStandDownAutoProceed: allow,
      readAgents,
      // Record exactly what the planner read for liveness and ownership, via the planner's own functions.
      enrich: (a, o) => { const out = enrichAgentRows(a, o); agents = canon(out); return out; },
      enrichFixClaims: (rows, o) => {
        prs = (rows ?? []).map((p) => ({ number: p.number }));
        claims = claimsKey(prs, o?.repo ?? key);
        return enrichFixClaims(rows, o);
      },
      readPrs: (o) => {
        const rows = readPrs({ ...o, ...(attributionRepo ? { attributionRepo } : {}) });
        if (!Array.isArray(rows) || rows.discoveryIncomplete === true) complete = false;
        return rows;
      },
    });
    stats.computed += 1;
    return { plan, complete, agents, claims, prs, repoKey: key };
  }

  /** Re-read agent liveness and fix claims with the planner's own functions; any difference = not fresh. */
  function stillFresh(hit) {
    try {
      return canon(enrichAgentRows(readAgents({}))) === hit.agents && claimsKey(hit.prs, hit.repoKey) === hit.claims;
    } catch { return false; }
  }

  /** Drop-in for `runReconcilePass` in a step tick's `reconcile` option. */
  function reconcile(input = {}) {
    const { repo, allowStandDownAutoProceed = false, ...rest } = input;
    if (Object.keys(rest).length || repo == null) return run(input);
    const allow = allowStandDownAutoProceed === true;
    const hit = cache.get(repo);
    if (hit && (hit.allow || !allow) && stillFresh(hit)) { stats.served += 1; return clone(hit.plan); }
    const c = compute(repo, allow);
    if (c.complete && !planIsIncomplete(c.plan) && c.agents != null && c.claims != null) {
      cache.set(repo, { plan: c.plan, allow, agents: c.agents, claims: c.claims, prs: c.prs, repoKey: c.repoKey });
    } else cache.delete(repo);
    return clone(c.plan);
  }

  /** A step may have changed PR state in `repo`: the next request re-plans in full from fresh reads. */
  function invalidate(repo) { cache.delete(repo); }

  return { reconcile, invalidate, stats };
}
