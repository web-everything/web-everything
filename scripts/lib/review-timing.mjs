/** Pure review/fixer timing decisions. Inputs always describe one pinned head. */
import { reviewCiGate } from './review-ci-gate.mjs';
import { collapseRollupToLatestPerName } from './rollup-collapse.mjs';
import { CONSTELLATION_REPOS, repoKeyForSlug } from './constellation-repos.mjs';

// cancelOnCiRed: default off (operator 2026-10-16: keep the option, don't use it yet).
// fastChecks is keyed by repo: only WE's CI publishes these names. A repo without an entry waits on its required checks.
export const REVIEW_TIMING_DEFAULTS = Object.freeze({
  startAfter: 'fast-checks', fastChecks: Object.freeze({ we: Object.freeze(['standards', 'test-shard (1)']) }), cancelOnCiRed: false,
  deltaMaxLines: 50, deltaMaxFiles: 3, skipDrainMechanical: true,
});
const checkNames = v => Array.isArray(v) && v.length > 0 && v.every(n => typeof n === 'string' && n.trim());
/** A repo's fast checks (repo key or slug). An array applies to every repo; null means "use its required checks". */
export function fastChecksFor(fastChecks, repo) {
  if (Array.isArray(fastChecks)) return checkNames(fastChecks) ? fastChecks : null;
  const key = repoKeyForSlug(String(repo ?? '').trim().toLowerCase());
  const named = fastChecks && typeof fastChecks === 'object' && key ? normalizeFastChecks(fastChecks)[key] : null;
  return checkNames(named) ? named : null;
}
/**
 * One settings layer's fastChecks as a map keyed by repo KEY, so layers merge per repo in the cascade: a list becomes
 * the same list for every constellation repo, and slug keys become repo keys. Anything else is returned unchanged.
 */
