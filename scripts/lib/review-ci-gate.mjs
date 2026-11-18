/** Strict review prerequisite: adapt the shared evidence contract to the review API. */
import { resolveRequiredChecks } from './check-state-predicate.mjs';

// Review-owned checks wait on the review being admitted, regardless of their outcome.
export const isReviewOwnedCheck = name => name === 'review-gate' || name === 'merge-gate';
export const reviewRequiredChecks = names => Array.isArray(names) ? names.filter(name => !isReviewOwnedCheck(name)) : names;

export function reviewCiGate({ headSha, requiredChecks, checks, rowsHead = headSha, rowsComplete = false, rosterSource } = {}) {
  // Bare rollup arrays carry no pagination proof; callers must attest completeness.
  const validRoster = Array.isArray(requiredChecks) && requiredChecks.length > 0
    && [...requiredChecks].every(name => typeof name === 'string' && name.trim());
  const result = resolveRequiredChecks({ rows: checks, rowsHead, rowsComplete, head: headSha, requiredNames: reviewRequiredChecks(requiredChecks), rosterSource, allowEmptyRequiredNames: validRoster });
  const affected = Object.entries(result.perName).filter(([, r]) => r.state !== 'pass').map(([name, r]) => ({
    name, reason: r.reasons.includes('foreign-head') ? 'wrong-head' : r.reasons[0] ?? r.state,
  }));
  const reason = result.reasons.includes('missing-head') ? 'missing-head'
    : result.reasons.includes('roster-unavailable') ? 'unknown-required-set'
    : Object.values(result.perName).some(r => r.rows.length > 0 && ['pending', 'fail'].includes(r.state)) ? 'required-checks-not-successful'
    : result.reasons.includes('rows-incomplete') ? 'rows-incomplete'
    : result.state === 'pass' ? 'required-checks-successful'
    : 'required-checks-not-successful';
  // Observed blockers explain the refusal first; pagination still prevents admission.
  const secondaryReasons = reason !== 'rows-incomplete' && result.reasons.includes('rows-incomplete') ? ['rows-incomplete'] : [];
  return { allowed: result.state === 'pass', ...(result.state === 'unknown' ? { unknown: true } : {}),
    ...(secondaryReasons.length ? { secondaryReasons } : {}), headSha: headSha ?? null, reason, affected };
}
