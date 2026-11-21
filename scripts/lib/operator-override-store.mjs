/** Host-wide capacity override writer.
 * Audit is appended before atomic publication; a failed audit never changes the store.
 */
import { appendFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { withNumberingLock } from '../readiness/drain-lock.mjs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CAPACITY_LEAVES, operatorOverridesPath, validateKey, isEnumLeaf, validEnumValue } from './operator-override-reader.mjs';
import { readStrictStore, validateStrictStoreText } from './capacity-leaf.mjs';
import { enumOverridesPath, readEnumStore } from './operator-enum-store.mjs';
export * from './operator-override-reader.mjs';

const safe = s => String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
function validateAttribution({ reason, actor }) {
  for (const [key, value] of Object.entries({ reason, actor }))
    if (typeof value !== 'string' || !value.trim()) throw Error(`operator-override: ${key} must be non-empty`);
}
function publish({ file = operatorOverridesPath(), key, value, reason, actor,
  io = { appendFileSync, writeFileSync, renameSync }, lockWaitMs = 5000 }, clear) {
  validateKey(key);
  validateAttribution({ reason, actor });
  if (!clear && !CAPACITY_LEAVES[key].validate(value)) throw Error(`operator-override: invalid ${key}: type or value outside hard range`);
  if (!Number.isSafeInteger(lockWaitMs) || lockWaitMs < 0 || lockWaitMs > 5000)
    throw Error('operator-override: lockWaitMs must be an integer in 0..5000; retry with the default bounded wait');
  const locked = withNumberingLock(() => {
    const current = readStrictStore({ file });
    if (!current.ok && current.reason !== 'absent')
      throw Error(`operator-override: unreadable or invalid store (${current.reason}); repair it before writing`);
    const values = current.ok ? current.values : {};
    const before = { ...values };
    if (clear) delete values[key]; else values[key] = value;
    if (values['resourceGate.fixCap.ceiling'] < values['resourceGate.fixCap.floor'])
      values['resourceGate.fixCap.floor'] = values['resourceGate.fixCap.ceiling'];
    const candidate = JSON.stringify(values, null, 2) + '\n';
    const validated = validateStrictStoreText(candidate);
    if (!validated.ok) throw Error(`operator-override: invalid store (${validated.reason}); repair it before writing`);
    // One audit row per key whose stored value changed, plus the requested key, recording the value actually stored.
    const keys = [key, ...Object.keys({ ...before, ...values }).filter(k => k !== key && (before[k] ?? null) !== (values[k] ?? null))];
    const changes = keys.map(k => ({ key: k, old: before[k] ?? null, new: values[k] ?? null }));
    const requested = clear ? null : value;
    mkdirSync(dirname(file), { recursive: true });
    io.appendFileSync(join(dirname(file), 'operator-overrides.log.jsonl'), changes.map(change => JSON.stringify({
      ts: new Date().toISOString(), actor, osUser: userInfo().username, reason, ...change,
      ...(change.key === key && change.new !== requested ? { requested } : {}), source: 'operator-cli',
    }) + '\n').join(''), { mode: 0o600 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      io.writeFileSync(temporary, candidate, { mode: 0o600, flag: 'wx' });
      io.renameSync(temporary, file);
    } finally { try { unlinkSync(temporary); } catch { /* Rename consumes the temporary file. */ } }
    const effective = changes[0];
    return { key, old: effective.old, new: effective.new, ...(effective.new !== requested ? { requested } : {}),
      ...(changes.length > 1 ? { changes } : {}), source: 'operator-cli' };
  }, { lockRoot: `${file}.locks`, lockPath: '<operator-overrides:transaction>',
    waitMs: lockWaitMs, pollMs: 25, runUnlockedOnContention: false });
  if (!locked.ran) throw Error(`operator-override: store lock unavailable (${locked.reason}); retry after the other writer finishes; if persistent, ask the operator to inspect ${safe(file)}.locks`);
  return locked.result;
}
/** Enum keys go to their own file (same lock, audit log and atomic publish); the numeric store is never touched. */
function publishEnum({ file = operatorOverridesPath(), key, value, reason, actor, io = { appendFileSync, writeFileSync, renameSync }, lockWaitMs = 5000 }, clear) {
  validateAttribution({ reason, actor });
  if (!clear && !validEnumValue(key, value)) throw Error(`operator-override: invalid ${key}: value must be one of the declared enum values`);
  if (!Number.isSafeInteger(lockWaitMs) || lockWaitMs < 0 || lockWaitMs > 5000)
    throw Error('operator-override: lockWaitMs must be an integer in 0..5000; retry with the default bounded wait');
  const target = enumOverridesPath(file);
  const locked = withNumberingLock(() => {
    const current = readEnumStore({ file });
    if (!current.ok && current.reason !== 'absent')
      throw Error(`operator-override: unreadable or invalid enum store (${current.reason}); repair it before writing`);
    const values = current.ok ? { ...current.values } : {};
    const old = values[key] ?? null;
    if (clear) delete values[key]; else values[key] = value;
    mkdirSync(dirname(file), { recursive: true });
    io.appendFileSync(join(dirname(file), 'operator-overrides.log.jsonl'), JSON.stringify({
      ts: new Date().toISOString(), actor, osUser: userInfo().username, reason, key, old, new: clear ? null : value, source: 'operator-cli',
    }) + '\n', { mode: 0o600 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      io.writeFileSync(temporary, JSON.stringify(values, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      io.renameSync(temporary, target);
    } finally { try { unlinkSync(temporary); } catch { /* Rename consumes the temporary file. */ } }
    return { key, old, new: clear ? null : value, source: 'operator-cli' };
  }, { lockRoot: `${target}.locks`, lockPath: '<operator-enum-overrides:transaction>', waitMs: lockWaitMs, pollMs: 25, runUnlockedOnContention: false });
  if (!locked.ran) throw Error(`operator-override: enum store lock unavailable (${locked.reason}); retry after the other writer finishes`);
  return locked.result;
}
export function writeOperatorOverride(options) { return isEnumLeaf(options?.key) ? publishEnum(options, false) : publish(options, false); }
export function clearOperatorOverride(options) { return isEnumLeaf(options?.key) ? publishEnum(options, true) : publish(options, true); }
