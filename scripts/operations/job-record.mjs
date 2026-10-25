/**
 * @file scripts/operations/job-record.mjs
 * @description THE JOB BLOCK of a run record — the pure shape of one daemon job (#4125, statute
 *   `#daemon-jobs`, decision 4120 Fork 1 (a): "a job is a run-store record kind").
 *
 * A job is an ordinary run record ({@link ./run-record.mjs}) whose `op` is `job:<kind>` and which carries one
 * extra block, `job`, holding what a daemon needs to find, judge and relaunch a detached child:
 *
 *   `{ kind, codeMode, status, handle, host, pid, procStart, startedAt, heartbeatAt, finishedAt, checkpoint,
 *      codeSha, snapshotKeys, attempts, maxAttempts, nextAttemptAt, error, timeline }`
 *
 * The run record's own `id` and `input` are the job's id and input — never duplicated here.
 *
 * THE HANDLE is `host:pid:procStart` and nothing less (statute: "a bare pid is never a handle"). `procStart`
 * is the process start time as `ps -o lstart=` prints it (whitespace collapsed), so a pid the kernel reused for
 * another process never reads as our job. Host names carry no `:`, a pid is digits, so the handle splits on
 * its first two colons and `procStart` keeps whatever colons its clock text has.
 *
 * PURE. No fs, no clock, no process, no randomness — the same line `run-record.mjs` holds, and the engine
 * purity test walks this file too because `run-record.mjs` imports it.
 */

export const TASK_OUTCOMES = Object.freeze(['acted', 'nothing-owed', 'superseded', 'deferred-claim-held', 'deferred-read', 'failed']);
export const DEFAULT_TASK_TIMEOUT_MS = 300000;
export const DEFAULT_ACTING_REPO_CAP = 1;
const SOURCE_LAYERS = ['standard', 'platform', 'tool', 'env'];
const positiveInteger = v => Number.isSafeInteger(v) && v > 0;
const positiveFinite = v => Number.isFinite(v) && v > 0;

/** Logical identity stays separate from the run store's safe storage ID. */
export function validateTaskIdentity(task) {
  if (!isPlainObject(task)) return ['job.task must be an object'];
  const errors = [];
  if (!isValidJobKind(task.kind) || /\s/.test(task.kind)) errors.push('job.task.kind must be a valid kind');
  if (typeof task.repo !== 'string' || /\s/.test(task.repo) || !/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9._-]{0,99}$/.test(task.repo)) errors.push('job.task.repo must be a canonical owner/repo slug');
  for (const key of ['item', 'seq']) if (!positiveInteger(task[key])) errors.push(`job.task.${key} must be a positive safe integer`);
  if (typeof task.id !== 'string' || task.id !== `${task.kind}:${task.repo}:${task.item}:${task.seq}`) errors.push('job.task.id must equal kind:repo:item:seq');
  return errors;
}

/** Validate a pure resolveCascade result, refusing ignored overrides as well as invalid final values.
 * Callers supply the cascade observation; this module never reads settings or logs. A refusal requires
 * correcting the named policy/source before rescheduling, never silently falling back.
 */
export function validateTaskPolicy(resolved = {
  value: { timeoutMs: DEFAULT_TASK_TIMEOUT_MS }, sources: { timeoutMs: 'standard' }, invalid: [],
}) {
  const { value, sources, invalid } = resolved ?? {};
  const refuse = reason => { throw new TypeError(`task policy refused: ${reason}; correct policy before rescheduling`); };
  if (!Array.isArray(invalid) || invalid.length) refuse(`invalid overrides ${JSON.stringify(invalid)}`);
  if (!isPlainObject(value) || !positiveFinite(value.timeoutMs)) refuse('timeoutMs must be finite and positive');
  if (!isPlainObject(sources)) refuse('source layers are required');
  const leaves = [];
  const visit = (object, prefix = '') => {
    for (const [key, v] of Object.entries(object)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (isPlainObject(v)) visit(v, path);
      else leaves.push(path);
    }
  };
  visit(value);
  if (leaves.some(key => !SOURCE_LAYERS.includes(sources[key])) || Object.keys(sources).some(key => !leaves.includes(key))) refuse('every policy leaf needs a known source layer');
  return { policy: { ...value }, sources: { ...sources } };
}

