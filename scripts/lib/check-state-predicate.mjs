import { humanReviewOnlyHold } from './merge-gate-verdict.mjs';

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
const checkName = (check) => {
  const name = check.name || check.context;
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('Check rows must have a non-empty string name or context');
  }
  return name;
};
const ownValue = (table, key) => Object.hasOwn(table, key) ? table[key] : 'red';

const nameSet = (names, option) => {
  if (!Array.isArray(names)) throw new TypeError(`${option} must be an array of strings`);
  // Iterate holes too: Array#every skips missing entries in a sparse roster.
  for (const name of names) {
    if (typeof name !== 'string') throw new TypeError(`${option} must be an array of strings`);
  }
  return new Set(names);
};

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

/**
 * Compatibility export: retain every original row, without selecting an attempt.
 * Names are exact and conflicting required flags fail closed. Inputs are not mutated.
 * @param {object[]} checks Check evidence.
 * @returns {object[]} All original rows in input order.
 * @example latestAttempts([{ name: 'ci', id: 1 }, { name: 'ci', id: 2 }]);
 */
export function latestAttempts(checks = []) {
  const requiredByName = new Map();
  for (const check of checks) {
    const name = checkName(check);
    const required = check.required !== false;
    if (requiredByName.has(name) && requiredByName.get(name) !== required) {
      throw new TypeError('Check rows have conflicting required flags');
    }
    requiredByName.set(name, required);
  }
  return [...checks];
}

/**
 * Summarize every required row; absent roster entries remain pending.
 * An explicit roster determines requiredness; otherwise row flags apply.
 * Names match exactly and retain their original case, whitespace, and Unicode.
 * Malformed name rosters or check identities throw TypeError rather than admit.
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
  const required = requiredNames === undefined ? null : nameSet(requiredNames, 'requiredNames');
  const gates = nameSet(holdGateNames, 'holdGateNames');
  const rows = latestAttempts(checks);
  const observed = new Set();
  const redSet = new Set();
  const pendingSet = new Set();
  for (const check of rows) {
    const name = checkName(check);
    observed.add(name);
    const state = classifyCheck(required === null
      ? check : { ...check, required: required.has(name) });
    if (state === 'red') redSet.add(name);
    if (state === 'pending') pendingSet.add(name);
  }
  // A name with both red and pending evidence is reported as red once.
  for (const name of redSet) pendingSet.delete(name);
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

// Strict admission is intentionally separate from the compatibility reducers above (PR2).
const evidenceRank = { pass: 0, held: 1, pending: 2, fail: 3, unknown: 4 };
const worstEvidence = states => states.reduce((a, b) => evidenceRank[b] > evidenceRank[a] ? b : a, 'pass');
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}(?![\s\S])/i.test(value) ? value.toLowerCase() : null;
// Canonical positive integers only; unsafe numeric IDs cannot establish ordering.
const evidenceInteger = value => typeof value === 'number'
  ? (Number.isSafeInteger(value) && value > 0 ? BigInt(value) : null)
  : (typeof value === 'string' && /^[1-9][0-9]*(?![\s\S])/.test(value) ? BigInt(value) : null);
const evidenceName = row => row?.name ?? row?.context;
const evidenceJob = row => /\/actions\/runs\/\d+\/job\/(\d+)/.exec(row?.detailsUrl ?? row?.details_url ?? '')?.[1];

// Completed is a lifecycle marker, not an outcome. Compare only explicit
// outcome categories, before legacy mapping or hold excusal rewrites evidence.
const contradictoryEvidence = row => {
  const outcomes = [row?.status, row?.conclusion, row?.state].map(normalize).map(value => {
    if (value === 'error') return 'red';
    if (value === 'expected') return 'pending';
    if (Object.hasOwn(CHECK_STATE_TABLE.completed, value)) return CHECK_STATE_TABLE.completed[value];
    if (value !== 'completed' && Object.hasOwn(CHECK_STATE_TABLE, value)) return CHECK_STATE_TABLE[value];
    return null;
  }).filter(Boolean);
  return new Set(outcomes).size > 1;
};

// A name/run pair alone cannot identify a matrix job. Prefer the Actions job
// identity; otherwise require the same check-run identity, never infer lineage.
const evidenceIdentity = row => {
  const job = evidenceInteger(evidenceJob(row));
  if (job !== null) return `job:${job}`;
  const check = evidenceInteger(row?.check_run_id ?? row?.databaseId ?? row?.id);
  return check === null ? null : `check:${check}`;
};

/** Resolve required evidence without guessing a roster, head, attempt order, or read completeness.
 * Every required name needs its own evidence; historical implication options are ignored.
 * rowsComplete is true only after exhausting pages or explicitly fetching every required name.
 */
