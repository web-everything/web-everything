/** Strict review prerequisite: adapt the shared evidence contract to the review API. */
import { resolveRequiredChecks } from './check-state-predicate.mjs';

export function reviewCiGate({ headSha, requiredChecks, checks, rowsHead = headSha, rowsComplete = false, rosterSource = 'live' } = {}) {
  // Bare rollup arrays carry no pagination proof; callers must attest completeness.
  const result = resolveRequiredChecks({ rows: checks, rowsHead, rowsComplete, head: headSha, requiredNames: requiredChecks, rosterSource, allowImplication: true });
  const affected = Object.entries(result.perName).filter(([, r]) => r.state !== 'pass').map(([name, r]) => ({
    name, reason: r.reasons.includes('foreign-head') ? 'wrong-head' : r.reasons[0] ?? r.state,
  }));
  const reason = result.reasons.includes('missing-head') ? 'missing-head'
    : result.reasons.includes('roster-unavailable') ? 'unknown-required-set'
    : affected.some(r => r.name === 'review-gate') ? 'required-review-gate-conflict'
    : result.reasons.includes('rows-incomplete') ? 'rows-incomplete'
    : result.state === 'pass' ? 'required-checks-successful'
    : 'required-checks-not-successful';
  return { allowed: result.state === 'pass', ...(result.state === 'unknown' ? { unknown: true } : {}), headSha: headSha ?? null, reason, affected };
}
