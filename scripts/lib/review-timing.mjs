/** Pure review/fixer timing decisions. Inputs always describe one pinned head. */
import { reviewCiGate, reviewRequiredChecks, isReviewOwnedCheck } from './review-ci-gate.mjs';
import { resolveRequiredChecks } from './check-state-predicate.mjs';
import { collapseRollupToLatestPerName } from './rollup-collapse.mjs';
import { CONSTELLATION_REPOS, repoKeyForSlug } from './constellation-repos.mjs';

// cancelOnCiRed: default off (operator 2026-10-16: keep the option, don't use it yet).
// fastChecks is keyed by repo: only WE's CI publishes these names. A repo without an entry waits on its required checks.
export const REVIEW_TIMING_DEFAULTS = Object.freeze({
  startBeforeCi: false, startAfter: 'fast-checks', startEarly: 'shadow', fastChecks: Object.freeze({ we: Object.freeze(['standards', 'test-shard (1)']) }), cancelOnCiRed: false,
  deltaMaxLines: 50, deltaMaxFiles: 3, skipDrainMechanical: true,
  startEarlyPublishWaitMs: 1500000, startEarlyPollMs: 30000,
  earlyStartShadow: false, earlyStartCare: Object.freeze(['none', 'low']),
  earlyStartMaxLines: 400, earlyStartMaxFiles: 12, earlyStartKinds: Object.freeze(['code']),
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
  || (['fast-checks', 'push'].includes(policy.startAfter) && !fastChecksFor(policy.fastChecks, repo));
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
/** Required CI evidence: preserve all rows and let the shared resolver prove rerun lineage. */
function timingEvidence({ headSha, checks, requiredChecks, rowsHead = headSha, rowsComplete = false, rosterSource }) {
  return resolveRequiredChecks({ head: headSha, rowsHead, rows: checks, requiredNames: requiredChecks, rosterSource, rowsComplete });
}
const redEvidence = r => r.state === 'fail' || r.reasons.includes('needs-rerun');
const healableFailures = evidence => Object.values(evidence.perName)
  .filter(redEvidence).flatMap(r => r.rows.filter(row => [...RED, 'neutral', 'skipped', 'stale']
    .includes(String(row.conclusion ?? row.state ?? '').toLowerCase())));
/** Unknown evidence cannot establish that CI is safe to retain a review. */
export function ciRedOnHead(args = {}) {
  const evidence = timingEvidence(args);
  return evidence.state === 'unknown' || healableFailures(evidence).length > 0;
}
/** Diagnostic only, including drafts: a wait retains the existing review gates; never grants merge permission. */
export function earlyStartShadow({ headSha, checks, requiredChecks, verifyGreen, care, lines, files, kinds,
  policy = REVIEW_TIMING_DEFAULTS } = {}) {
  const result = (reason, wouldStartEarly = false) => ({ wouldStartEarly, reason, mergeAllowed: false });
  const dense = a => Array.isArray(a) && Array.from({ length: a.length }, (_, i) => i in a).every(Boolean);  // .every skips sparse holes
  const nonnegative = v => Number.isSafeInteger(v) && v >= 0;
  if (policy?.earlyStartShadow !== true) return result('shadow-off');
  if (!dense(policy.earlyStartCare) || !dense(policy.earlyStartKinds) || !checkNames(policy.earlyStartCare) || !checkNames(policy.earlyStartKinds)
    || !policy.earlyStartCare.every(v => ['none', 'low', 'elevated', 'high'].includes(v))
    || !policy.earlyStartKinds.every(v => ['code', 'docs', 'config', 'data'].includes(v))
    || !nonnegative(policy.earlyStartMaxLines) || !nonnegative(policy.earlyStartMaxFiles)) return result('invalid-policy');
  if (typeof headSha !== 'string' || !headSha.trim()) return result('missing-head');
  if (care == null || care === '') return result('missing-care');
  if (!['none', 'low', 'elevated', 'high'].includes(care) || !policy.earlyStartCare.includes(care)) return result('care-not-eligible');
  if (!nonnegative(lines) || !nonnegative(files)) return result('missing-size');
  if (lines > policy.earlyStartMaxLines || files > policy.earlyStartMaxFiles) return result('size-limit: wait for normal review');
  if (!dense(kinds) || !checkNames(kinds) || !kinds.every(v => policy.earlyStartKinds.includes(v))) return result('kinds-not-eligible');
  if (verifyGreen !== true) return result('verify-not-green');
  if (!dense(checks) || !checks.length || !checks.every(row => row && typeof row === 'object' && !Array.isArray(row)
    && typeof (row.name ?? row.context) === 'string' && (row.name ?? row.context).trim())) return result('missing-checks');
  if (!dense(requiredChecks) || !checkNames(requiredChecks)) return result('missing-required-checks');
  try {
    // Every required check needs a readable row on THIS head; anything else is incomplete evidence and waits.
    const low = v => (typeof v === 'string' ? v : '');  // exact lowercase tokens only, as ciRedOnHead compares
    const STATUS = ['queued', 'in_progress', 'pending', 'waiting', 'requested', 'completed'];
    const CONCLUSION = ['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'startup_failure', 'stale', 'error'];
    const STATE = ['pending', 'success', 'failure', 'error', 'expected'];
    const readable = row => {
      // An explicit kind fixes the required shape: a CheckRun needs a status, a StatusContext needs a state. Unknown kinds wait.
      const kind = row.__typename ?? row.type;
      if (kind != null && !['CheckRun', 'StatusContext'].includes(kind)) return false;
      if (kind === 'CheckRun' && row.status == null) return false;
      if (kind === 'StatusContext' && (row.state == null || row.status != null)) return false;
      if (row.head_sha != null && (typeof row.head_sha !== 'string' || !row.head_sha.trim())) return false;
      if (row.conclusion != null && !CONCLUSION.includes(low(row.conclusion))) return false;
      if (row.state != null && !STATE.includes(low(row.state))) return false;
      if (row.status != null) return STATUS.includes(low(row.status)) && ((low(row.status) === 'completed') === (row.conclusion != null));
      return row.state != null;  // a CheckRun needs a status; a conclusion alone is incomplete
    };
    // Judge every RAW row (before rollup collapse or head filtering) so a malformed or contradictory row cannot vanish.
    if (!checks.every(row => readable(row) && !(row.state != null && (row.conclusion != null || row.status != null)))) return result('incomplete-checks');
    const rows = collapseRollupToLatestPerName(checks).filter(row => !row.head_sha || row.head_sha === headSha);
    if (!requiredChecks.every(name => rows.some(row => (row.name ?? row.context) === name && readable(row)))) return result('incomplete-checks');
    if (rows.some(row => !readable(row))) return result('incomplete-checks');
    if (ciRedOnHead({ headSha, checks, requiredChecks, rowsComplete: true, rosterSource: 'live' })) return result('ci-red');
  } catch { return result('unreadable-checks'); }
  return result('eligible', true);
}
/** Validate raw evidence before permitting a pending-only bypass; collapse must not hide malformed rows. */
function readableEarlyChecks(checks, headSha) {
  // Rows without head_sha come from the IO reader's pinned commit-status endpoint.
  if (!Array.isArray(checks) || !checks.length) return false;
  return Array.from(checks).every(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || typeof (row.name ?? row.context) !== 'string' || !(row.name ?? row.context).trim()
      || (row.head_sha != null && row.head_sha !== headSha)) return false;
    const kind = row.__typename ?? row.type;
    if (kind != null && !['CheckRun', 'StatusContext'].includes(kind)) return false;
    const lower = v => typeof v === 'string' ? v.toLowerCase() : '';
    if (row.state != null) return kind !== 'CheckRun' && row.status == null && row.conclusion == null
      && ['pending', 'expected', 'success', 'failure', 'error'].includes(lower(row.state));
    if (kind === 'StatusContext') return false;
    if (lower(row.status) === 'completed') return ['success', 'failure', 'error', 'neutral', 'skipped', 'cancelled',
      'timed_out', 'action_required', 'startup_failure', 'stale'].includes(lower(row.conclusion));
    return ['queued', 'in_progress', 'pending', 'waiting', 'requested'].includes(lower(row.status)) && row.conclusion == null;
  });
}

/** Pending is the only relaxation: every prerequisite needs its own readable row on this head. */
function registeredStartGate({ headSha, checks, requiredChecks, rowsComplete, rosterSource }) {
  const strict = reviewCiGate({ headSha, checks, requiredChecks, rowsComplete, rosterSource });
  if (strict.unknown || !checkNames(requiredChecks) || typeof headSha !== 'string' || !headSha.trim()) return strict;
  // Registration may relax pending CI only; it cannot erase a resolver failure.
  if (strict.affected.some(row => !['pending', 'missing'].includes(row.reason))) return strict;
  const latest = new Map(collapseRollupToLatestPerName(checks).map(row => [row?.name ?? row?.context, row]));
  const affected = [...new Set(reviewRequiredChecks(requiredChecks))].flatMap(name => {
    const row = latest.get(name);
    let reason;
    if (!row) reason = 'missing';
    else if (row.head_sha != null && row.head_sha !== headSha) reason = 'wrong-head';
    else if (!readableEarlyChecks([row], headSha)) reason = 'malformed';
    else {
      const state = String(row.status ?? row.state).toLowerCase();
      if (['queued', 'in_progress', 'pending', 'waiting'].includes(state)) reason = 'pending';
      else if (!(state === 'completed' && row.conclusion.toLowerCase() === 'success') && state !== 'success')
        reason = row.conclusion?.toLowerCase() ?? row.state?.toLowerCase() ?? 'malformed';
    }
    return reason ? [{ name, reason }] : [];
  });
  if (affected.some(row => RED.has(row.reason))) return { allowed: false, headSha, reason: 'ci-red', affected };
  const missing = affected.filter(row => row.reason === 'missing');
  if (missing.length) return { allowed: false, headSha, reason: 'ci-not-registered', affected: missing };
  return { allowed: !affected.length, headSha,
    reason: affected.length ? 'required-checks-not-successful' : 'required-checks-successful', affected };
}

/** Review-owned checks cannot block the review they await; other CI consumers retain their rules. */
export const reviewAdmissionCiRed = args => {
  // This is red detection only: PR1's start gates independently validate provenance and completeness.
  // A missing roster here must still detect observed red without granting admission.
  const checks = Array.isArray(args.checks) ? args.checks.filter(row => !isReviewOwnedCheck(row?.name ?? row?.context)) : [];
  const requiredChecks = checkNames(args.requiredChecks) ? reviewRequiredChecks(args.requiredChecks)
    : [...new Set((checks ?? []).map(row => row?.name ?? row?.context))];
  const evidence = timingEvidence({ ...args, checks, requiredChecks, rowsComplete: true, rosterSource: 'live' });
  return healableFailures(evidence).length > 0;
};

/** Start permission only. Merge/ready decisions must continue using their strict CI gates. */
export function reviewStartGate({ headSha, checks, requiredChecks, rowsComplete = false, rosterSource, repo, verifyGreen, policy = REVIEW_TIMING_DEFAULTS } = {}) {
  const strict = () => reviewCiGate({ headSha, checks, requiredChecks, rowsComplete, rosterSource });
  if (rowsComplete !== true) return strict();
  // Rollback preserves the original strict CI-green result, including its reason and affected rows.
  if (policy.startEarly === 'off' && !policy.startBeforeCi && policy.startAfter === 'ci-green') return strict();
  const prerequisites = policy.startAfter === 'ci-green' ? requiredChecks : fastChecksFor(policy.fastChecks, repo) ?? requiredChecks;
  const registered = () => registeredStartGate({ headSha, checks, requiredChecks: prerequisites, rowsComplete, rosterSource: policy.startAfter === 'ci-green' || !fastChecksFor(policy.fastChecks, repo) ? rosterSource : 'live' });
  const pendingStart = gate => {
    if (gate.unknown) return gate;
    const mode = policy.startEarly ?? REVIEW_TIMING_DEFAULTS.startEarly;
    if (!['shadow', 'on'].includes(mode)) return gate;
    if (!gate.allowed && reviewAdmissionCiRed({ headSha, checks, requiredChecks })) return { ...gate, reason: 'ci-red' };
    // Retain other strict refusals; every prerequisite must be registered.
    if (gate.allowed || !gate.affected?.length || gate.affected.every(row => ['pending', 'missing'].includes(row.reason))) gate = registered();
    if (gate.allowed || !['shadow', 'on'].includes(mode) || typeof headSha !== 'string' || !headSha.trim()
      || !gate.affected?.length || !gate.affected.every(row => row.reason === 'pending')
      || !readableEarlyChecks(checks, headSha) || reviewAdmissionCiRed({ headSha, checks, requiredChecks })) return gate;
    if (mode === 'on') return { allowed: true, reason: 'early-pending-ci', earlyStart: true, headSha, affected: gate.affected };
    return { ...gate, wouldStartEarly: true,
      earlyStartNote: `review-early-start: would start early on ${headSha} (pending: ${gate.affected.map(row => `${row.name}=${row.reason}`).join(', ')})` };
  };
  // Malformed evidence never becomes permission (and must not throw during red detection).
  if (Array.isArray(checks) && Array.from(checks).some(row => !row || typeof row !== 'object' || Array.isArray(row)))
    return { allowed: false, headSha, reason: 'malformed', affected: [] };
  // With a known required set, only its healable failures block review.
  if (Array.isArray(requiredChecks) && requiredChecks.length && reviewAdmissionCiRed({ headSha, checks, requiredChecks }))
    return { allowed: false, headSha, reason: 'ci-red', affected: policy.startAfter === 'ci-green' || policy.startAfter === 'push' ? strict().affected : [] };
  // Verification adds a prerequisite; it cannot relax resolver evidence or pending CI.
  if (policy.startBeforeCi) {
    if (reviewAdmissionCiRed({ headSha, checks, requiredChecks: checkNames(requiredChecks) ? requiredChecks : null }))
      return { allowed: false, headSha, reason: 'ci-red', affected: [] };
    const gate = reviewCiGate({ headSha, checks, requiredChecks: prerequisites, rowsComplete,
      rosterSource: policy.startAfter === 'ci-green' || !fastChecksFor(policy.fastChecks, repo) ? rosterSource : 'live' });
    if (!gate.allowed) return gate;
    if (verifyGreen !== true) return { allowed: false, headSha, reason: 'verify-not-green', affected: [] };
    return { ...gate, reason: 'verify-marker' };
  }
  if (policy.startAfter === 'push') {
    const refuse = reason => ({ allowed: false, headSha, reason, affected: [] });
    if (typeof headSha !== 'string' || !headSha.trim()) return refuse('missing-head');
    // Unknown requirements cannot excuse red CI; use the same heal rule as the verification-marker path.
    if (reviewAdmissionCiRed({ headSha, checks, requiredChecks: checkNames(requiredChecks) ? requiredChecks : null }))
      return { ...refuse('ci-red'), affected: strict().affected };
    const gate = registered();
    if (gate.unknown || !gate.allowed && !(gate.affected.length && gate.affected.every(row => row.reason === 'pending'))) return gate;
    return { allowed: true, headSha, reason: 'push', affected: [] };
  }
  if (!policy.startBeforeCi && policy.startAfter === 'ci-green') return pendingStart(strict());
  if (policy.startAfter === 'ci-green') return pendingStart(strict());
  return pendingStart(reviewCiGate({ headSha, checks, requiredChecks: prerequisites, rowsComplete, rosterSource: policy.startAfter === 'ci-green' || !fastChecksFor(policy.fastChecks, repo) ? rosterSource : 'live' }));
}
export function reviewMustVoid({ reviewedHead, currentHead, checks, requiredChecks = null, rowsHead = currentHead,
  rowsComplete = false, rosterSource, policy = REVIEW_TIMING_DEFAULTS } = {}) {
  return !reviewedHead || reviewedHead !== currentHead || (policy.cancelOnCiRed
    && ciRedOnHead({ headSha: currentHead, checks, requiredChecks, rowsHead, rowsComplete, rosterSource }));
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
 * red (CodeQL) must not start the joined-fix clock or release a live reviewer's liveness hold.
 * Unknown evidence waits for CI; it never fabricates a healable failure.
 */
export function fixReadiness({ headSha, checks = [], findings = [], reviewPending = false, requiredChecks = null,
  rowsHead = headSha, rowsComplete = false, rosterSource } = {}) {
  const evidence = timingEvidence({ headSha, checks, requiredChecks, rowsHead, rowsComplete, rosterSource });
  const failed = healableFailures(evidence);
  const times = [...failed.map(row => row.completed_at ?? row.completedAt), ...findings.map(row => row.createdAt)]
    .map(t => Date.parse(t)).filter(Number.isFinite);
  return { ciFailed: failed.length > 0, reviewFindings: findings.length > 0,
    firstReadyAt: times.length ? Math.min(...times) : NaN,
    otherPending: evidence.state === 'unknown' || (failed.length > 0 ? reviewPending && findings.length === 0
      : Object.values(evidence.perName).some(r => r.state === 'pending')),
    ciFailures: failed.map(row => ({ name: row.name ?? row.context, conclusion: row.conclusion ?? row.state,
      detailsUrl: row.details_url ?? row.detailsUrl ?? row.targetUrl ?? null })), findings };
}

/** Unknown or incomplete CI waits until the fixed bound; review holds never delay a fix push. */
export function fixPushGate({ headSha, rowsHead = headSha, rowsComplete = false, rosterSource, previousHeadChecks, requiredChecks, firstHeldAt, now, policy = FIX_TIMING_DEFAULTS } = {}) {
  if (!policy.pushAfterCi) return { action: 'push', reason: 'off' };
  const maxMin = Number.isSafeInteger(policy.pushAfterCiMaxMin) && policy.pushAfterCiMaxMin >= 0
    ? policy.pushAfterCiMaxMin : FIX_TIMING_DEFAULTS.pushAfterCiMaxMin;
  const deadline = firstHeldAt + maxMin * 60_000;
  const evidence = timingEvidence({ headSha, checks: previousHeadChecks, requiredChecks, rowsHead, rowsComplete, rosterSource });
  const complete = evidence.state !== 'unknown' && Object.values(evidence.perName)
    .every(r => ['pass', 'fail', 'held'].includes(r.state));
  if (complete) return { action: 'push', reason: 'ci-complete',
    ciFailures: fixReadiness({ headSha, checks: previousHeadChecks, requiredChecks, rowsHead, rowsComplete, rosterSource }).ciFailures };
  if (Number.isFinite(now) && Number.isFinite(deadline) && now >= deadline)
    return { action: 'push', reason: 'bound', deadline };
  return { action: 'wait', reason: 'ci-pending', deadline };
}
