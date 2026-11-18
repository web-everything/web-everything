/** Strict review prerequisite: preserve every row until shared evidence resolution. */
import { resolveRequiredChecks } from './check-state-predicate.mjs';

export function reviewCiGate({ headSha, requiredChecks, checks, rowsComplete, rosterSource, rowsHead } = {}) {
  const resolved = resolveRequiredChecks({ head: headSha, requiredNames: requiredChecks, rows: checks,
    rowsComplete, rosterSource, rowsHead: rowsHead ?? null });
  const affected = Object.entries(resolved.perName).filter(([, value]) => value.state !== 'pass')
    .map(([name, value]) => ({ name, reason: value.reasons.includes('foreign-head') ? 'wrong-head' : value.reasons[0] ?? value.state }));
  const reason = resolved.state === 'pass' ? 'required-checks-successful'
    : resolved.reasons.includes('missing-head') ? 'missing-head'
    : resolved.reasons.includes('roster-unavailable') ? 'unknown-required-set'
    : resolved.state === 'unknown' && (!affected.length || rowsComplete !== true) ? resolved.reasons.join(',')
    : affected.some(row => row.name === 'review-gate') ? 'required-review-gate-conflict' : 'required-checks-not-successful';
  return { allowed: resolved.state === 'pass', headSha: headSha ?? null, reason, affected };
}
