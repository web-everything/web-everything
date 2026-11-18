/** A read-only view of reconciliation evidence; this module does not nominate work. */
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
  // Ask the existing normal-path classifier separately for each failing required check. In particular,
  // a plain merge-gate (or red-team) failure is not silently promoted to a review-owned hold.
  const reviewOwned = failing.required.filter(name => reviewHoldGatesOnlyRed(checks, [name]));
  return { absent: false, refusal, reviewOwnedChecks: {
    ci: reviewCiGate({ headSha: rawPr?.headRefOid, requiredChecks, checks }),
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
