/** A read-only view of reconciliation evidence; this module does not nominate work. */
import { reviewCiGate } from './review-ci-gate.mjs';
import { FAILED_CHECK_CONCLUSIONS, collapseRollupToLatestPerName, isFailedCheckRow } from './rollup-collapse.mjs';
import { withoutImpliedRequiredChecks } from './required-check-implication.mjs';
import { splitFailingChecks, reviewHoldGatesOnlyRed, reviewHoldOnlyRed } from '../conveyor/reconcile-core.mjs';

/** A latest row that may prove an aggregate passed: explicit completed status (or a legacy success state). */
function wellFormedGreen(row) {
  if (row?.status === undefined && typeof row?.state === 'string') return row.state.toLowerCase() === 'success';
  return typeof row?.status === 'string' && row.status.toLowerCase() === 'completed'
    && typeof row?.conclusion === 'string' && row.conclusion.toLowerCase() === 'success';
}

/**
 * reviewCiGate over the WHOLE rollup (never drop rows: a dropped pending or superseding run is blocking evidence
 * the gate must see), plus one stricter rule: a required check the gate counted as implied must be implied by a
 * well-formed aggregate. The shared implication defaults a missing status to completed; that is no evidence here.
 */
function evidenceGate({ headSha, requiredChecks, checks }) {
  const gate = reviewCiGate({ headSha, requiredChecks, checks });
  if (!gate.allowed) return gate;
  const latest = collapseRollupToLatestPerName(checks);
  // The gate allowed, so every required name without a row of its own was implied.
  const implied = requiredChecks.filter(name => !latest.some(row => (row?.name ?? row?.context) === name));
  const green = latest.filter(wellFormedGreen).map(row => ({ ...row, status: 'completed', conclusion: 'success' }));
  const notProven = new Set(withoutImpliedRequiredChecks(requiredChecks, green));
  const unproven = [...new Set(implied.filter(name => notProven.has(name)))];
  if (!unproven.length) return gate;
  const affected = unproven.map(name => ({ name, reason: 'missing' }));
  return { allowed: false, headSha, reason: 'required-checks-not-successful', affected };
}

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
  // Every row reaches the gate; malformed rows only lose their power to imply (evidenceGate).
  const fullCi = evidenceGate({ headSha: rawPr?.headRefOid, requiredChecks, checks });
  // Preserve wrong-head refusals, and independently require current-head implication evidence.
  // Unheaded rollup rows retain the gate's assumption that they belong to the fetched PR head.
  const currentCi = evidenceGate({ headSha: rawPr?.headRefOid, requiredChecks,
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
