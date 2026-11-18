/** Pure thread-budget model. Sizes use binary G/M; times use epoch milliseconds.
 * Validators throw TypeError on incomplete/unknown evidence and return fresh objects.
 * Callers must correct rejected evidence rather than treating it as an admission grant.
 */
const G = 1024 ** 3;
const HALF_G = G / 2;
const DEFAULT_LIMITS = Object.freeze({ maxThreadsPerOp: 16, maxMemPerOp: 24 * G });
const EXPANDABLE = new Set(['full', 'FULL', 'soak', 'standards']);
const BACKENDS = new Set(['systemd-scope', 'soft', 'container']);
const SOURCES = new Set(['declared', 'history', 'kind-default', 'legacy']);
const defaults = (threads, memBytes, maxThreads = threads) => Object.freeze({ threads, maxThreads, memBytes });

// FULL is the existing admission spelling; full is the normalized spelling.
export const KIND_DEFAULTS = Object.freeze({
  files: defaults(1, 2 * G), standards: defaults(2, 4 * G, 16),
  full: defaults(8, 12 * G, 16), FULL: defaults(8, 12 * G, 16),
  soak: defaults(8, 12 * G, 16), other: defaults(1, 2 * G),
});

function fail(field) { throw new TypeError(`Invalid resource ${field}`); }
function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(field);
}
function shape(value, required, optional = []) {
  object(value, 'shape');
  if (required.some(k => !Object.hasOwn(value, k))
    || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) fail('shape');
}
function integer(value, field, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) fail(field);
  return value;
}
function text(value, field) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) fail(field);
}
function caps(limits = DEFAULT_LIMITS) {
  shape(limits, ['maxThreadsPerOp', 'maxMemPerOp']);
  integer(limits.maxThreadsPerOp, 'maxThreadsPerOp', 1);
  integer(limits.maxMemPerOp, 'maxMemPerOp', 1);
  return limits;
}
function identity(value) { text(value.kind, 'kind'); text(value.key, 'key'); }
const clamp = (value, cap) => Math.max(1, Math.min(value, cap));

export function validateRequest(req, limits = DEFAULT_LIMITS) {
  shape(req, ['v', 'kind', 'key', 'threads', 'memBytes', 'source'], ['maxThreads']);
  const cap = caps(limits);
  identity(req);
  if (req.v !== 1 || !SOURCES.has(req.source)) fail('version/source');
  integer(req.threads, 'threads', 1);
  integer(req.memBytes, 'memBytes', 1);
  if (Object.hasOwn(req, 'maxThreads')) {
    integer(req.maxThreads, 'maxThreads', 1);
    if (!EXPANDABLE.has(req.kind) || req.maxThreads < req.threads) fail('maxThreads');
  }
  return { ...req, threads: clamp(req.threads, cap.maxThreadsPerOp),
    memBytes: clamp(req.memBytes, cap.maxMemPerOp),
    ...(req.maxThreads === undefined ? {} : { maxThreads: clamp(req.maxThreads, cap.maxThreadsPerOp) }) };
}

/** Construct a request from an object; unspecified resources use the kind table. */
export function makeRequest(input, limits = DEFAULT_LIMITS) {
  shape(input, ['kind', 'key'], ['v', 'threads', 'maxThreads', 'memBytes', 'source']);
  const d = Object.hasOwn(KIND_DEFAULTS, input.kind) ? KIND_DEFAULTS[input.kind] : KIND_DEFAULTS.other;
  const threads = input.threads ?? d.threads;
  return validateRequest({ v: 1, threads, memBytes: d.memBytes,
    source: input.threads !== undefined || input.memBytes !== undefined ? 'declared' : 'kind-default',
    ...(EXPANDABLE.has(input.kind) ? { maxThreads: Math.max(threads, d.maxThreads) } : {}), ...input }, limits);
}

export function validateGrant(grant) {
  shape(grant, ['threads', 'memBytes', 'backend', 'enforced']);
  integer(grant.threads, 'threads', 1); integer(grant.memBytes, 'memBytes', 1);
  if (!BACKENDS.has(grant.backend) || typeof grant.enforced !== 'boolean'
    || (grant.backend === 'soft' && grant.enforced)) fail('backend/enforced');
  return { ...grant };
}

function timestamp(ts) {
  const ms = typeof ts === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(ts)
    ? Date.parse(ts) : ts;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) fail('timestamp');
  return ms;
}