/** Optional task block: opt-in validation leaves old job records byte-for-byte alone. */
export function validateTaskMetadata(task) {
  const errors = validateTaskIdentity(task);
  if (!isPlainObject(task)) return errors;
  if (!positiveFinite(task.timeoutMs)) errors.push('job.task.timeoutMs must be finite and positive');
  try { validateTaskPolicy({ value: task.policy, sources: task.sources, invalid: [] }); }
  catch (error) { errors.push(`job.task ${error.message}`); }
  if (task.policy?.timeoutMs !== task.timeoutMs) errors.push('job.task.timeoutMs must match persisted policy');
  if (typeof task.acting !== 'boolean') errors.push('job.task.acting must be boolean');
  if (Object.hasOwn(task, 'actingRepoCap') && !positiveInteger(task.actingRepoCap)) errors.push('job.task.actingRepoCap must be a positive safe integer');
  // Structural identifier only: the daemon policy checks the shared resource registry before admission.
  if (!isValidJobKind(task.resourceKind) || /\s/.test(task.resourceKind)) errors.push('job.task.resourceKind must be a valid kind');
  if (!Number.isSafeInteger(task.failureCount) || task.failureCount < 0) errors.push('job.task.failureCount must be a non-negative safe integer');
  if (task.outcome !== null && !TASK_OUTCOMES.includes(task.outcome)) errors.push('job.task.outcome must be null or a semantic outcome');
  if (task.resultRef !== null && (typeof task.resultRef !== 'string' || task.resultRef.length > 256 ||
    /\s/.test(task.resultRef) || !/^results\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(task.resultRef))) errors.push('job.task.resultRef must be null or a relative results JSON reference');
  return errors;
}

/** A job's lifecycle. `launching` = the daemon spawned it but the child has not claimed the record yet. */
export const JOB_STATUSES = Object.freeze(['queued', 'launching', 'running', 'succeeded', 'failed']);

/** Terminal statuses — nothing reattaches, launches or kills a job in one of these. */
export const TERMINAL_JOB_STATUSES = Object.freeze(['succeeded', 'failed']);

/**
 * Where a job's code comes from (statute, Fork 2 (c)). `readonly-tree` runs from a pinned code snapshot;
 * `mutates-tree` runs in its own working tree of `main`, never the daemon clone.
 */
export const JOB_CODE_MODES = Object.freeze(['readonly-tree', 'mutates-tree']);

/** Default cap on launches of one job — the statute's "up to 3 attempts with backoff, then fail visibly". */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** The run-record `op` prefix that marks a record as a job. */
export const JOB_OP_PREFIX = 'job:';

const KIND_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HOST_RE = /^[^\s:]+$/;

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isIsoOrNull(v) {
  return v === null || (typeof v === 'string' && !Number.isNaN(Date.parse(v)));
}

/** Is `kind` a usable job kind name (lowercase, dashes, digits)? */
export function isValidJobKind(kind) {
  return typeof kind === 'string' && KIND_RE.test(kind);
}

/** `ps -o lstart=` text with its whitespace runs collapsed — the one comparable form of a start time. */
export function normalizeProcStart(text) {
  return typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';
}

/**
 * Build a handle. Refuses anything short of all three parts — a handle without a start time would let pid
 * reuse pass as liveness, which is the exact defect the statute names.
 * @param {{host: string, pid: number, procStart: string}} o
 * @returns {string}
 */
export function formatJobHandle({ host, pid, procStart } = {}) {
  const start = normalizeProcStart(procStart);
  if (typeof host !== 'string' || !HOST_RE.test(host)) throw new TypeError(`daemon-jobs: invalid handle host ${JSON.stringify(host)}`);
  if (!Number.isInteger(pid) || pid <= 0) throw new TypeError(`daemon-jobs: invalid handle pid ${JSON.stringify(pid)}`);
  if (!start) throw new TypeError('daemon-jobs: a handle needs the process start time — a bare pid is never a handle');
  return `${host}:${pid}:${start}`;
}

/**
 * Parse a handle. Returns `null` for anything that is not a full `host:pid:procStart`.
 * @param {string} handle
 * @returns {{host: string, pid: number, procStart: string}|null}
 */
export function parseJobHandle(handle) {
  if (typeof handle !== 'string') return null;
  const a = handle.indexOf(':');
  if (a <= 0) return null;
  const b = handle.indexOf(':', a + 1);
  if (b < 0) return null;
  const host = handle.slice(0, a);
  const pidText = handle.slice(a + 1, b);
  const procStart = normalizeProcStart(handle.slice(b + 1));
  if (!HOST_RE.test(host) || !/^[1-9][0-9]*$/.test(pidText) || !procStart) return null;
  return { host, pid: Number(pidText), procStart };
}

