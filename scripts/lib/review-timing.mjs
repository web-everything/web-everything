/** Pure review/fixer timing decisions. Inputs always describe one pinned head. */
import { reviewCiGate } from './review-ci-gate.mjs';
import { collapseRollupToLatestPerName } from './rollup-collapse.mjs';
import { CONSTELLATION_REPOS, repoKeyForSlug } from './constellation-repos.mjs';

// cancelOnCiRed: default off (operator 2026-10-16: keep the option, don't use it yet).
// fastChecks is keyed by repo: only WE's CI publishes these names. A repo without an entry waits on its required checks.
export const REVIEW_TIMING_DEFAULTS = Object.freeze({
  startBeforeCi: false, startAfter: 'fast-checks', fastChecks: Object.freeze({ we: Object.freeze(['standards', 'test-shard (1)']) }), cancelOnCiRed: false,
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
/** Whether review waits on branch protection, including a repo without configured fast checks. */
export const reviewUsesRequiredChecks = (policy, repo) => policy.startAfter === 'ci-green'
  || (policy.startAfter === 'fast-checks' && !fastChecksFor(policy.fastChecks, repo));
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
export const FIX_TIMING_DEFAULTS = Object.freeze({ joinCiAndReview: true, joinWaitMaxMin: 15, pushAfterCi: false, pushAfterCiMaxMin: 30 });
const RED = new Set(['failure', 'error', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);
/**
 * Checks that are never a CI failure a heal repairs: the review-dependent gates (red while a review is owed) and
 * we:scripts/operations/pr-status.mjs#CI_TRUTH_EXCLUDED_CHECKS (a test pins that this list covers it).
 */
export const NON_HEALABLE_CHECKS = Object.freeze(['review-gate', 'merge-gate', 'soak-replay-gate']);
/**
 * A review hold, never a CI failure — even when branch protection requires the check. Same rule as the CI heal's
 * `reviewHoldRed` (#5463): `review-gate` always, `merge-gate` when its red is a review hold (`mergeGateReviewHold`,
 * attached by we:scripts/lib/merge-gate-hold-class.mjs#excuseMergeGateRows). A plain required merge-gate red is healable.
 */
export const isReviewHoldGate = row => {
  const name = row?.name ?? row?.context;
  return name === 'review-gate' || (name === 'merge-gate' && !!row.mergeGateReviewHold);
};
/** The CI-heal rule (reconcile-core `splitFailingChecks`): a known required set names the healable checks. */
const isHealable = (row, requiredChecks) => {
  const name = row.name ?? row.context;
  if (isReviewHoldGate(row)) return false;
  return Array.isArray(requiredChecks) && requiredChecks.length ? requiredChecks.includes(name) : !NON_HEALABLE_CHECKS.includes(name);
};
/** Is a healable check red on this head? An optional red (CodeQL, with a known required set) is not. */
export function ciRedOnHead({ headSha, checks, requiredChecks = null } = {}) {
  if (!headSha) return false;
  return collapseRollupToLatestPerName(checks).some(row => isHealable(row, requiredChecks)
    && (!row.head_sha || row.head_sha === headSha)
    && RED.has(String(row.conclusion ?? row.state ?? '').toLowerCase()));
}
export function reviewStartGate({ headSha, checks, requiredChecks, repo, verifyGreen, policy = REVIEW_TIMING_DEFAULTS } = {}) {
  if (!policy.startBeforeCi && policy.startAfter === 'ci-green') return reviewCiGate({ headSha, checks, requiredChecks });
  // Only required failures have a CI-heal owner. Optional failures, or any red under an unknown set, must not strand review.
  if (Array.isArray(requiredChecks) && requiredChecks.length && ciRedOnHead({ headSha, checks, requiredChecks }))
    return { allowed: false, headSha, reason: 'ci-red', affected: [] };
  if (policy.startBeforeCi && verifyGreen === true && typeof headSha === 'string' && headSha.trim()) {
    // An unknown required set must not let a red check ride past the marker: any healable red blocks, as in CI-green.
    if (ciRedOnHead({ headSha, checks, requiredChecks: Array.isArray(requiredChecks) && requiredChecks.length ? requiredChecks : null }))
      return { allowed: false, headSha, reason: 'ci-red', affected: [] };
    return { allowed: true, headSha, reason: 'verify-marker', affected: [] };
  }
  if (policy.startAfter === 'ci-green') return reviewCiGate({ headSha, checks, requiredChecks });
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
    !isReviewHoldGate(row) && (!row.head_sha || row.head_sha === headSha));
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

/** Unknown or incomplete CI waits until the fixed bound; review holds never delay a fix push. */
export function fixPushGate({ previousHeadChecks, requiredChecks, firstHeldAt, now, policy = FIX_TIMING_DEFAULTS } = {}) {
  if (!policy.pushAfterCi) return { action: 'push', reason: 'off' };
  const maxMin = Number.isSafeInteger(policy.pushAfterCiMaxMin) && policy.pushAfterCiMaxMin >= 0
    ? policy.pushAfterCiMaxMin : FIX_TIMING_DEFAULTS.pushAfterCiMaxMin;
  const deadline = firstHeldAt + maxMin * 60_000;
  const latest = collapseRollupToLatestPerName(previousHeadChecks);
  const rows = latest.filter(row => !isReviewHoldGate(row));
  const required = Array.isArray(requiredChecks) && requiredChecks.length
    ? requiredChecks.filter(name => name !== 'review-gate' && !latest
      .some(row => (row.name ?? row.context) === name && isReviewHoldGate(row))) : [];
  const complete = Array.isArray(previousHeadChecks) && required.length > 0 && required.every(name => {
    const row = rows.find(row => (row.name ?? row.context) === name);
    const conclusion = String(row?.conclusion ?? row?.state ?? '').toLowerCase();
    return row && ['success', 'neutral', 'skipped', ...RED].includes(conclusion)
      && (row.status === undefined || String(row.status).toLowerCase() === 'completed');
  });
  if (complete) return { action: 'push', reason: 'ci-complete',
    ciFailures: fixReadiness({ checks: rows.map(({ head_sha, ...row }) => row), requiredChecks }).ciFailures };
  if (Number.isFinite(now) && Number.isFinite(deadline) && now >= deadline)
    return { action: 'push', reason: 'bound', deadline };
  return { action: 'wait', reason: 'ci-pending', deadline };
}
