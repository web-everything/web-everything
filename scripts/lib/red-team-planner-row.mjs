/** A read-only view of reconciliation evidence; this module does not nominate work. */
import { resolveRequiredChecks } from './check-state-predicate.mjs';
import { isFailedCheckRow } from './rollup-collapse.mjs';

/**
 * Read one refusal without flattening its folded reviewRefusal. Always classify the current input;
 * saved planner rows cannot reflect check reruns on the same head.
 * Explicit rawPrs/requiredChecks support pure planner fixtures and the reconciliation producer itself.
 * Missing reconciliation evidence is distinct from an available row with unknown CI evidence.
 */
export function readPlannerRow({ pr, plan, refusals = plan?.refusals ?? [],
  rawPrs = plan?.enrichedPrs ?? [], requiredChecks = plan?.plannerOptions?.requiredChecks ?? plan?.plannerRequiredChecks ?? null,
  rosterSource = plan?.plannerOptions?.rosterSource ?? plan?.plannerRequiredChecksSource ?? 'declared' } = {}) {
  if (!Array.isArray(refusals)) return { absent: true };
  const refusal = refusals.find(row => row && Object.is(Number(row.prNumber), Number(pr)));
  if (!refusal) return { absent: true };
  const rawPr = rawPrs?.find(row => Object.is(Number(row?.number), Number(pr)));
  const checks = rawPr?.statusCheckRollup;
  // Preserve the normal gate's row-bound mergeGateReviewHold / mergeGateHoldExcused annotations.
  const checkEvidence = resolveRequiredChecks({ rows: checks, rowsHead: rawPr?.headRefOid,
    rowsComplete: rawPr?.rowsComplete === true, requiredNames: requiredChecks, rosterSource,
    head: refusal.headSha, holds: rawPr?.holds ?? plan?.holds });
  const { state, perName, reasons } = checkEvidence;
  const unsettled = Object.entries(perName).filter(([, row]) => row.state !== 'pass');
  const reviewOwned = unsettled.filter(([, row]) => row.state === 'held').map(([name]) => name);
  const nonReviewOwned = unsettled.filter(([, row]) => row.state !== 'held').map(([name]) => name);
  const affected = unsettled.map(([name, row]) => ({ name, reason: row.reasons[0] ?? row.state }));
  const ci = { allowed: state === 'pass', ...(state === 'unknown' ? { unknown: true } : {}),
    headSha: refusal.headSha ?? null,
    reason: reasons.includes('missing-head') ? 'missing-head'
      : reasons.includes('roster-unavailable') ? 'unknown-required-set'
      : reasons.includes('rows-incomplete') ? 'rows-incomplete'
      : state === 'pass' ? 'required-checks-successful'
      : affected.some(row => row.name === 'review-gate') ? 'required-review-gate-conflict' : 'required-checks-not-successful',
    affected };
  // The contract covers required names; any optional failure still vetoes review-only handling,
  // including foreign-head rows. Do not filter or collapse away that independent red evidence.
  const requiredNames = new Set(Array.isArray(requiredChecks) ? requiredChecks : []);
  const nonRequired = [...new Set((Array.isArray(checks) ? checks : [])
    .filter(row => isFailedCheckRow(row) && !requiredNames.has(row?.name || row?.context))
    .map(row => row.name || row.context))];
  const gatesOnlyRed = ['pass', 'held'].includes(state) && nonReviewOwned.length === 0;
  const onlyRed = gatesOnlyRed && nonRequired.length === 0;
  return { absent: false, refusal, checkEvidence, reviewOwnedChecks: {
    ci,
    required: unsettled.map(([name]) => name), nonRequired, reviewOwned, nonReviewOwned,
    gatesOnlyRed, onlyRed,
  } };
}

/** Preserve refusal order, multiplicity and metadata, including parallel per-PR refusals. */
export function readPlannerRows({ plan, refusals = plan?.refusals ?? [], ...inputs } = {}) {
  return refusals.map(refusal => readPlannerRow({ ...inputs, plan,
    pr: refusal?.prNumber, refusals: [refusal] })).filter(row => !row.absent);
}