export function resolveRequiredChecks({ rows, rowsHead, rowsComplete, requiredNames, rosterSource, head, holds = [], optionalNames = [] } = {}) {
  const perName = Object.create(null), reasons = [];
  const validNames = names => Array.isArray(names) && [...names].every(n => typeof n === 'string' && n.trim());
  if (!['live', 'cache'].includes(rosterSource) || !validNames(requiredNames) || !requiredNames.length) reasons.push('roster-unavailable');
  if (!sha(head)) reasons.push('missing-head');
  if (rowsHead !== undefined && (!sha(rowsHead) || sha(rowsHead) !== sha(head))) reasons.push('foreign-head');
  if (!Array.isArray(rows)) reasons.push('rows-unavailable');
  if (!validNames(optionalNames)) reasons.push('optional-names-malformed');
  if (rowsComplete !== true) reasons.push('rows-incomplete');
  if (reasons.some(reason => reason !== 'rows-incomplete')) return { state: 'unknown', perName, reasons };
  const classified = [...rows].map(row => {
    const name = evidenceName(row), why = [];
    let status = normalize(row?.status), conclusion = normalize(row?.conclusion), legacyError = false;
    // Compatibility excusal rewrites conclusions for legacy consumers. Strict
    // admission rechecks the original failure and binds any hold to this row.
    if (name === 'merge-gate' && row?.mergeGateHoldExcused) conclusion = 'failure';
    if (row?.status === undefined && row?.__typename !== 'CheckRun' && typeof row?.state === 'string') {
      const legacy = normalize(row.state); legacyError = legacy === 'error';
      if (['success', 'failure', 'error'].includes(legacy)) { status = 'completed'; conclusion = legacy; }
      else if (['pending', 'expected'].includes(legacy)) status = 'pending';
    }
    let state = 'unknown';
    if (contradictoryEvidence(row) || typeof name !== 'string' || !name.trim() || !Object.hasOwn(CHECK_STATE_TABLE, status)
      || (row?.conclusion != null && !Object.hasOwn(CHECK_STATE_TABLE.completed, normalize(row.conclusion)))
      || (status === 'completed' && !Object.hasOwn(CHECK_STATE_TABLE.completed, conclusion) && !legacyError)) why.push('malformed');
    else if (status !== 'completed') { state = 'pending'; why.push('pending'); }
    else if (['cancelled', 'stale'].includes(conclusion) || (['review-gate', 'merge-gate'].includes(name) && ['timed_out', 'startup_failure', 'action_required'].includes(conclusion))) { state = 'pending'; why.push('needs-rerun'); }
    else if (conclusion === 'success' || (optionalNames.includes(name) && ['neutral', 'skipped'].includes(conclusion))) state = 'pass';
    else { state = 'fail'; why.push(conclusion); }
    const rowHead = sha(row?.head_sha ?? rowsHead);
    if (!rowHead || rowHead !== sha(head)) {
      // Foreign success is waiting for this head's evidence; foreign failure is unreadable.
      state = state === 'pass' ? 'pending' : 'unknown'; why.unshift('foreign-head');
    }
    if (state === 'fail' && name === 'review-gate' && conclusion === 'failure') state = 'held';
    if (state === 'fail' && name === 'merge-gate' && conclusion === 'failure') {
      const candidates = [row.mergeGateReviewHold, row.mergeGateHoldExcused, ...(Array.isArray(holds) ? holds : [])];
      if (candidates.some(hold => evidenceJob(row) && evidenceInteger(hold?.jobId) === evidenceInteger(evidenceJob(row))
        && sha(hold?.headSha) === sha(head) && Array.isArray(hold?.holdIds) && hold.holdIds.length
        && humanReviewOnlyHold([...hold.holdIds].map(id => ({ id, status: 'hold' }))).only)) state = 'held';
    }
    return { row, name, state, reasons: why, rowHead, identity: evidenceIdentity(row), run: evidenceInteger(row?.run_id), attempt: evidenceInteger(row?.run_attempt) };
  });
  // A nameless row cannot safely be assigned to an advisory check.
  if (classified.some(r => typeof r.name !== 'string' || !r.name.trim())) reasons.push('malformed');
  const resolveName = name => {
    const all = classified.filter(r => r.name === name);
    const active = all.filter(r => !all.some(other => r.rowHead && r.rowHead === other.rowHead
      && r.run !== null && r.run === other.run && r.identity !== null && r.identity === other.identity
      && r.attempt !== null && other.attempt !== null
      && other.attempt > r.attempt && !r.reasons.includes('malformed') && !r.reasons.includes('foreign-head')));
    // Sorting is for display only. Only run_attempt orders rows of a proven identity.
    const key = r => JSON.stringify([String(r.run ?? ''), String(evidenceJob(r.row) ?? r.row.id ?? ''),
      Object.keys(r.row).sort().map(k => [k, r.row[k]])]);
    active.sort((a, b) => evidenceRank[b.state] - evidenceRank[a.state] || key(a).localeCompare(key(b)));
    return { state: active.length ? worstEvidence(active.map(r => r.state)) : 'pending',
      rows: active.map(r => r.row), rerunInFlight: active.some(r => r.state === 'pending' && r.attempt > 1n
        && !r.reasons.includes('needs-rerun') && !r.reasons.includes('foreign-head')),
      reasons: active.length ? [...new Set(active.flatMap(r => r.reasons))].sort() : ['missing'] };
  };
  for (const name of [...new Set(requiredNames)].sort()) perName[name] = resolveName(name);
  return { state: reasons.length ? 'unknown' : worstEvidence(Object.values(perName).map(r => r.state)), perName,
    reasons: [...new Set([...reasons, ...Object.values(perName).flatMap(r => r.reasons)])].sort() };
}
