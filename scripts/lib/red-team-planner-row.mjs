/** Read-only reconciliation evidence and nomination eligibility; no dispatch or effects. */
import { redTeamForHead } from './red-team-gate.mjs';
import { reviewCiGate } from './review-ci-gate.mjs';
import { FAILED_CHECK_CONCLUSIONS, isFailedCheckRow } from './rollup-collapse.mjs';
import { repoKeyForSlug } from './constellation-repos.mjs';
import { splitFailingChecks, reviewHoldGatesOnlyRed, reviewHoldOnlyRed, refuseUnreviewable, planReconcile } from '../conveyor/reconcile-core.mjs';

/** Reuse the normal gates, continuing past CI ownership without performing effects. Unknown scope holds. */
function nominationSafety(pr, options, reviewOwnedCi, reviewOwned) {
  let hold;
  refuseUnreviewable({ pr, refuse: (kind, row) => { hold = `${kind}: ${row.why}`; } });
  if (hold) return hold;
  if (!Array.isArray(pr?.files) || pr.files.length >= 100 || pr.files.some(f => typeof f?.path !== 'string' || !f.path.trim()
    || ![f.additions, f.deletions].every(n => Number.isSafeInteger(n) && n >= 0)))
    return 'scope inputs unreadable or incomplete; inspect the full changed files and size before retrying';
  if (!repoKeyForSlug(options.repo)) return 'planner options unreadable; inspect reconciliation before retrying';
  const safety = planReconcile({ ...options, repo: repoKeyForSlug(options.repo), prs: [{ ...pr, labels: pr.labels?.map(l => typeof l === 'string' ? { name: l } : l) }], agents: [], reviewSafetyOnly: true });
  return safety.refusals.find(r => r.kind !== 'no-findings' && !(r.kind === 'review-ci' && reviewOwnedCi
    && r.ci?.affected?.length && r.ci.affected.every(check => reviewOwned.includes(check.name))))?.kind
    ?? safety.dispatch.find(r => r.kind !== 'review')?.kind ?? (safety.dispatch.length || safety.refusals.some(r => r.kind === 'review-ci') ? null : 'no review owed; inspect reconciliation');
}

/**
 * Read one refusal without flattening its folded reviewRefusal. Always classify the current input;
 * saved planner rows cannot reflect check reruns on the same head.
 * Explicit rawPrs/requiredChecks support pure planner fixtures and the reconciliation producer itself.
 * Missing reconciliation evidence is distinct from an available row with unknown CI evidence.
 */
export function readPlannerRow({ repo, pr, plan, refusals = plan?.refusals ?? [],
  rawPrs = plan?.enrichedPrs ?? [], requiredChecks = plan?.plannerOptions?.requiredChecks ?? plan?.plannerRequiredChecks ?? null } = {}) {
  if (!Array.isArray(refusals)) return { absent: true };
  const refusal = refusals.find(row => row && Object.is(Number(row.prNumber), Number(pr)));
  if (!refusal) return { absent: true };
  const rawPr = rawPrs?.find(row => Object.is(Number(row?.number), Number(pr)));
  const checks = rawPr?.statusCheckRollup;
  const failing = splitFailingChecks(checks, requiredChecks);
  const fullCi = reviewCiGate({ headSha: rawPr?.headRefOid, requiredChecks, checks });
  // Preserve wrong-head refusals, and independently require current-head implication evidence.
  // Unheaded rollup rows retain the gate's assumption that they belong to the fetched PR head.
  const currentCi = reviewCiGate({ headSha: rawPr?.headRefOid, requiredChecks,
    checks: Array.isArray(checks) ? checks.filter(row => !row?.head_sha || row.head_sha === rawPr?.headRefOid) : checks });
  const ci = fullCi.allowed ? currentCi : { ...fullCi, affected: [...fullCi.affected,
    ...currentCi.affected.filter(row => !fullCi.affected.some(full => full.name === row.name))] };
  // Classify pending owners with the same hold classifier; CI evidence itself stays pending.
  const pending = ci.affected.filter(check => check.reason === 'pending').map(check => check.name);
  const ownershipChecks = Array.isArray(checks) ? checks.map(check => pending.includes(check?.name ?? check?.context)
    ? { ...check, status: 'completed', conclusion: 'failure', state: 'failure' } : check) : checks;
  // Ask the existing normal-path classifier separately for each failing or pending required check.
  // A plain merge-gate (or red-team) failure is not silently promoted to a review-owned hold.
  const reviewOwned = [...new Set([...failing.required, ...pending])].filter(name => reviewHoldGatesOnlyRed(ownershipChecks, [name]));
  const reviewOwnedCi = ci.allowed === false && ci.affected.length > 0 && ci.affected.every(check =>
    reviewOwned.includes(check.name) && !['missing', 'wrong-head', 'malformed'].includes(check.reason)
    && !(check.reason === 'pending' && (plan?.plannerOptions?.reviewTiming ?? rawPr?.reviewTiming)?.startEarly === 'off'));
  // The SAME head-aware classification must prove that only failed review holds need excusing.
  const onlyFailures = ci.affected.length > 0 && ci.affected.every(({ name, reason }) =>
    reviewOwned.includes(name) && FAILED_CHECK_CONCLUSIONS.includes(reason.toUpperCase()));
  const noOtherRed = Array.isArray(checks) && checks.every(row => !isFailedCheckRow(row)
    || (Array.isArray(requiredChecks) && requiredChecks.includes(row?.name || row?.context)
      && reviewHoldGatesOnlyRed([row], [row?.name || row?.context])));
  return { absent: false, refusal, nominationSafety: { head: rawPr?.headRefOid,
    hold: nominationSafety({ ...rawPr, statusCheckRollup: checks }, { repo, ...plan?.plannerOptions, requiredChecks }, reviewOwnedCi, reviewOwned) ?? (ci.allowed === false && !reviewOwnedCi ? 'review-ci' : null) }, reviewOwnedChecks: {
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
  if (!row.nominationSafety || row.nominationSafety.head !== rawPr?.headRefOid) return 'planner safety evidence unreadable; inspect reconciliation before retrying';
  if (row.nominationSafety.hold) return `planner safety hold: ${row.nominationSafety.hold}`;
  const checks = row.reviewOwnedChecks;
  if (checks?.ci?.allowed === true && checks.ci.headSha === rawPr.headRefOid && checks.ci.affected?.length === 0) return null;
  if (checks?.ci?.allowed !== false || checks.ci?.headSha !== rawPr.headRefOid
    || !checks.ci.affected?.length || checks.ci.affected.some(check => !checks.reviewOwned?.includes(check.name)
      || ['missing', 'wrong-head', 'malformed'].includes(check.reason)))
    return 'required checks are not exclusively review-owned holds; inspect required checks';
  return null;
}
