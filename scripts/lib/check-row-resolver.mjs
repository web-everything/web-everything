/** Latest attempts are comparable only within an exact workflow/check-name pair. */
import { classifyCheck } from './check-state-predicate.mjs';

const workflowOf = row => row?.workflowName || row?.workflow
  || row?.checkSuite?.workflowRun?.workflow?.name || null;

// Prefer start time (attempt order), falling back to completion for completed-only feeds.
function attemptTime(row) {
  const value = row?.startedAt ?? row?.started_at ?? row?.completedAt ?? row?.completed_at;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/i.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > 0 ? time : null;
}

const stateOf = row => classifyCheck({ ...row, required: true,
  ...(row?.status == null && row?.state != null
    ? { status: /^(pending|expected)$/i.test(row.state) ? 'pending' : 'completed', conclusion: row.state } : {}),
});

/**
 * One row per workflow/name. Missing times make the whole group ambiguous; ties
 * and ambiguous groups prefer red, then pending, then green. IDs/input order
 * never establish recency. Callers may supply their stricter state policy.
 * Rows without workflow information share one group per name. Inputs stay intact.
 */
export function resolveCheckRows(rows, classify = stateOf) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const name = row?.name || row?.context;
    const key = name ? JSON.stringify([workflowOf(row), name]) : Symbol('nameless');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map(group => {
    const times = group.map(attemptTime);
    const latest = times.includes(null) ? null : times.reduce((max, time) => Math.max(max, time), 0);
    const candidates = latest === null ? group : group.filter((_, i) => times[i] === latest);
    const rank = row => ({ green: 0, pending: 1, red: 2 }[classify(row)] ?? 2);
    return candidates.reduce((worst, row) => rank(row) > rank(worst) ? row : worst);
  });
}
