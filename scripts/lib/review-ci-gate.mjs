/** Strict review prerequisite: adapt the shared evidence contract to the review API. */
import { resolveRequiredChecks } from './check-state-predicate.mjs';
import { isBoundMergeGateExcusal } from './merge-gate-hold-class.mjs';

export function reviewCiGate({ headSha, requiredChecks, checks, rowsHead = headSha, rowsComplete = false, rosterSource = 'live' } = {}) {
  // Bare rollup arrays carry no pagination proof; callers must attest completeness.
  // Only review consumes the classifier's successful candidacy projection. Keep
  // the original annotated rows for planner/merge consumers, which still see held CI.
  const rows = Array.isArray(checks) ? checks.map(row => {
    if (!isBoundMergeGateExcusal(row, headSha)) return row;
    const { mergeGateHoldExcused, ...excused } = row;
    return excused;
  }) : checks;
  const result = resolveRequiredChecks({ rows, rowsHead, rowsComplete, head: headSha, requiredNames: requiredChecks, rosterSource, allowImplication: true });
  const affected = Object.entries(result.perName).filter(([, r]) => r.state !== 'pass').map(([name, r]) => ({
    name, reason: r.reasons.includes('foreign-head') ? 'wrong-head' : r.reasons[0] ?? r.state,
  }));
  const reason = result.reasons.includes('missing-head') ? 'missing-head'
    : result.reasons.includes('roster-unavailable') ? 'unknown-required-set'
    : affected.some(r => r.name === 'review-gate') ? 'required-review-gate-conflict'
    : Object.values(result.perName).some(r => r.rows.length > 0 && ['pending', 'fail'].includes(r.state)) ? 'required-checks-not-successful'
    : result.reasons.includes('rows-incomplete') ? 'rows-incomplete'
    : result.state === 'pass' ? 'required-checks-successful'
    : 'required-checks-not-successful';
  // Observed blockers explain the refusal first; pagination still prevents admission.
  const secondaryReasons = reason !== 'rows-incomplete' && result.reasons.includes('rows-incomplete') ? ['rows-incomplete'] : [];
  return { allowed: result.state === 'pass', ...(result.state === 'unknown' ? { unknown: true } : {}),
    ...(secondaryReasons.length ? { secondaryReasons } : {}), headSha: headSha ?? null, reason, affected };
}
