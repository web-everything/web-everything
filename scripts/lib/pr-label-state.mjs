/** Pure PR label invariants. No evidence reads or label writes belong here. */
function names(values, field) {
  if (!Array.isArray(values)) throw new TypeError(`${field} must be a label array`);
  const result = values.map(value => typeof value === 'string' ? value : value?.name);
  if (result.some(value => typeof value !== 'string' || !value.length)) {
    throw new TypeError(`${field} contains an unreadable label`);
  }
  return [...new Set(result)];
}

/**
 * Apply removals, then additions, then enforce invariants. Inputs are never mutated.
 * The last status requested in add wins (including an already-present status).
 * Without a request, the lexically smallest status wins, independent of input order.
 * add/remove are net deltas against the input, with requested removals first.
 * violations describes contradictions repaired after applying the requested change.
 * Unreadable labels throw: callers must retain their holds and retry the read.
 * enforceClearance defaults to true; writers preserving pre-review readiness opt out.
 */
export function reduceLabelState({ labels, add = [], remove = [], enforceClearance = true, enforceSingleStatus = true } = {}) {
  const before = names(labels, 'labels');
  // Preserve request order including repeats: the last request must win.
  names(add, 'add');
  const requested = add.map(value => typeof value === 'string' ? value : value.name);
  const removals = names(remove, 'remove');
  const after = new Set(before.filter(label => !removals.includes(label)));
  for (const label of requested) after.add(label);
  const violations = [];
  if (after.has('ready-to-merge') && after.has('review:changes')) {
    violations.push('review-changes-ready');
    after.delete('ready-to-merge');
  }
  const statuses = [...after].filter(label => label.startsWith('status:'));
  if (enforceSingleStatus && statuses.length > 1) {
    violations.push('multiple-status');
    const winner = requested.filter(label => label.startsWith('status:')).at(-1) ?? [...statuses].sort()[0];
    for (const label of statuses) if (label !== winner) after.delete(label);
  }
  if (enforceClearance && after.has('ready-to-merge') && (!after.has('review:accepted') || !after.has('red-team:clear'))) {
    violations.push('ready-without-clearance');
    after.delete('ready-to-merge');
  }
  return { labels: [...after], add: [...after].filter(label => !before.includes(label)),
    remove: [...new Set([...removals, ...before])].filter(label => before.includes(label) && !after.has(label)),
    violations };
}

/** Normalize an existing set, using the same deterministic status precedence. */
export function normalizeLabelSet(labels) {
  return reduceLabelState({ labels }).labels;
}