export function validateUsageRow(row) {
  shape(row, ['ts', 'kind', 'key', 'threadsGranted', 'memGranted', 'cpuUsec', 'runMs',
    'memoryPeakBytes', 'throttledUsec', 'nrThrottled', 'oomKills', 'code', 'backend']);
  identity(row); timestamp(row.ts);
  for (const k of ['threadsGranted', 'memGranted', 'runMs']) integer(row[k], k, 1);
  for (const k of ['cpuUsec', 'memoryPeakBytes', 'throttledUsec', 'nrThrottled', 'oomKills']) integer(row[k], k);
  if (!Number.isSafeInteger(row.code) || !BACKENDS.has(row.backend)) fail('code/backend');
  return { ...row };
}

/** Compatibility conversion deliberately preserves the old quota, without new per-op caps. */
export function legacyRequestFromSlotUnits(u, { kind = 'other', key = 'legacy' } = {}) {
  integer(u, 'slotUnits', 1);
  if (u > 256) fail('slotUnits above the 256-slot ceiling');
  const request = { v: 1, kind, key, threads: u * 8, memBytes: u * 12 * G, source: 'legacy' };
  return validateRequest(request, { maxThreadsPerOp: Number.MAX_SAFE_INTEGER, maxMemPerOp: Number.MAX_SAFE_INTEGER });
}

// Nearest-rank percentiles keep the estimator deterministic for short histories.
function percentile(values, p) {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
}
function memory(value) {
  if (typeof value === 'string') {
    const match = /^(\d+(?:\.\d+)?)([GM])$/.exec(value);
    if (!match) fail('override mem');
    value = Number(match[1]) * (match[2] === 'G' ? G : 1024 ** 2);
  }
  return integer(value, 'override mem', 1);
}

/** now must be injected. Unknown kinds use other, or slotUnits when explicitly supplied.
 * Malformed history is rejected (including unmeasured/null counters), never silently used.
 */
export function estimateRequest({ kind, key, rows = [], now, selectedFileCount,
  limits = DEFAULT_LIMITS, overrides = {}, slotUnits } = {}) {
  const cap = caps(limits);
  identity({ kind, key });
  const at = timestamp(now);
  if (!Array.isArray(rows)) fail('rows');
  shape(overrides, [], ['threads', 'mem']);
  if (selectedFileCount !== undefined) integer(selectedFileCount, 'selectedFileCount', 1);
  const history = rows.map(validateUsageRow)
    .filter(r => r.kind === kind && r.key === key && timestamp(r.ts) <= at
      && timestamp(r.ts) >= at - 14 * 86400000)
    .sort((a, b) => timestamp(a.ts) - timestamp(b.ts)).slice(-20);
  let req;
  if (history.length < 3) {
    req = !Object.hasOwn(KIND_DEFAULTS, kind) && slotUnits !== undefined
      ? validateRequest(legacyRequestFromSlotUnits(slotUnits, { kind, key }), cap)
      : makeRequest({ kind, key }, cap);
  } else {
    const recent = history.slice(-5);
    const mean = percentile(history.map(r => r.cpuUsec / (r.runMs * 1000)), 0.9);
    // The binding single-thread acceptance case takes precedence over ceil(1 * 1.2).
    let threads = mean <= 1 ? 1 : Math.ceil(mean * 1.2);
    if (recent.filter(r => r.throttledUsec / (r.runMs * 1000) > 0.2).length >= 3)
      threads = Math.ceil(1.5 * history.at(-1).threadsGranted);
    let memBytes = Math.max(G, Math.ceil(percentile(history.map(r => r.memoryPeakBytes), 0.95) * 1.3 / HALF_G) * HALF_G);
    if (recent.some(r => r.oomKills > 0)) memBytes *= 2;
    req = makeRequest({ kind, key, threads: clamp(threads, cap.maxThreadsPerOp),
      memBytes: clamp(memBytes, cap.maxMemPerOp), source: 'history' }, cap);
  }
  if (Object.hasOwn(overrides, 'threads')) {
    const value = typeof overrides.threads === 'string' && /^\d+$/.test(overrides.threads)
      ? Number(overrides.threads) : overrides.threads;
    req.threads = clamp(integer(value, 'override threads', 1), cap.maxThreadsPerOp);
    req.source = 'declared';
  }
  if (Object.hasOwn(overrides, 'mem')) { req.memBytes = clamp(memory(overrides.mem), cap.maxMemPerOp); req.source = 'declared'; }
  if (kind === 'files' && selectedFileCount !== undefined) req.threads = Math.min(req.threads, selectedFileCount);
  if (req.maxThreads !== undefined) req.maxThreads = Math.max(req.threads, req.maxThreads);
  return validateRequest(req, cap);
}
