/** Review-hold evidence only. Never change the shared per-name collapse policy. */
import { classifyCheck } from './check-state-predicate.mjs';

const scalar = value => Number.isSafeInteger(value) && value > 0 ? String(value)
  : typeof value === 'string' && value.trim() ? value : null;
const nameOf = row => row?.name || row?.context;
const runOf = row => scalar(row?.workflowRun?.databaseId ?? row?.workflowRun?.id
  ?? row?.checkSuite?.workflowRun?.databaseId ?? row?.checkSuite?.workflowRun?.id
  ?? row?.workflow_run?.id ?? row?.run_id ?? row?.runId);
const attemptOf = row => row?.run_attempt ?? row?.runAttempt
  ?? row?.workflowRun?.runAttempt ?? row?.workflowRun?.run_attempt
  ?? row?.checkSuite?.workflowRun?.runAttempt ?? row?.workflow_run?.run_attempt;
const attemptNumber = value => /^(?:[1-9]\d*)$/.test(String(value))
  && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const completedTime = row => {
  const value = row?.completedAt ?? row?.completed_at;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= Date.UTC(2000, 0, 1) ? time : null;
};
const completed = row => typeof row?.status === 'string' && row.status.toLowerCase() === 'completed';

function laterSameJob(older, newer) {
  const run = runOf(older);
  if (!run || run !== runOf(newer) || typeof nameOf(older) !== 'string'
    || nameOf(older) !== nameOf(newer)
    || older?.__typename === 'StatusContext' || newer?.__typename === 'StatusContext') return false;
  // Conflicting source metadata cannot be borrowed to establish a rerun.
  for (const source of [row => row?.workflowName ?? row?.workflow_name,
    row => row?.checkSuite?.id ?? row?.check_suite?.id]) {
    const a = scalar(source(older)), b = scalar(source(newer));
    if (a && b && a !== b) return false;
  }
  const a = attemptOf(older), b = attemptOf(newer);
  if (a !== undefined || b !== undefined) {
    const first = attemptNumber(a), next = attemptNumber(b);
    if (first === null || next === null) return false;
    if (first !== next) return next > first;
  }
  const first = completedTime(older), next = completedTime(newer);
  return first !== null && next !== null && next > first;
}

/**
 * Retain RAW rows except a known completed failure cleared by a proven green rerun.
 * Check IDs, suites, workflow names and start times alone never prove supersession.
 * Pending, cancelled, malformed and unknown rows always remain, even beside a rerun.
 */
export function reviewHoldRollupRows(rollup) {
  const rows = Array.isArray(rollup) ? Array.from(rollup) : [];
  const green = rows.filter(row => completed(row) && classifyCheck({ ...row, required: true }) === 'green');
  return rows.filter(row => !completed(row)
    || typeof row?.conclusion !== 'string'
    || !['failure', 'timed_out', 'action_required', 'startup_failure'].includes(String(row?.conclusion).toLowerCase())
    || !green.some(newer => laterSameJob(row, newer)));
}
