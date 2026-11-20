/** Strict whole-store capacity reads; invalid evidence always retains the lower layer. */
import { readFileSync } from 'node:fs';
import { CAPACITY_LEAVES, OPERATOR_CAPACITY_MAX, operatorOverridesPath } from './operator-override-reader.mjs';
import { isUnderTest } from './under-test.mjs';

const ceilings = Object.freeze({ 'ciHeal.reserve': OPERATOR_CAPACITY_MAX.ciHealReserve, 'lanes.maxConcurrent': OPERATOR_CAPACITY_MAX.lanes });
const logged = new Map();
const refused = reason => ({ ok: false, reason });

/** Read a flat, numeric, wholly valid override store. Never throws, including path and IO failures. */
export function readStrictOverride(key, options = {}) {
  try {
    const { file = operatorOverridesPath(), readFile = readFileSync } = options;
    let raw;
    try { raw = readFile(file, 'utf8'); }
    catch (error) { return refused(error?.code === 'ENOENT' ? 'absent' : 'unreadable'); }
    if (Buffer.byteLength(raw, 'utf8') > 64 * 1024) return refused('too-large');
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return refused('invalid-json'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.values(parsed).some(value => typeof value !== 'number' || !Number.isFinite(value))) return refused('invalid-store');
    // Values are numbers, so every JSON string token is a key. Decode escapes before comparing.
    const matches = raw.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
    const unique = new Set(matches.map(match => JSON.parse(match)));
    if (matches.length !== unique.size || unique.size !== Object.keys(parsed).length) return refused('duplicate key');
    if (Object.entries(parsed).some(([k, value]) => !Object.hasOwn(CAPACITY_LEAVES, k) || !CAPACITY_LEAVES[k].validate(value))) return refused('invalid-key-or-value');
    return Object.hasOwn(parsed, key) ? { ok: true, value: parsed[key] } : refused('not-set');
  } catch { return refused('error'); }
}

/** Resolve one bounded leaf and log its provenance once per change. Never throws. */
export function resolveCapacityLeaf(key, options = {}) {
  let value = 0;
  try {
    if (!Object.hasOwn(ceilings, key)) return { value, source: 'lower', reason: 'unknown-key' };
    const ceiling = ceilings[key];
    value = Math.min(CAPACITY_LEAVES[key].failClosedFallback, ceiling);
    const { lower, log = line => console.error(line), ...io } = options;
    const ov = readStrictOverride(key, io);
    value = Math.min(ov.ok ? ov.value : Number.isInteger(lower) ? lower : value, ceiling);
    const result = { value, source: ov.ok ? 'operator-db' : 'lower', reason: ov.ok ? 'ok' : ov.reason };
    try {
      const on = process.env.WE_POLICY_CASCADE_LOG;
      const inDaemon = !!console[Symbol.for('we.daemonLog.installed')] || /-daemon\.mjs$/.test(String(process.argv?.[1] ?? ''));
      if (on !== '0' && (on === '1' || (!isUnderTest() && inDaemon))) {
        const source = ov.ok ? 'operator-db' : `lower; no override: ${ov.reason}`;
        const line = `capacity-leaf · ${key}=${value} (${source}) · lower ${lower} · ceiling ${ceiling}`;
        if (logged.get(key) !== line) { logged.set(key, line); log(line); }
      }
    } catch { /* Diagnostics never break resolution. */ }
    return result;
  } catch { return { value, source: 'lower', reason: 'error' }; }
}
