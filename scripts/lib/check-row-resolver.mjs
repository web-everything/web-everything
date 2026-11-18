/** Latest attempts are comparable only within an exact workflow/check-name/evidence-kind group. */
import { classifyCheck } from './check-state-predicate.mjs';
import { rollupRowKind } from './rollup-collapse.mjs';

const present = value => ((typeof value === 'string' && value.trim())
  || (typeof value === 'number' && Number.isFinite(value))) ? String(value) : null;
function workflowOf(row) {
  const workflows = [row?.workflow, row?.workflowRun?.workflow, row?.checkSuite?.workflowRun?.workflow]
    .filter(workflow => workflow && typeof workflow === 'object');
  const first = values => values.map(present).find(value => value !== null) ?? null;
  // Row ids and workflowRun ids identify attempts, never workflows.
  const id = first(workflows.map(workflow => workflow.databaseId))
    ?? first(workflows.map(workflow => workflow.id)) ?? present(row?.workflow_id)
    ?? first(workflows.flatMap(workflow => [workflow.resourcePath, workflow.url, workflow.path]));
  return { id };
}

const successful = row => String(row?.conclusion ?? '').toUpperCase() === 'SUCCESS'
  && (row?.status == null || String(row.status).toUpperCase() === 'COMPLETED');

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
 * One row per stable workflow identity/check name/evidence kind. Any missing workflow id
 * makes the entire check name ambiguous; missing start times also disable ordering. Ties
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
    const key = name ? JSON.stringify([name, kind]) : Symbol('nameless');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  // One unknown identity makes the entire check name incomparable, even if
  // the display names differ or the unknown row belongs to another evidence kind.
  const ambiguousNames = new Set((Array.isArray(rows) ? rows : [])
    .filter(row => !workflowOf(row).id).map(row => row?.name || row?.context));
  const partitions = [...groups.values()].flatMap(bucket => {
    if (ambiguousNames.has(bucket[0]?.name || bucket[0]?.context)) return [bucket];
    const byWorkflow = new Map();
    for (const row of bucket) {
      const id = workflowOf(row).id;
      if (!byWorkflow.has(id)) byWorkflow.set(id, []);
      byWorkflow.get(id).push(row);
    }
    return [...byWorkflow.values()];
  });
  return partitions.map(group => {
    const ambiguous = ambiguousNames.has(group[0]?.name || group[0]?.context);
    const times = group.map(attemptTime);
    const latest = ambiguous || times.includes(null)
      ? null : times.reduce((max, time) => Math.max(max, time), 0);
    const candidates = latest === null ? group : group.filter((_, i) => times[i] === latest);
    // Failure remains evidence until a strictly later completed SUCCESS in the
    // same identified group. Pending and non-proving conclusions cannot clear it.
    const failures = group.filter(row => classify(row) === 'red' && !successful(row));
    const uncleared = failures.filter(failure => latest === null || !group.some(row =>
      successful(row) && attemptTime(row) > attemptTime(failure)));
    if (uncleared.length) return uncleared[0];
    const rank = row => ({ green: 0, pending: 1, red: 2 }[classify(row)] ?? 2);
    return candidates.reduce((worst, row) => rank(row) > rank(worst) ? row : worst);
  });
}

/** One worst row per exact check name, after resolving each workflow's attempts. */
export function resolveCheckNames(rows, classify = stateOf) {
  const byName = new Map();
  const rank = row => ({ green: 0, pending: 1, red: 2 }[classify(row)] ?? 2);
  for (const row of resolveCheckRows(rows, classify)) {
    const name = row?.name || row?.context;
    if (!byName.has(name) || rank(row) > rank(byName.get(name))) byName.set(name, row);
  }
  return [...byName.values()];
}
