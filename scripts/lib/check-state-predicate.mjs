/**
 * Pure check-state policy. Known unfinished statuses are pending. Completed
 * SUCCESS/NEUTRAL/SKIPPED are green; FAILURE/TIMED_OUT/ACTION_REQUIRED/
 * STARTUP_FAILURE are red. CANCELLED and STALE stay pending: a re-run is
 * expected, and neither outcome can ever establish successful admission.
 * Missing/empty completed conclusions and unknown evidence fail closed (red).
 * An absent status with a conclusion is treated as completed. Only an explicit
 * required === false changes non-green outcomes to ignore.
 */
export const CHECK_STATE_TABLE = Object.freeze({
  queued: 'pending',
  in_progress: 'pending',
  waiting: 'pending',
  requested: 'pending',
  pending: 'pending',
  completed: Object.freeze({
    success: 'green',
    neutral: 'green',
    skipped: 'green',
    failure: 'red',
    timed_out: 'red',
    action_required: 'red',
    startup_failure: 'red',
    cancelled: 'pending',
    stale: 'pending',
  }),
});

const normalize = (value) => typeof value === 'string' ? value.toLowerCase() : '';
const ownValue = (table, key) => Object.hasOwn(table, key) ? table[key] : 'red';

/**
 * Classify REST or GraphQL check evidence, case-insensitively.
 * @param {object} check Check row; required defaults to true.
 * @returns {'green'|'red'|'pending'|'ignore'} Admission state.
 * @example classifyCheck({ status: 'COMPLETED', conclusion: 'SUCCESS' }); // green
 */
export function classifyCheck(check = {}) {
  const status = check.status == null && check.conclusion != null
    ? 'completed' : normalize(check.status);
  const state = status === 'completed'
    ? ownValue(CHECK_STATE_TABLE.completed, normalize(check.conclusion))
    : ownValue(CHECK_STATE_TABLE, status);
  return check.required === false && state !== 'green' ? 'ignore' : state;
}

// Only canonical non-negative integers rank; missing/garbage evidence is zero.
// Keep string IDs exact above Number.MAX_SAFE_INTEGER.
const numeric = (value) => {
  if (typeof value !== 'number' && typeof value !== 'string') return 0n;
  const integer = String(value);
  return /^(0|[1-9][0-9]*)$/.test(integer) ? BigInt(integer) : 0n;
};

/**
 * Select the latest attempt per name. Within a known workflow run, compare
 * (run_attempt, id); across runs, compare completion/start times when complete,
 * then global check ids (or run ids when check ids are incomplete). A rerun can
 * finish later than a workflow with a larger run id. Without run identities, retain the
 * (run_attempt, id) ranking; with mixed identities, prefer global check ids
 * before attempts so counters from different runs cannot hide newer evidence.
 * Exact ties retain the first row. Inputs are never mutated.
 * @param {object[]} checks Check attempts.
 * @returns {object[]} Original winning rows, in first-seen name order.
 * @example latestAttempts([{ name: 'ci', id: 1 }, { name: 'ci', id: 2 }]);
 */
export function latestAttempts(checks = []) {
  const groups = new Map();
  for (const check of checks) {
    const name = normalize(check.name);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(check);
  }
  return [...groups.values()].map(group => {
    const allRunsKnown = group.every(check => numeric(check.run_id) > 0n);
    const someRunsKnown = group.some(check => numeric(check.run_id) > 0n);
    if (allRunsKnown && new Set(group.map(check => numeric(check.run_id))).size > 1) {
      // Reduce each run first, so stale timestamps cannot resurrect an earlier
      // attempt of that same run. Then compare these independent run winners.
      const runs = new Map();
      for (const check of group) {
        const run = numeric(check.run_id);
        if (!runs.has(run)) runs.set(run, []);
        runs.get(run).push(check);
      }
      const winners = [...runs.values()].map(rows => latestAttempts(rows)[0]);
      const time = row => Date.parse(row.completedAt ?? row.completed_at ?? row.startedAt ?? row.started_at);
      const dated = winners.every(row => Number.isFinite(time(row)));
      const fields = winners.every(row => numeric(row.id) > 0n) ? ['id', 'run_id'] : ['run_id', 'id'];
      return winners.reduce((previous, check) => {
        if (dated && time(check) !== time(previous)) return time(check) > time(previous) ? check : previous;
        for (const field of fields) {
          const difference = numeric(check[field]) - numeric(previous[field]);
          if (difference !== 0n) return difference > 0n ? check : previous;
        }
        return previous;
      });
    }
    const fields = allRunsKnown ? ['run_attempt', 'id']
      : someRunsKnown ? ['id', 'run_attempt'] : ['run_attempt', 'id'];
    return group.reduce((previous, check) => {
      for (const field of fields) {
        const difference = numeric(check[field]) - numeric(previous[field]);
        if (difference !== 0n) return difference > 0n ? check : previous;
      }
      return previous;
    });
  });
}

/**
 * Summarize latest required attempts; absent roster entries remain pending.
 * An explicit roster determines requiredness; otherwise row flags apply.
 * Names are case-insensitive and returned in lowercase.
 * @param {object[]} checks Check attempts.
 * @param {object} options Optional requiredNames and holdGateNames arrays.
 * @returns {{redSet: Set<string>, pendingSet: Set<string>, gateOnlyRed: boolean,
 * allRequiredGreen: boolean}} Required blockers and gate-only failure signal.
 * @example summarize([], { requiredNames: ['ci'] }); // ci is pending
 */
export function summarize(checks = [], {
  requiredNames,
  holdGateNames = ['review-gate', 'merge-gate'],
} = {}) {
  const latest = latestAttempts(checks);
  const required = requiredNames === undefined ? null : new Set(requiredNames.map(normalize));
  const gates = new Set(holdGateNames.map(normalize));
  const observed = new Set();
  const redSet = new Set();
  const pendingSet = new Set();
  for (const check of latest) {
    const name = normalize(check.name);
    observed.add(name);
    const state = classifyCheck(required === null
      ? check : { ...check, required: required.has(name) });
    if (state === 'red') redSet.add(name);
    if (state === 'pending') pendingSet.add(name);
  }
  for (const name of required ?? []) {
    if (!observed.has(name)) pendingSet.add(name);
  }
  return {
    redSet,
    pendingSet,
    gateOnlyRed: redSet.size > 0 && [...redSet].every((name) => gates.has(name)),
    allRequiredGreen: redSet.size === 0 && pendingSet.size === 0,
  };
}
