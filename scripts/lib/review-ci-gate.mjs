/** Strict review prerequisite; independent of the general merge/CI reducer. */
import { collapseRollupToLatestPerName } from './rollup-collapse.mjs';
import { withoutImpliedRequiredChecks } from './required-check-implication.mjs';

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

/** Shared head-bound prerequisite selection; foreign rows cannot imply required checks away. */
export function reviewCiPrerequisites({ headSha, requiredChecks, checks }) {
  const latest = new Map(collapseRollupToLatestPerName(checks).map(row => [row?.name ?? row?.context, statusAsCheckRow(row)]));
  // Validate explicit row heads before allowing an aggregate to imply a required check.
  const wrongHeads = new Set([...latest].filter(([, row]) => row?.head_sha != null && row.head_sha !== headSha).map(([name]) => name));
  const currentRows = [...latest].filter(([name]) => !wrongHeads.has(name)).map(([, row]) => row);
  const needed = withoutImpliedRequiredChecks(requiredChecks, currentRows);
  // A wrong-head row is reported when required, or when it alone would have implied a required check away.
  const impliedAway = needed.length !== withoutImpliedRequiredChecks(requiredChecks, [...latest.values()]).length;
  const wrongHeadNames = [...wrongHeads].filter(name => impliedAway || requiredChecks.includes(name));
  return { latest, wrongHeads, needed: [...new Set([...wrongHeadNames, ...needed])] };
}

export function reviewCiGate({ headSha, requiredChecks, checks, rowsHead, rowsComplete } = {}) {
  const refuse = (reason, affected = []) => ({ allowed: false, headSha: headSha ?? null, reason, affected });
  if (typeof headSha !== 'string' || !headSha.trim()) return refuse('missing-head');
  if (rowsComplete !== true || rowsHead !== headSha)
    return { ...refuse('rows-incomplete'), unknown: true };
  if (!Array.isArray(requiredChecks) || !requiredChecks.length
      || requiredChecks.some(name => typeof name !== 'string' || !name.trim())) return refuse('unknown-required-set');
  const { latest, wrongHeads, needed } = reviewCiPrerequisites({ headSha, requiredChecks, checks });
  const affected = needed.flatMap(name => {
    const row = latest.get(name);
    let reason;
    if (!row) reason = 'missing';
    else if (wrongHeads.has(name)) reason = 'wrong-head';
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
