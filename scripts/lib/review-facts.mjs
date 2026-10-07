/**
 * @file scripts/lib/review-facts.mjs
 * @description perf item C1c — the REVIEW DAEMON's facts-first reads. The review daemon made ~34.6k `gh pr view`
 * calls a day; the shared PR-facts reader ({@link ./pr-facts.mjs}, perf C1b) already holds head SHA, labels and
 * completed checks from the webhook store. This module is the review daemon's ONLY client of that reader.
 *
 * SYNC ON PURPOSE. The review dispatch gate and the label provider are synchronous. So the daemon calls
 * {@link warmReviewFacts} once a tick (async: refreshes the host-shared mirror from the Worker, which is NOT a
 * GitHub call), and every read after that is a sync look at that mirror ({@link lookupReviewFacts}), judged by
 * the reader's own `lookupInMirror` (feed healthy, bootstrap complete, row complete, TTL fresh). Anything else
 * returns `{ facts: null, reason }` and the caller keeps its existing `gh` read, byte for byte.
 *
 * NEVER A WRITE OR MERGE INPUT. This module is imported only by the daemon wiring and the review dispatch gate.
 * `review-set-label.mjs` (the label writer) and the drain/merge path never import it (pinned by
 * `__tests__/pr-facts-merge-gate-isolation.test.mjs` and `__tests__/review-facts.test.mjs`); the provider
 * wrapper below overrides `readLabels` ONLY, and any read that leads to a write elsewhere stays live.
 *
 * DECLARED SETTING: `WE_REVIEW_FACTS=0` turns the review daemon's facts-first reads off (every read → `gh`).
 * `WE_PR_FACTS=0` (the shared reader's own switch) and `WE_PR_FACTS_TTL_MS` (staleness bound) apply too.
 */
import { isUnderTest } from './under-test.mjs';
import { statSync } from 'node:fs';
import { loadMirror, lookupInMirror, mirrorPath, readMirrorFile, resolvePrFactsConfig } from './pr-facts.mjs';
import { recordGhCallLogEntry, ghThrottleLogPath, ghThrottleLockRoot } from './gh-throttle.mjs';
import { readReviewCiGate, readReviewHead } from './review-ci-gate-io.mjs';

export const REVIEW_FACTS_ENV = 'WE_REVIEW_FACTS';
export const reviewFactsEnabled = (env = process.env) => String(env[REVIEW_FACTS_ENV] ?? '').trim() !== '0';

const cache = new Map(); // path -> { mtimeMs, mirror }
function mirrorFor(path) {
  try {
    const { mtimeMs } = statSync(path);
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === mtimeMs) return hit.mirror;
    const mirror = readMirrorFile(path);
    cache.set(path, { mtimeMs, mirror });
    return mirror;
  } catch { return null; }
}

function logHit(env, repo, caller, op) {
  if ((isUnderTest(env) || env.FAKE_GH_FIXTURE) && !env.WE_GH_THROTTLE_LOCK_ROOT && !env.LANE_POOL_ROOT) return;
  try { recordGhCallLogEntry(ghThrottleLogPath(ghThrottleLockRoot(undefined, env)), { op: 'pr facts', outcome: 'facts_hit', repo, caller, n: 1, via: op }); } catch { /* best-effort */ }
}

/** Once per tick: refresh the mirror for each repo from the Worker (never GitHub). Best-effort; never throws. */
export async function warmReviewFacts(repos, { env = process.env, load = loadMirror, switchEnv = REVIEW_FACTS_ENV } = {}) {
  if (String(env[switchEnv] ?? '').trim() === '0') return { warmed: [], skipped: `${switchEnv}=0` };
  const warmed = [];
  for (const repo of repos || []) {
    try { const r = await load({ repo, env }); warmed.push({ repo, ok: !!r.mirror, reason: r.reason ?? null }); }
    catch (e) { warmed.push({ repo, ok: false, reason: String(e?.message || e).split('\n')[0] }); }
  }
  return { warmed };
}

/** Sync facts lookup from the on-disk mirror. `{ facts, source:'store', reason }` or `{ facts:null, source:'github', reason }`. */
export function lookupReviewFacts({ repo, number, env = process.env, now = Date.now(), caller = 'review-daemon.mjs', dir = null, switchEnv = REVIEW_FACTS_ENV } = {}) {
  // `switchEnv` lets another daemon reuse this lookup under its OWN off-switch (the fix dispatcher: `WE_FIX_FACTS`).
  if (String(env[switchEnv] ?? '').trim() === '0') return { facts: null, source: 'github', reason: `${switchEnv}=0` };
  const cfg = resolvePrFactsConfig(env);
  if (!cfg.enabled) return { facts: null, source: 'github', reason: `disabled: ${cfg.disabledReason}` };
  const path = mirrorPath(dir ?? cfg.dir, repo);
  const mirror = path ? mirrorFor(path) : null;
  if (!mirror) return { facts: null, source: 'github', reason: 'no-mirror' };
  const r = lookupInMirror(mirror, { number: Number(number), nowMs: now, ttlMs: cfg.ttlMs, staleAfterMs: cfg.staleAfterMs });
  if (!r.facts) return { facts: null, source: 'github', reason: r.reason };
  logHit(env, repo, caller, 'lookup');
  return { facts: r.facts, source: 'store', reason: 'served' };
}

/** The review dispatch gate, facts-first. Same signature and result as `readReviewCiGate`. */
export function readReviewCiGateFactsFirst({ repo, pr, lookup = lookupReviewFacts, live = readReviewCiGate, liveHead = readReviewHead, env = process.env, ...rest } = {}) {
  const hit = lookup({ repo, number: pr, env });
  const facts = hit?.facts;
  if (!facts || facts.state !== 'open' || !facts.headSha) return live({ repo, pr, ...rest });
  let heads = 0;
  const viaStore = readReviewCiGate({
    repo, pr, ...rest,
    // Only the FIRST head read comes from the store; the post-checks re-read that proves the head did not move stays live.
    readHead: (a) => (heads++ === 0 ? facts.headSha : liveHead(a)),
    readChecks: ({ headSha }) => {
      if (headSha !== facts.headSha) throw new Error('facts head differs');
      return facts.checks.map((c) => ({ name: c.name, status: 'completed', conclusion: c.conclusion, head_sha: facts.headSha }));
    },
  });
  if (viaStore.allowed) return { ...viaStore, factsSource: 'store' };
  // A refusal is trusted only when every affected check is a COMPLETED non-success. 'missing' / 'pending' / an
  // unreadable gate can be a store gap (the store lists completed GitHub check runs only, never legacy statuses),
  // so those re-read GitHub.
  const affected = viaStore.affected;
  const completedFailure = viaStore.reason === 'required-checks-not-successful' && Array.isArray(affected) && affected.length > 0
    && affected.every((a) => !['missing', 'pending', 'malformed', 'wrong-head'].includes(a.reason));
  if (completedFailure) return { ...viaStore, factsSource: 'store' };
  return live({ repo, pr, ...rest });
}

/** A label provider whose `readLabels` tries the store first; every other method is the base provider's, unchanged. */
export function withFactsLabels(base, { lookup = lookupReviewFacts, env = process.env } = {}) {
  return Object.assign(Object.create(base), {
    readLabels(repo, pr) {
      const hit = lookup({ repo, number: pr, env });
      if (hit?.facts) return hit.facts.labels.map((name) => ({ name }));
      return base.readLabels(repo, pr);
    },
  });
}
