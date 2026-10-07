/** Strict review prerequisite; independent of the general merge/CI reducer. */
import { collapseRollupToLatestPerName } from './rollup-collapse.mjs';
import { withoutImpliedRequiredChecks } from './required-status-checks.mjs';

/**
 * A legacy commit status / rollup `StatusContext` (`{context, state}`, no check-run `status`/`conclusion`) read as
 * the equivalent completed check row, so a required context published through commit statuses can satisfy the
 * gate. Check-run rows pass through untouched; an unknown `state` stays malformed (fail closed).
 */
function statusAsCheckRow(row) {
  if (!row || typeof row !== 'object' || row.status !== undefined || typeof row.state !== 'string') return row;
  const state = row.state.toLowerCase();
  if (state === 'success') return { ...row, status: 'completed', conclusion: 'success' };
  if (state === 'failure' || state === 'error') return { ...row, status: 'completed', conclusion: state };
  if (state === 'pending' || state === 'expected') return { ...row, status: 'pending' };
  return row;
}

export function reviewCiGate({ headSha, requiredChecks, checks } = {}) {
  const refuse = (reason, affected = []) => ({ allowed: false, headSha: headSha ?? null, reason, affected });
  if (typeof headSha !== 'string' || !headSha.trim()) return refuse('missing-head');
  if (!Array.isArray(requiredChecks) || !requiredChecks.length
      || requiredChecks.some(name => typeof name !== 'string' || !name.trim())) return refuse('unknown-required-set');
  const latest = new Map(collapseRollupToLatestPerName(checks).map(row => [row?.name ?? row?.context, statusAsCheckRow(row)]));
  const affected = [...new Set(withoutImpliedRequiredChecks(requiredChecks, [...latest.values()]))].flatMap(name => {
    const row = latest.get(name);
    let reason;
    if (!row) reason = 'missing';
    else if (row.head_sha && row.head_sha !== headSha) reason = 'wrong-head';
    else if (typeof row.status !== 'string') reason = 'malformed';
    else if (['queued', 'in_progress', 'pending', 'waiting', 'requested'].includes(row.status.toLowerCase())) reason = 'pending';
    else if (row.status.toLowerCase() !== 'completed' || typeof row.conclusion !== 'string') reason = 'malformed';
    else if (row.conclusion.toLowerCase() !== 'success') reason = row.conclusion.toLowerCase() || 'malformed';
    return reason ? [{ name, reason }] : [];
  });
  if (affected.length) return refuse(affected.some(row => row.name === 'review-gate')
    ? 'required-review-gate-conflict' : 'required-checks-not-successful', affected);
  return { allowed: true, headSha, reason: 'required-checks-successful', affected: [] };
}
