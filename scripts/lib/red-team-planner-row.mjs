/** A read-only view of reconciliation evidence; this module does not nominate work. */
import { createHash } from 'node:crypto';
import { reviewCiGate } from './review-ci-gate.mjs';
import { FAILED_CHECK_CONCLUSIONS } from './rollup-collapse.mjs';
import { splitFailingChecks, reviewHoldGatesOnlyRed, reviewHoldOnlyRed } from '../conveyor/reconcile-core.mjs';

function classificationKey(repo, pr, head, requiredChecks) {
  if (typeof repo !== 'string' || !repo.trim() || !Number.isSafeInteger(Number(pr)) || Number(pr) <= 0
    || typeof head !== 'string' || !head.trim() || !Array.isArray(requiredChecks) || !requiredChecks.length
    || requiredChecks.some(name => typeof name !== 'string' || !name.trim())) return null;
  const hash = createHash('sha256').update(JSON.stringify([...new Set(requiredChecks)].sort())).digest('hex');
  return JSON.stringify([repo, Number(pr), head, hash]);
}

/**
 * Read one refusal without flattening its folded reviewRefusal. Production plans carry the check
 * classification made with the reconciler's enriched PR and required set, rather than the daemon's raw PR.
 * Explicit rawPrs/requiredChecks support pure planner fixtures and the reconciliation producer itself.
 * Missing reconciliation evidence is distinct from an available row with unknown CI evidence.
 */
export function readPlannerRow({ repo, pr, plan, refusals = plan?.refusals ?? [],
  rawPrs = plan?.enrichedPrs ?? [], requiredChecks = plan?.plannerOptions?.requiredChecks ?? plan?.plannerRequiredChecks ?? null } = {}) {
  if (!Array.isArray(refusals)) return { absent: true };
  const refusal = refusals.find(row => row && Object.is(Number(row.prNumber), Number(pr)));
  if (!refusal) return { absent: true };
  const rawPr = rawPrs?.find(row => Object.is(Number(row?.number), Number(pr)));
  const key = classificationKey(repo, pr, rawPr?.headRefOid, requiredChecks);
  const saved = key && plan?.plannerRows?.find(row => !row?.absent && row?.classificationKey === key);
  if (saved) return { absent: false, refusal, classificationKey: key, reviewOwnedChecks: saved.reviewOwnedChecks };
  const checks = rawPr?.statusCheckRollup;
  const failing = splitFailingChecks(checks, requiredChecks);
  // Ask the existing normal-path classifier separately for each failing required check. In particular,
  // a plain merge-gate (or red-team) failure is not silently promoted to a review-owned hold.
  const reviewOwned = failing.required.filter(name => reviewHoldGatesOnlyRed(checks, [name]));
  const ci = reviewCiGate({ headSha: rawPr?.headRefOid, requiredChecks, checks });
  // The SAME head-aware classification must prove that only failed review holds need excusing.
  const onlyFailures = ci.affected.length > 0 && ci.affected.every(({ name, reason }) =>
    reviewOwned.includes(name) && FAILED_CHECK_CONCLUSIONS.includes(reason.toUpperCase()));
  return { absent: false, refusal, classificationKey: key, reviewOwnedChecks: {
    ci,
    ...failing, reviewOwned, nonReviewOwned: failing.required.filter(name => !reviewOwned.includes(name)),
    gatesOnlyRed: reviewHoldGatesOnlyRed(checks, requiredChecks),
    onlyRed: onlyFailures && reviewHoldOnlyRed(checks, requiredChecks),
  } };
}

/** Preserve refusal order, multiplicity and metadata, including parallel per-PR refusals. */
export function readPlannerRows({ plan, refusals = plan?.refusals ?? [], ...inputs } = {}) {
  return refusals.map(refusal => readPlannerRow({ ...inputs, plan,
    pr: refusal?.prNumber, refusals: [refusal] })).filter(row => !row.absent);
}
