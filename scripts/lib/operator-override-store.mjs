/** Host-wide capacity overrides. Document: { "<policy>.<leaf>": value }.
 * Audit is appended before atomic publication; a failed audit never changes the store.
 */
import { readFileSync, appendFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { withNumberingLock } from '../readiness/drain-lock.mjs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const integer = (min, max) => v => Number.isInteger(v) && v >= min && v <= max;
const capacityLeaf = (validate, direction, failClosedFallback) => Object.freeze({ validate, direction, failClosedFallback });
export const CAPACITY_LEAVES = Object.freeze({
  'reviewConcurrency.maxLiveReviewRounds': capacityLeaf(integer(1, 8), 'cap', 3),
  'host.maxReviewDispatchPerTick': capacityLeaf(integer(1, 8), 'cap', 2),
  'resourceGate.fixCap.floor': capacityLeaf(integer(1, 12), 'cap', 2),
  'resourceGate.fixCap.ceiling': capacityLeaf(integer(1, 12), 'cap', 6),
  'resourceGate.fixCap.raiseMinMemFreePct': capacityLeaf(v => Number.isFinite(v) && v >= 25 && v <= 60, 'threshold', 40),
  'redTeamQueue.minConcurrent': capacityLeaf(integer(0, 12), 'cap', 0),
});
/** Resolve unreadable operator evidence without relaxing a configured bound. */
export function failClosedCapacity(key, value, { codeDefault, log = console.error } = {}) {
  const { direction, failClosedFallback } = CAPACITY_LEAVES[key];
  const stricter = direction === 'cap' ? Math.min : Math.max;
  const fallback = Number.isFinite(codeDefault) ? stricter(codeDefault, failClosedFallback) : failClosedFallback;
  const result = Number.isFinite(value) ? stricter(value, fallback) : fallback;
  warn(log, `operator-override: operator-db-unreadable ${key}; using finite stricter value ${result}`);
  return result;
}
const defaultFile = () => join(homedir(), '.claude', 'operator-overrides.json');
const safe = s => String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
function warn(log, message) { try { log(safe(message)); } catch { /* Diagnostics never break reads. */ } }
function validateKey(key) {
  if (!Object.hasOwn(CAPACITY_LEAVES, key)) throw Error(`operator-override: refused ${key}; guard leaves need the signed-attestation slice`);
}
function validateAttribution({ reason, actor }) {
  for (const [key, value] of Object.entries({ reason, actor }))
    if (typeof value !== 'string' || !value.trim()) throw Error(`operator-override: ${key} must be non-empty`);
}
export function readOperatorOverrides({ file = defaultFile(), log = console.error } = {}) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('not a JSON object');
  } catch (error) {
    if (error?.code === 'ENOENT') return { readable: true, values: {} };
    warn(log, `operator-override: operator-db-unreadable store (${error.message}); using code value`);
    return { readable: false, values: {} };
  }
  const values = {};
  const invalidPolicies = new Set();
  for (const [key, value] of Object.entries(data)) {
    const known = Object.hasOwn(CAPACITY_LEAVES, key);
    if (!known || !CAPACITY_LEAVES[key].validate(value)) {
      const policy = key.split('.')[0];
      invalidPolicies.add(policy);
      warn(log, `operator-override: operator-db-invalid ${key} (${known ? 'invalid type or outside hard range' : 'guard leaves need the signed-attestation slice'}); repair the store before using this policy`);
    } else values[key] = value;
  }
  for (const key of Object.keys(values)) {
    if (invalidPolicies.has('*') || invalidPolicies.has(key.split('.')[0])) delete values[key];
  }
  if (values['resourceGate.fixCap.ceiling'] < values['resourceGate.fixCap.floor']) {
    values['resourceGate.fixCap.floor'] = values['resourceGate.fixCap.ceiling'];
  }
  return { readable: true, values, ...(invalidPolicies.size ? { invalidPolicies: [...invalidPolicies] } : {}) };
}
function publish({ file = defaultFile(), key, value, reason, actor,
  io = { appendFileSync, writeFileSync, renameSync }, lockWaitMs = 5000 }, clear) {
  validateKey(key);
  validateAttribution({ reason, actor });
  if (!clear && !CAPACITY_LEAVES[key].validate(value)) throw Error(`operator-override: invalid ${key}: type or value outside hard range`);
  if (!Number.isSafeInteger(lockWaitMs) || lockWaitMs < 0 || lockWaitMs > 5000)
    throw Error('operator-override: lockWaitMs must be an integer in 0..5000; retry with the default bounded wait');
  const locked = withNumberingLock(() => {
    const current = readOperatorOverrides({ file });
    if (!current.readable || current.invalidPolicies?.length) throw Error('operator-override: unreadable or invalid store; repair it before writing');
    const values = current.values;
    const old = values[key] ?? null;
    if (clear) delete values[key]; else values[key] = value;
    if (values['resourceGate.fixCap.ceiling'] < values['resourceGate.fixCap.floor'])
      values['resourceGate.fixCap.floor'] = values['resourceGate.fixCap.ceiling'];
    mkdirSync(dirname(file), { recursive: true });
    io.appendFileSync(join(dirname(file), 'operator-overrides.log.jsonl'), JSON.stringify({
      ts: new Date().toISOString(), actor, osUser: userInfo().username, reason, key, old, new: clear ? null : value, source: 'operator-cli',
    }) + '\n', { mode: 0o600 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      io.writeFileSync(temporary, JSON.stringify(values, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      io.renameSync(temporary, file);
    } finally { try { unlinkSync(temporary); } catch { /* Rename consumes the temporary file. */ } }
    return { key, old, new: clear ? null : value, source: 'operator-cli' };
  }, { lockRoot: `${file}.locks`, lockPath: '<operator-overrides:transaction>',
    waitMs: lockWaitMs, pollMs: 25, runUnlockedOnContention: false });
  if (!locked.ran) throw Error(`operator-override: store lock unavailable (${locked.reason}); retry after the other writer finishes; if persistent, ask the operator to inspect ${safe(file)}.locks`);
  return locked.result;
}
export function writeOperatorOverride(options) { return publish(options, false); }
export function clearOperatorOverride(options) { return publish(options, true); }
