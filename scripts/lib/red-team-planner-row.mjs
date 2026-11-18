/** A read-only view of reconciliation evidence; this module does not nominate work. */
import { reviewCiGate } from './review-ci-gate.mjs';
import { FAILED_CHECK_CONCLUSIONS, isFailedCheckRow } from './rollup-collapse.mjs';
import { splitFailingChecks, reviewHoldGatesOnlyRed, reviewHoldOnlyRed } from '../conveyor/reconcile-core.mjs';

/**
 * Read one refusal without flattening its folded reviewRefusal. Always classify the current input;
 * saved planner rows cannot reflect check reruns on the same head.
 * Explicit rawPrs/requiredChecks support pure planner fixtures and the reconciliation producer itself.
 * Missing reconciliation evidence is distinct from an available row with unknown CI evidence.
 */
export function readPlannerRow({ pr, plan, refusals = plan?.refusals ?? [],
  rawPrs = plan?.enrichedPrs ?? [], requiredChecks = plan?.plannerOptions?.requiredChecks ?? plan?.plannerRequiredChecks ?? null } = {}) {
  if (!Array.isArray(refusals)) return { absent: true };
  const refusal = refusals.find(row => row && Object.is(Number(row.prNumber), Number(pr)));
  if (!refusal) return { absent: true };
  const rawPr = rawPrs?.find(row => Object.is(Number(row?.number), Number(pr)));
  const checks = rawPr?.statusCheckRollup;
  const failing = splitFailingChecks(checks, requiredChecks);
  // Ask the existing normal-path classifier separately for each failing required check. In particular,
  // a plain merge-gate (or red-team) failure is not silently promoted to a review-owned hold.
  const reviewOwned = failing.required.filter(name => reviewHoldGatesOnlyRed(checks, [name]));
  const fullCi = reviewCiGate({ headSha: rawPr?.headRefOid, requiredChecks, checks });
  // Preserve wrong-head refusals, and independently require current-head implication evidence.
  // Unheaded rollup rows retain the gate's assumption that they belong to the fetched PR head.
  const currentCi = reviewCiGate({ headSha: rawPr?.headRefOid, requiredChecks,
    checks: Array.isArray(checks) ? checks.filter(row => !row?.head_sha || row.head_sha === rawPr?.headRefOid) : checks });
  const ci = fullCi.allowed ? currentCi : { ...fullCi, affected: [...fullCi.affected,
    ...currentCi.affected.filter(row => !fullCi.affected.some(full => full.name === row.name))] };
  // The SAME head-aware classification must prove that only failed review holds need excusing.
  const onlyFailures = ci.affected.length > 0 && ci.affected.every(({ name, reason }) =>
    reviewOwned.includes(name) && FAILED_CHECK_CONCLUSIONS.includes(reason.toUpperCase()));
  const noOtherRed = Array.isArray(checks) && checks.every(row => !isFailedCheckRow(row)
    || (Array.isArray(requiredChecks) && requiredChecks.includes(row?.name || row?.context)
      && reviewHoldGatesOnlyRed([row], [row?.name || row?.context])));
  return { absent: false, refusal, reviewOwnedChecks: {
    ci,
    ...failing, reviewOwned, nonReviewOwned: failing.required.filter(name => !reviewOwned.includes(name)),
    gatesOnlyRed: reviewHoldGatesOnlyRed(checks, requiredChecks),
    onlyRed: onlyFailures && noOtherRed && reviewHoldOnlyRed(checks, requiredChecks),
  } };
}

/** Preserve refusal order, multiplicity and metadata, including parallel per-PR refusals. */
export function readPlannerRows({ plan, refusals = plan?.refusals ?? [], ...inputs } = {}) {
  return refusals.map(refusal => readPlannerRow({ ...inputs, plan,
    pr: refusal?.prNumber, refusals: [refusal] })).filter(row => !row.absent);
}