export function normalizeFastChecks(v) {
  if (Array.isArray(v)) return checkNames(v) ? Object.fromEntries(Object.keys(CONSTELLATION_REPOS).map(key => [key, v])) : v;
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).map(([k, names]) => [repoKeyForSlug(String(k).trim().toLowerCase()) ?? k, names]));
}
/** Is this a valid fastChecks setting: a non-empty name list, or a map of repo key → non-empty name list? */
export const validFastChecks = v => checkNames(v) || (!!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length > 0 && Object.entries(v).every(([key, names]) => repoKeyForSlug(key) === key && checkNames(names)));
export const FIX_TIMING_DEFAULTS = Object.freeze({ joinCiAndReview: true, joinWaitMaxMin: 15 });
const RED = new Set(['failure', 'error', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);
/**
 * Checks that are never a CI failure a heal repairs: the review-dependent gates (red while a review is owed) and
 * we:scripts/operations/pr-status.mjs#CI_TRUTH_EXCLUDED_CHECKS (a test pins that this list covers it).
 */
export const NON_HEALABLE_CHECKS = Object.freeze(['review-gate', 'merge-gate', 'soak-replay-gate']);
/** The CI-heal rule (reconcile-core `splitFailingChecks`): a known required set names the healable checks. */
const isHealable = (row, requiredChecks) => {
  const name = row.name ?? row.context;
  return Array.isArray(requiredChecks) && requiredChecks.length ? requiredChecks.includes(name) : !NON_HEALABLE_CHECKS.includes(name);
};
/** Is a healable check red on this head? An optional red (CodeQL, with a known required set) is not. */
export function ciRedOnHead({ headSha, checks, requiredChecks = null } = {}) {
  if (!headSha) return false;
  return collapseRollupToLatestPerName(checks).some(row => isHealable(row, requiredChecks)
    && (!row.head_sha || row.head_sha === headSha)
    && RED.has(String(row.conclusion ?? row.state ?? '').toLowerCase()));
}
export function reviewStartGate({ headSha, checks, requiredChecks, repo, policy = REVIEW_TIMING_DEFAULTS } = {}) {
  if (policy.startAfter === 'ci-green') return reviewCiGate({ headSha, checks, requiredChecks });
  // Only required failures have a CI-heal owner. Optional failures, or any red under an unknown set, must not strand review.
  if (Array.isArray(requiredChecks) && requiredChecks.length && ciRedOnHead({ headSha, checks, requiredChecks }))
    return { allowed: false, headSha, reason: 'ci-red', affected: [] };
  if (policy.startAfter === 'push') return { allowed: typeof headSha === 'string' && !!headSha.trim(), headSha, reason: typeof headSha === 'string' && headSha.trim() ? 'push' : 'missing-head', affected: [] };
  return reviewCiGate({ headSha, checks, requiredChecks: fastChecksFor(policy.fastChecks, repo) ?? requiredChecks });
}
export function reviewMustVoid({ reviewedHead, currentHead, checks, requiredChecks = null, policy = REVIEW_TIMING_DEFAULTS } = {}) {
  return !reviewedHead || reviewedHead !== currentHead || (policy.cancelOnCiRed && ciRedOnHead({ headSha: currentHead, checks, requiredChecks }));
}
/** Unreadable sizes and binary deltas require full review. Mechanical status must be proved by the caller. */
export function rereviewMode({ priorHead, head, lines, files, mechanical = false, policy = REVIEW_TIMING_DEFAULTS } = {}) {
  if (!priorHead || !head || priorHead === head) return 'full';
  if (mechanical && policy.skipDrainMechanical) return 'carry';
  return Number.isSafeInteger(lines) && lines >= 0 && Number.isSafeInteger(files) && files >= 0
    && lines <= policy.deltaMaxLines && files <= policy.deltaMaxFiles ? 'delta' : 'full';
}
/** Cap is measured from the FIRST available input, never reset by a later poll. No expected counterpart means no wait. */
export function joinedFixDecision({ ciFailed = false, reviewFindings = false, firstReadyAt, otherPending = false,
  now, policy = FIX_TIMING_DEFAULTS } = {}) {
  if (!ciFailed && !reviewFindings) return { action: 'none' };
  if (!policy.joinCiAndReview) return { action: 'dispatch', joined: false };
  if (ciFailed && reviewFindings) return { action: 'dispatch', joined: true };
  const deadline = firstReadyAt + policy.joinWaitMaxMin * 60_000;
  if (otherPending && Number.isFinite(firstReadyAt) && Number.isFinite(now) && now < deadline)
    return { action: 'wait', deadline };
  return { action: 'dispatch', joined: false };
}

/**
 * PURE: select timestamped head-local readiness facts. findings are validated producer records supplied by caller.
 * With a known required set, only REQUIRED failures count: those are the only ones a CI heal repairs, so an optional
 * red (CodeQL) must not start the joined-fix clock or release a live reviewer's liveness hold. An unknown set falls
 * back to the heal path's own rule (every check but {@link NON_HEALABLE_CHECKS}).
 */
export function fixReadiness({ headSha, checks = [], findings = [], reviewPending = false, requiredChecks = null } = {}) {
  const latest = collapseRollupToLatestPerName(checks).filter(row =>
    !['review-gate', 'merge-gate'].includes(row.name ?? row.context) && (!row.head_sha || row.head_sha === headSha));
  const failed = latest.filter(row => isHealable(row, requiredChecks)
    && RED.has(String(row.conclusion ?? row.state ?? '').toLowerCase()));
  const times = [...failed.map(row => row.completed_at ?? row.completedAt), ...findings.map(row => row.createdAt)]
    .map(t => Date.parse(t)).filter(Number.isFinite);
  return { ciFailed: failed.length > 0, reviewFindings: findings.length > 0,
    firstReadyAt: times.length ? Math.min(...times) : NaN,
    otherPending: failed.length > 0 ? reviewPending && findings.length === 0
      : latest.some(row => ['queued', 'in_progress', 'pending', 'waiting', 'requested'].includes(String(row.status ?? row.state).toLowerCase())),
    ciFailures: failed.map(row => ({ name: row.name ?? row.context, conclusion: row.conclusion ?? row.state,
      detailsUrl: row.details_url ?? row.detailsUrl ?? row.targetUrl ?? null })), findings };
}
