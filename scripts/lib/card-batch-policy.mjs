/** Pure card-batch decisions; the platform JSON is the only IO. */
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url'; // bound at import: some suites stub the global URL
import { isCardPath } from '../ci-card-only.mjs';

export const CARD_BATCH_KINDS = Object.freeze(['prevention', 'filing', 'prepare']);
const KEYS = ['enabled', 'maxCards', 'maxAgeMinutes', 'highPriorityBypass'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = reason => { throw new TypeError(`card batch policy: ${reason}`); };

function checkKeys(value, allowed, path, partial = false) {
  if (!object(value)) fail(`${path} must be an object`);
  for (const key of Reflect.ownKeys(value)) {
    if (!allowed.includes(key)) fail(`${path}.${String(key)} is unknown`);
  }
  if (!partial) {
    for (const key of allowed) if (!Object.hasOwn(value, key)) fail(`${path}.${key} is missing`);
  }
}

function validateKind(value, path) {
  checkKeys(value, KEYS, path);
  for (const key of ['enabled', 'highPriorityBypass']) {
    if (typeof value[key] !== 'boolean') fail(`${path}.${key} must be boolean`);
  }
  for (const key of ['maxCards', 'maxAgeMinutes']) {
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0) fail(`${path}.${key} must be a positive safe integer`);
  }
  return Object.freeze({ ...value });
}

/** Validate a complete policy without repairing missing or invalid values. */
export function validateCardBatchPolicy(raw) {
  try {
    checkKeys(raw, CARD_BATCH_KINDS, 'policy');
    const policy = Object.fromEntries(CARD_BATCH_KINDS.map(kind => [kind, validateKind(raw[kind], kind)]));
    return { ok: true, policy: Object.freeze(policy) };
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return { ok: false, reason: error.message };
  }
}

const platformResult = validateCardBatchPolicy(JSON.parse(readFileSync(new NodeURL('./card-batch-policy.json', import.meta.url), 'utf8')));
if (!platformResult.ok) fail(platformResult.reason);
const defaults = platformResult.policy;

/** Project values extend platform defaults; explicit invalid values never fall back. */
export function loadCardBatchPolicy(raw = defaults) {
  checkKeys(raw, CARD_BATCH_KINDS, 'policy', true);
  const merged = { ...defaults };
  for (const kind of Object.keys(raw)) {
    checkKeys(raw[kind], KEYS, kind, true);
    merged[kind] = { ...defaults[kind], ...raw[kind] };
  }
  const result = validateCardBatchPolicy(merged);
  if (!result.ok) fail(result.reason);
  return result.policy;
}

function milliseconds(value, name) {
  // Require ISO dates/timestamps, excluding Date.parse's coercible numbers and prose dates.
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)
      ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) fail(`${name} must be finite milliseconds or an ISO string`);
  return parsed;
}

/** Count wins when both thresholds have been reached. Validate even when count seals. */
export function shouldSeal({ count, openedAt, now }, kindPolicy) {
  validateKind(kindPolicy, 'kindPolicy');
  if (!Number.isSafeInteger(count) || count < 0) fail('count must be a non-negative safe integer');
  const opened = milliseconds(openedAt, 'openedAt');
  const current = milliseconds(now, 'now');
  if (current < opened) fail('now must not precede openedAt');
  if (count >= kindPolicy.maxCards) return 'count';
  if (current - opened >= kindPolicy.maxAgeMinutes * 60000) return 'age';
  return null;
}

export function bypassesBatch({ priority }, kindPolicy) {
  return kindPolicy.highPriorityBypass === true && (priority === 'high' || priority === 'urgent');
}

/** Admit only newly added, top-level regular backlog cards with distinct textual IDs. */
export function cardOnlyEligibility(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false, reason: 'no changed-file rows' };
  const ids = new Set();
  for (const row of rows) {
    const path = row?.path;
    const refuse = reason => ({ ok: false, reason: `${String(path)}: ${reason}` });
    if (row?.status !== 'A') return refuse('status must be A');
    if (row?.mode !== '100644') return refuse('mode must be 100644');
    if (!isCardPath(path) || !/^backlog\/[^/]+\.md$/.test(path)) return refuse('not a top-level backlog card');
    const match = /^([^-]+)-.+\.md$/.exec(path.slice(path.indexOf('/') + 1));
    if (!match) return refuse('card basename must be <id>-<name>.md');
    if (ids.has(match[1])) return refuse(`duplicate card id ${match[1]}`);
    ids.add(match[1]);
  }
  return { ok: true };
}
