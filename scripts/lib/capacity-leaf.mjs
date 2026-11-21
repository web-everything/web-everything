/** Strict whole-store capacity reads; invalid evidence always retains the lower layer. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { CAPACITY_LEAVES, OPERATOR_CAPACITY_MAX, operatorOverridesPath } from './operator-override-reader.mjs';
import { isUnderTest } from './under-test.mjs';
import { platformPreference } from './policy-cascade.mjs';

const ceilings = Object.freeze({ 'ciHeal.reserve': OPERATOR_CAPACITY_MAX.ciHealReserve, 'lanes.maxConcurrent': OPERATOR_CAPACITY_MAX.lanes });
const logged = new Map();
const refused = reason => ({ ok: false, reason });
const MAX_STORE_BYTES = 64 * 1024;

/** Validate the entire raw store before JSON parsing can erase duplicate keys. */
export function validateStrictStoreText(raw) {
  try {
    if (Buffer.byteLength(raw, 'utf8') > MAX_STORE_BYTES) return refused('too-large');
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return refused('invalid-json'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.values(parsed).some(value => typeof value !== 'number' || !Number.isFinite(value))) return refused('invalid-store');
    // Values are numbers, so every JSON string token is a key. Decode escapes before comparing.
    const matches = raw.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
    const unique = new Set(matches.map(match => JSON.parse(match)));
    if (matches.length !== unique.size || unique.size !== Object.keys(parsed).length) return refused('duplicate key');
    if (Object.entries(parsed).some(([k, value]) => !Object.hasOwn(CAPACITY_LEAVES, k) || !CAPACITY_LEAVES[k].validate(value))) return refused('invalid-key-or-value');
    return { ok: true, values: parsed };
  } catch { return refused('error'); }
}

/** Read bounded regular-file evidence; readFile is a trusted in-memory test seam. */
export function readStrictStore(options = {}) {
  try {
    const { file = operatorOverridesPath(), readFile } = options;
    let fd;
    try {
      if (readFile !== undefined) return validateStrictStoreText(readFile(file, 'utf8'));
      const stat = lstatSync(file);
      // Preserve the existing directory diagnostic while refusing all non-regular paths.
      if (!stat.isFile()) return refused(stat.isDirectory() ? 'unreadable' : 'not-regular-file');
      if (stat.size > MAX_STORE_BYTES) return refused('too-large');
      // A path swapped after lstat must neither follow a symlink nor block on a FIFO.
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = fstatSync(fd);
      if (!opened.isFile()) return refused('not-regular-file');
      if (opened.size > MAX_STORE_BYTES) return refused('too-large');
      const buffer = Buffer.alloc(MAX_STORE_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const count = readSync(fd, buffer, size, buffer.length - size, size);
        if (count === 0) break;
        size += count;
      }
      if (size > MAX_STORE_BYTES) return refused('too-large');
      return validateStrictStoreText(buffer.toString('utf8', 0, size));
    } catch (error) { return refused(error?.code === 'ENOENT' ? 'absent' : 'unreadable'); }
    finally { if (fd !== undefined) closeSync(fd); }
  } catch { return refused('error'); }
}

/** Read a flat, numeric, wholly valid override store. Never throws, including path and IO failures. */
export function readStrictOverride(key, options = {}) {
  try {
    const store = readStrictStore(options);
    if (!store.ok) return store;
    return Object.hasOwn(store.values, key) ? { ok: true, value: store.values[key] } : refused('not-set');
  } catch { return refused('error'); }
}

/** Retain the restrictive platform/lower bound, then apply a valid operator override. Never throws. */
export function resolveCapacityLeaf(key, options = {}) {
  let value = 0;
  try {
    if (!Object.hasOwn(ceilings, key)) return { value, source: 'lower', reason: 'unknown-key' };
    const ceiling = ceilings[key];
    value = Math.min(CAPACITY_LEAVES[key].failClosedFallback, ceiling);
    const { lower, env = process.env, log = line => console.error(line), ...io } = options;
    value = Math.min(Number.isInteger(lower) ? lower : value, ceiling);
    const [policy, leaf] = key.split('.');
    const block = platformPreference(policy, { env });
    const raw = block && typeof block === 'object' && !Array.isArray(block) ? block[leaf] : undefined;
    const platformCap = typeof raw === 'number' && Number.isFinite(raw) && CAPACITY_LEAVES[key].validate(Math.floor(raw))
      ? Math.floor(raw) : undefined;
    if (platformCap !== undefined) value = Math.min(value, platformCap);
    const ov = readStrictOverride(key, io);
    if (ov.ok) value = Math.min(ov.value, ceiling);
    const result = { value, source: ov.ok ? 'operator-db' : 'lower', reason: ov.ok ? 'ok' : ov.reason };
    try {
      const on = env.WE_POLICY_CASCADE_LOG;
      const inDaemon = !!console[Symbol.for('we.daemonLog.installed')] || /-daemon\.mjs$/.test(String(process.argv?.[1] ?? ''));
      if (on !== '0' && (on === '1' || (!isUnderTest(env) && inDaemon))) {
        const source = ov.ok ? 'operator-db' : `lower; no override: ${ov.reason}`;
        const platform = platformCap === undefined ? '' : ` · platform ${platformCap}`;
        const line = `capacity-leaf · ${key}=${value} (${source}) · lower ${lower}${platform} · ceiling ${ceiling}`;
        if (logged.get(key) !== line) { logged.set(key, line); log(line); }
      }
    } catch { /* Diagnostics never break resolution. */ }
    return result;
  } catch { return { value, source: 'lower', reason: 'error' }; }
}