/**
 * The job block of a fresh, queued job. The run record around it comes from `newRunRecord` — use
 * {@link newJobRunRecord} to get both at once.
 * @param {{kind: string, codeMode?: string, maxAttempts?: number, codeSha?: string|null}} o
 */
export function newJobBlock({ kind, codeMode = 'readonly-tree', maxAttempts = DEFAULT_MAX_ATTEMPTS, codeSha = null } = {}) {
  if (!isValidJobKind(kind)) throw new TypeError(`daemon-jobs: invalid job kind ${JSON.stringify(kind)}`);
  if (!JOB_CODE_MODES.includes(codeMode)) throw new TypeError(`daemon-jobs: codeMode must be one of ${JOB_CODE_MODES.join('|')}`);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('daemon-jobs: maxAttempts must be a positive integer');
  return {
    kind,
    codeMode,
    status: 'queued',
    handle: null,
    host: null,
    pid: null,
    procStart: null,
    launchedAt: null,
    startedAt: null,
    heartbeatAt: null,
    finishedAt: null,
    checkpoint: { step: 0, data: {} },
    codeSha,
    snapshotKeys: [],
    attempts: 0,
    maxAttempts,
    nextAttemptAt: null,
    error: null,
    timeline: [],
  };
}

/** Is this run record a job record? */
export function isJobRecord(record) {
  return isPlainObject(record) && typeof record.op === 'string' && record.op.startsWith(JOB_OP_PREFIX) && isPlainObject(record.job);
}

/** Append one timeline event. PURE — `at` is the caller's clock reading. */
export function withTimelineEvent(job, { at, event, ...detail }) {
  const row = { at, event };
  for (const [k, v] of Object.entries(detail)) if (v !== undefined) row[k] = v;
  return { ...job, timeline: [...(job.timeline || []), row] };
}

/**
 * Structural validation of a `job` block. Called by `validateRunRecord` when a record carries one.
 * @param {*} job
 * @returns {string[]} errors (empty = valid)
 */
export function validateJobBlock(job) {
  const errors = [];
  if (!isPlainObject(job)) return ['`job` must be an object'];
  if (!isValidJobKind(job.kind)) errors.push(`job.kind ${JSON.stringify(job.kind)} is not a valid kind`);
  if (!JOB_CODE_MODES.includes(job.codeMode)) errors.push(`job.codeMode must be one of ${JOB_CODE_MODES.join('|')}`);
  if (!JOB_STATUSES.includes(job.status)) errors.push(`job.status ${JSON.stringify(job.status)} is not one of ${JOB_STATUSES.join('|')}`);
  if (job.handle !== null && !parseJobHandle(job.handle)) {
    errors.push(`job.handle ${JSON.stringify(job.handle)} is not host:pid:procStart`);
  }
  if (job.status === 'running' && job.handle === null) errors.push('a running job must carry its handle');
  for (const k of ['launchedAt', 'startedAt', 'heartbeatAt', 'finishedAt', 'nextAttemptAt']) {
    if (!isIsoOrNull(job[k] ?? null)) errors.push(`job.${k} must be an ISO date or null`);
  }
  if (!isPlainObject(job.checkpoint) || !Number.isInteger(job.checkpoint.step) || job.checkpoint.step < 0 || !isPlainObject(job.checkpoint.data)) {
    errors.push('job.checkpoint must be { step: non-negative integer, data: object }');
  }
  if (!(job.codeSha === null || (typeof job.codeSha === 'string' && job.codeSha))) errors.push('job.codeSha must be a string or null');
  if (!Array.isArray(job.snapshotKeys) || job.snapshotKeys.some((k) => typeof k !== 'string')) errors.push('job.snapshotKeys must be a string array');
  if (!Number.isInteger(job.attempts) || job.attempts < 0) errors.push('job.attempts must be a non-negative integer');
  if (!Number.isInteger(job.maxAttempts) || job.maxAttempts < 1) errors.push('job.maxAttempts must be a positive integer');
  if (!(job.error === null || typeof job.error === 'string')) errors.push('job.error must be a string or null');
  if (!Array.isArray(job.timeline) || job.timeline.some((e) => !isPlainObject(e) || typeof e.event !== 'string' || !isIsoOrNull(e.at))) {
    errors.push('job.timeline must be an array of { at, event } rows');
  }
  if (Object.hasOwn(job, 'task')) {
    errors.push(...validateTaskMetadata(job.task));
    if (isPlainObject(job.task) && job.task.kind !== job.kind) errors.push('job.task.kind must match job.kind');
  }
  return errors;
}
