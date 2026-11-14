/** Host-wide capacity override writer.
 * Audit is appended before atomic publication; a failed audit never changes the store.
 */
import { appendFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { withNumberingLock } from '../readiness/drain-lock.mjs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CAPACITY_LEAVES, readOperatorOverrides, operatorOverridesPath, validateKey } from './operator-override-reader.mjs';
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
    const current = readOperatorOverrides({ file, normalize: false });
    if (!current.readable || current.invalidPolicies?.length) throw Error('operator-override: unreadable or invalid store; repair it before writing');
    const values = current.values;
    const before = { ...values };
    if (clear) delete values[key]; else values[key] = value;
    if (values['resourceGate.fixCap.ceiling'] < values['resourceGate.fixCap.floor'])
      values['resourceGate.fixCap.floor'] = values['resourceGate.fixCap.ceiling'];
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
      io.writeFileSync(temporary, JSON.stringify(values, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
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
export function writeOperatorOverride(options) { return publish(options, false); }
export function clearOperatorOverride(options) { return publish(options, true); }
