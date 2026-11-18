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
  const name = present(row?.workflowName)
    ?? (typeof row?.workflow === 'string' ? present(row.workflow) : null) ?? first(workflows.map(workflow => workflow.name));
  return { id, name };
}

const nonProving = row => /^(skipped|neutral|cancelled|canceled|stale)$/i.test(row?.conclusion ?? row?.state ?? '');

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
 * One row per workflow identity/name/evidence kind. Missing workflows or start times make the whole group ambiguous; ties
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
  const partitions = [...groups.values()].flatMap(bucket => {
    const parts = [];
    for (const row of bucket) {
      const workflow = workflowOf(row);
      const matches = parts.filter(part => part.some(other => {
        const candidate = workflowOf(other);
        return workflow.id && candidate.id ? workflow.id === candidate.id : workflow.name === candidate.name;
      }));
      // A name-only row bridges every matching identity. Such evidence is
      // ambiguous, so no timestamp can hide another member of the partition.
      const merged = [...matches.flat(), row];
      for (const part of matches) parts.splice(parts.indexOf(part), 1);
      parts.push(merged);
    }
    return parts;
  });
  return partitions.map(group => {
    const workflows = group.map(workflowOf);
    const ambiguous = workflows.some(w => !w.id && !w.name)
      || (workflows.some(w => w.id) && workflows.some(w => !w.id));
    const times = group.map(attemptTime);
    const latest = ambiguous || times.includes(null)
      ? null : times.reduce((max, time) => Math.max(max, time), 0);
    const candidates = latest === null ? group : group.filter((_, i) => times[i] === latest);
    if (candidates.every(nonProving)) {
      const failure = group.find(row => classify(row) === 'red' && !nonProving(row));
      if (failure) return failure;
    }
    const rank = row => ({ green: 0, pending: 1, red: 2 }[classify(row)] ?? 2);
    return candidates.reduce((worst, row) => rank(row) > rank(worst) ? row : worst);
  });
}
