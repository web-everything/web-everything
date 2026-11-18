/** Latest attempts are comparable only within an exact workflow/check-name/evidence-kind group. */
import { classifyCheck } from './check-state-predicate.mjs';
import { rollupRowKind } from './rollup-collapse.mjs';

const workflowOf = row => row?.workflowName || row?.workflow
  || row?.checkSuite?.workflowRun?.workflow?.name || null;

// Compare attempt starts only: completion order cannot establish attempt order.
function attemptTime(row) {
  const value = row?.startedAt ?? row?.started_at;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/i.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > 0 ? time : null;
}

const stateOf = row => classifyCheck({ ...row, required: true,
  ...(row?.status == null && row?.state != null
    ? { status: /^(pending|expected)$/i.test(row.state) ? 'pending' : 'completed', conclusion: row.state } : {}),
});

/**
 * One row per workflow/name/evidence kind. Missing workflows or start times make the whole group ambiguous; ties
 * and ambiguous groups prefer red, then pending, then green. IDs/input order
 * never establish recency. Callers may supply their stricter state policy.
 * Rows without workflow information share one ambiguous group per name/kind. Inputs stay intact.
 */
export function resolveCheckRows(rows, classify = stateOf) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const name = row?.name || row?.context;
    // Adapters may add `name` to a legacy context; retain its original provenance.
    const kind = !row?.__typename && row?.context != null ? 'StatusContext' : rollupRowKind(row);
    const key = name ? JSON.stringify([workflowOf(row), name, kind]) : Symbol('nameless');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map(group => {
    const times = group.map(attemptTime);
    const latest = !workflowOf(group[0]) || times.includes(null)
      ? null : times.reduce((max, time) => Math.max(max, time), 0);
    const candidates = latest === null ? group : group.filter((_, i) => times[i] === latest);
    const rank = row => ({ green: 0, pending: 1, red: 2 }[classify(row)] ?? 2);
    return candidates.reduce((worst, row) => rank(row) > rank(worst) ? row : worst);
  });
}
