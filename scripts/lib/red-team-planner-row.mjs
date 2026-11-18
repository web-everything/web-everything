/** A read-only view of reconciliation evidence; this module does not nominate work. */
import { resolveRequiredChecks } from './check-state-predicate.mjs';
import { isFailedCheckRow } from './rollup-collapse.mjs';
import { repoKeyForSlug } from './constellation-repos.mjs';
import { refuseUnreviewable, planReconcile } from '../conveyor/reconcile-core.mjs';

/** Reach the normal planner's later holds even when an early CI refusal owns the row. */
export function nominationSafety(row, rawPr, { repo, plan } = {}) {
  if (row.absent || !['pass', 'held'].includes(row.checkEvidence?.state)) return 'required check evidence must be pass or held; inspect reconciliation';
  if (!row.reviewOwnedChecks?.onlyRed) return 'non-review checks block nomination; inspect check failures';
  let hold;
  refuseUnreviewable({ pr: rawPr, refuse: kind => { hold = kind; } });
  if (hold) return hold;
  if (!Array.isArray(rawPr?.files) || rawPr.files.length >= 100 || rawPr.files.some(f => typeof f?.path !== 'string' || !f.path.trim()
    || ![f.additions, f.deletions].every(n => Number.isSafeInteger(n) && n >= 0)))
    return 'scope inputs unreadable or incomplete; inspect full changed files before retrying';
  if (!repoKeyForSlug(repo)) return 'planner options unreadable; inspect reconciliation';
  const options = plan?.plannerOptions ?? plan?.nominationOptions;
  const safety = planReconcile({ ...options, repo: repoKeyForSlug(repo), prs: [rawPr], agents: [],
    requiredChecks: options?.requiredChecks ?? plan?.plannerRequiredChecks,
    reviewSafetyOnly: true, shadowDeps: { mode: 'off' } });
  return safety.refusals.find(r => !['no-findings', 'already-reviewed-head'].includes(r.kind)
    && !(r.kind === 'review-ci' && r.ci?.affected?.length && r.ci.affected.every(c => row.checkEvidence.perName[c.name]?.state === 'held')))?.kind
    ?? safety.dispatch.find(r => r.kind !== 'review')?.kind
    ?? (safety.dispatch.length || safety.refusals.length ? null : 'no review owed; inspect reconciliation');
}

export const RED_TEAM_NOMINATION_KINDS = ['already-reviewed-head', 'review-ci', 'ci-heal-escalated', 'owed-ci-rerun'];

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
