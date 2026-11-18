/** Read-only reconciliation evidence and nomination eligibility; no dispatch or effects. */
import { redTeamForHead } from './red-team-gate.mjs';
import { reviewCiGate } from './review-ci-gate.mjs';
import { splitFailingChecks, reviewHoldGatesOnlyRed, reviewHoldOnlyRed } from '../conveyor/reconcile-core.mjs';

/**
 * Read one refusal without flattening its folded reviewRefusal. Production plans carry the check
 * classification made with the reconciler's enriched PR and required set, rather than the daemon's raw PR.
 * Explicit rawPrs/requiredChecks support pure planner fixtures and the reconciliation producer itself.
 * Missing reconciliation evidence is distinct from an available row with unknown CI evidence.
 */
export function readPlannerRow({ repo, pr, plan, refusals = plan?.refusals ?? [],
  rawPrs = plan?.enrichedPrs ?? [], requiredChecks = plan?.plannerOptions?.requiredChecks ?? null } = {}) {
  if (!Array.isArray(refusals)) return { absent: true };
  const refusal = refusals.find(row => row && Object.is(Number(row.prNumber), Number(pr)));
  if (!refusal) return { absent: true };
  const saved = plan?.plannerRows?.find(row => !row.absent
    && Object.is(Number(row.refusal.prNumber), Number(pr)));
  if (saved) return { absent: false, refusal, reviewOwnedChecks: saved.reviewOwnedChecks };
  const rawPr = rawPrs?.find(row => Object.is(Number(row?.number), Number(pr)));
  const checks = rawPr?.statusCheckRollup;
  const failing = splitFailingChecks(checks, requiredChecks);
  const ci = reviewCiGate({ headSha: rawPr?.headRefOid, requiredChecks, checks });
  // Classify pending owners with the same hold classifier; CI evidence itself stays pending.
  const pending = ci.affected.filter(check => check.reason === 'pending').map(check => check.name);
  const ownershipChecks = Array.isArray(checks) ? checks.map(check => pending.includes(check?.name ?? check?.context)
    ? { ...check, status: 'completed', conclusion: 'failure', state: 'failure' } : check) : checks;
  // Ask the existing normal-path classifier separately for each failing required check. In particular,
  // a plain merge-gate (or red-team) failure is not silently promoted to a review-owned hold.
  const reviewOwned = [...new Set([...failing.required, ...pending])].filter(name => reviewHoldGatesOnlyRed(ownershipChecks, [name]));
  return { absent: false, refusal, reviewOwnedChecks: {
    ci,
    ...failing, reviewOwned, nonReviewOwned: failing.required.filter(name => !reviewOwned.includes(name)),
    gatesOnlyRed: reviewHoldGatesOnlyRed(checks, requiredChecks),
    onlyRed: reviewHoldOnlyRed(checks, requiredChecks),
  } };
}

/** Preserve refusal order, multiplicity and metadata, including parallel per-PR refusals. */
export function readPlannerRows({ plan, refusals = plan?.refusals ?? [], ...inputs } = {}) {
  return refusals.map(refusal => readPlannerRow({ ...inputs, plan,
    pr: refusal?.prNumber, refusals: [refusal] })).filter(row => !row.absent);
}

/** Nomination eligibility only; review/thread/formal holds stay in the shared recovery planner. */
export function redTeamNominationRefusal(row, rawPr, rows = []) {
  if (!row || row.absent) return 'planner row absent; inspect reconciliation before retrying';
  if (row.refusal.kind === 'already-reviewed-head') return null;
  for (const other of rows) {
    if (other === row || Number(other.refusal.prNumber) !== Number(row.refusal.prNumber)) continue;
    const hold = redTeamNominationRefusal(other, rawPr);
    if (hold) return hold;
  }
  if (rawPr?.isDraft !== false || rawPr.state != null && rawPr.state !== 'OPEN') return 'PR must be open and ready for review';
  if (!Array.isArray(rawPr.comments) || rawPr.comments.some(comment => typeof comment?.body !== 'string')) return 'PR comments unreadable';
  if (redTeamForHead(rawPr.comments, Number(row.refusal.prNumber), rawPr.headRefOid)) return 'red-team result already on head';
  const kinds = ['review-ci', 'ci-heal-escalated', 'owed-ci-rerun'];
  if (!kinds.includes(row.refusal.kind)) return `planner refusal: ${row.refusal.kind}`;
  if (row.refusal.reviewRefusal && !['already-reviewed-head', ...kinds].includes(row.refusal.reviewRefusal.kind))
    return `planner refusal: ${row.refusal.reviewRefusal.kind}`;
  if (!rawPr?.labels?.some(label => (typeof label === 'string' ? label : label?.name) === 'review:human'))
    return 'nomination requires review:human';
  const checks = row.reviewOwnedChecks;
  if (checks?.ci?.allowed !== false || checks.ci?.headSha !== rawPr.headRefOid
    || !checks.ci.affected?.length || checks.ci.affected.some(check => !checks.reviewOwned?.includes(check.name)
      || ['missing', 'wrong-head', 'malformed'].includes(check.reason)))
    return 'required checks are not exclusively review-owned holds; inspect required checks';
  return null;
}
