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
// #7501 I1: check identity is exact; only status/conclusion are case-folded.
const checkName = (check) => check.name || check.context;
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
// Keep string IDs exact above Number.MAX_SAFE_INTEGER; never consult dates.
const numeric = (value) => {
  if (typeof value !== 'number' && typeof value !== 'string') return 0n;
  const integer = String(value);
  return /^(0|[1-9][0-9]*)$/.test(integer) ? BigInt(integer) : 0n;
};

/**
 * Select the greatest (run_attempt, id) exact integer pair per exact name || context.
 * Exact ties retain the first row. Inputs are never mutated.
 * @param {object[]} checks Check attempts.
 * @returns {object[]} Original winning rows, in first-seen name order.
 * @example latestAttempts([{ name: 'ci', id: 1 }, { name: 'ci', id: 2 }]);
 */
export function latestAttempts(checks = []) {
  const latest = new Map();
  for (const check of checks) {
    const name = checkName(check);
    const previous = latest.get(name);
    const attempt = numeric(check.run_attempt);
    const previousAttempt = numeric(previous?.run_attempt);
    if (!previous || attempt > previousAttempt
      || (attempt === previousAttempt && numeric(check.id) > numeric(previous.id))) {
      latest.set(name, check);
    }
  }
  return [...latest.values()];
}

/**
 * Summarize latest required attempts; absent roster entries remain pending.
 * An explicit roster determines requiredness; otherwise row flags apply.
 * Names match exactly and retain their original case, whitespace, and Unicode.
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
    const name = checkName(check);
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
