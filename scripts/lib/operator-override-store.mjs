/** Host-wide capacity overrides. Document: { "<policy>.<leaf>": value }.
 * Audit is appended before atomic publication; a failed audit never changes the store.
 */
import { readFileSync, appendFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { withNumberingLock } from '../readiness/drain-lock.mjs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const integer = (min, max) => v => Number.isInteger(v) && v >= min && v <= max;
export const CAPACITY_LEAVES = Object.freeze({
  'reviewConcurrency.maxLiveReviewRounds': integer(1, 8),
  'host.maxReviewDispatchPerTick': integer(1, 8),
  'resourceGate.fixCap.floor': integer(1, 12),
  'resourceGate.fixCap.ceiling': integer(1, 12),
  'resourceGate.fixCap.raiseMinMemFreePct': v => Number.isFinite(v) && v >= 25 && v <= 60,
  'redTeamQueue.minConcurrent': integer(0, 12),
  'heavyAdmission.remote.maxConcurrent': integer(1, 32),
});
const defaultFile = () => process.env.WE_OPERATOR_OVERRIDE_FILE ?? join(homedir(), '.claude', 'operator-overrides.json');
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
  for (const [key, value] of Object.entries(data)) {
    const known = Object.hasOwn(CAPACITY_LEAVES, key);
    if (!known || !CAPACITY_LEAVES[key](value)) {
      warn(log, `operator-override: ignored ${key} (${known ? 'invalid type or outside hard range' : 'guard leaves need the signed-attestation slice'}); using code value`);
    } else values[key] = value;
  }
  if (values['resourceGate.fixCap.ceiling'] < values['resourceGate.fixCap.floor']) {
    delete values['resourceGate.fixCap.floor']; delete values['resourceGate.fixCap.ceiling'];
    warn(log, 'operator-override: ignored resourceGate.fixCap floor/ceiling (ceiling below floor); using code value');
  }
  return { readable: true, values };
}
function publish({ file = defaultFile(), key, value, reason, actor,
  io = { appendFileSync, writeFileSync, renameSync }, lockWaitMs = 5000 }, clear) {
  validateKey(key);
  validateAttribution({ reason, actor });
  if (!clear && !CAPACITY_LEAVES[key](value)) throw Error(`operator-override: invalid ${key}: type or value outside hard range`);
  if (!Number.isSafeInteger(lockWaitMs) || lockWaitMs < 0 || lockWaitMs > 5000)
    throw Error('operator-override: lockWaitMs must be an integer in 0..5000; retry with the default bounded wait');
  const locked = withNumberingLock(() => {
    const current = readOperatorOverrides({ file });
    if (!current.readable) throw Error('operator-override: unreadable store; repair it before writing');
    const values = current.values;
    const old = values[key] ?? null;
    if (clear) delete values[key]; else values[key] = value;
    if (values['resourceGate.fixCap.ceiling'] < values['resourceGate.fixCap.floor'])
      throw Error('operator-override: resourceGate.fixCap.ceiling must be >= floor');
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
