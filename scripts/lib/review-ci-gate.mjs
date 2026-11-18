/** Strict review prerequisite: preserve every row until shared evidence resolution. */
import { resolveRequiredChecks } from './check-state-predicate.mjs';

export function reviewCiGate({ headSha, requiredChecks, checks, rowsComplete, rosterSource, rowsHead } = {}) {
  const refuse = (reason, affected = []) => ({ allowed: false, headSha: headSha ?? null, reason, affected });
  const resolved = resolveRequiredChecks({ head: headSha, requiredNames: requiredChecks, rows: checks,
    rowsComplete, rosterSource, rowsHead: rowsHead ?? null });
  const affected = Object.entries(resolved.perName).filter(([, value]) => value.state !== 'pass')
    .map(([name, value]) => ({ name, reason: value.reasons.includes('foreign-head') ? 'wrong-head' : value.reasons[0] ?? value.state }));
  if (resolved.reasons.includes('missing-head')) return refuse('missing-head', affected);
  if (resolved.reasons.includes('roster-unavailable')) return refuse('unknown-required-set', affected);
  if (resolved.state === 'unknown' && (!affected.length || rowsComplete !== true)) return refuse(resolved.reasons.join(','), affected);
  if (affected.length) return refuse(affected.some(row => row.name === 'review-gate')
    ? 'required-review-gate-conflict' : 'required-checks-not-successful', affected);
  return { allowed: true, headSha, reason: 'required-checks-successful', affected: [] };
}
