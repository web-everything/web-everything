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
 * Classify REST or GraphQL status and conclusion values case-insensitively.
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
 * Select the greatest (effective time, check-run id) tuple per exact name.
 * Effective time is completed_at/completedAt, else started_at/startedAt, else
 * created_at/createdAt. Invalid timestamps and pre-2000/epoch
 * timestamps count as absent, falling through to the next valid timestamp.
 * Unfinished rows with no valid timestamps rank newest (+Infinity), conservatively
 * keeping undated attempts pending. Other missing or invalid timestamps rank
 * lowest. Workflow run identities and attempt counters never rank checks;
 * numeric check-run ids break time ties.
 * Exact ties retain the first row. Inputs are never mutated.
 * @param {object[]} checks Check attempts.
 * @returns {object[]} Original winning rows, in first-seen name order.
 * @example latestAttempts([{ name: 'ci', id: 1 }, { name: 'ci', id: 2 }]);
 */
export function latestAttempts(checks = []) {
  const groups = new Map();
  for (const check of checks) {
    const name = check.name;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(check);
  }
  return [...groups.values()].map(group => {
    const effectiveTime = check => {
      for (const field of ['completed_at', 'completedAt', 'started_at', 'startedAt', 'created_at', 'createdAt']) {
        const timestamp = check[field];
        if (timestamp == null) continue;
        const time = Date.parse(timestamp);
        if (!Number.isFinite(time)) continue;
        if (timestamp === 0 || timestamp === '0' || time < Date.UTC(2000, 0, 1)) continue;
        return time;
      }
      return ownValue(CHECK_STATE_TABLE, normalize(check.status)) === 'pending' ? Infinity : -Infinity;
    };
    return group.reduce((previous, check) => {
      const time = effectiveTime(check), previousTime = effectiveTime(previous);
      if (time !== previousTime) return time > previousTime ? check : previous;
      return numeric(check.id) > numeric(previous.id) ? check : previous;
    });
  });
}

/**
 * Summarize latest required attempts; absent roster entries remain pending.
 * An explicit roster determines requiredness; otherwise row flags apply.
 * Names match the required roster and hold gates exactly, as in the drain.
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
  const required = requiredNames === undefined ? null : new Set(requiredNames);
  const gates = new Set(holdGateNames);
  const observed = new Set();
  const redSet = new Set();
  const pendingSet = new Set();
  for (const check of latest) {
    const name = check.name;
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
