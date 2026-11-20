/** Lock-free host capacity override reads; only Node builtins belong in this graph. */
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';

// A stored expiry beyond the cap is refused at write time and read time, so the generic setter cannot bypass 72h.
const epochMs = v => Number.isSafeInteger(v) && v > 0 && v <= Date.now() + 72 * 3600000;
const number = (min, max) => v => Number.isFinite(v) && v >= min && v <= max;
const integer = (min, max) => v => Number.isInteger(v) && v >= min && v <= max;
// Instant settings share the stricter built-in/lower-layer fallback on invalid operator evidence.
const instant = (min, max, fallback, direction = 'cap', validate = integer) =>
  capacityLeaf(validate(min, max), direction, fallback);
const capacityLeaf = (validate, direction, failClosedFallback) => Object.freeze({ validate, direction, failClosedFallback });
// R1040/R1045: pure capacity raises are accepted up to these hard bounds; lowering stays allowed.
// These are operator limits, not defaults or fail-closed fallbacks, and grant no guard-leaf authority.
export const OPERATOR_CAPACITY_MAX = Object.freeze({ fix: 24, review: 16, redTeam: 24 });
export const CAPACITY_LEAVES = Object.freeze({
  'ciHeal.reserve': instant(0, 24, 6),
  'lanes.maxConcurrent': instant(1, 48, 12),
  'resourceGate.fixCap.raiseQueueOver': instant(0, 100, 5, 'threshold'),
  'resourceGate.fixCap.raiseStepPerPass': instant(1, 24, 2),
  'resourceGate.fixCap.raiseMaxSwapUsedPct': instant(0, 100, 60, 'cap', number),
  'resourceGate.fixCap.raiseMaxHeavyWaitMinutes': instant(0, 120, 15, 'cap', number),
  'redTeam.queue.cap': instant(0, 24, 12),
  'redTeam.queue.minConcurrentIdlePct': instant(0, 100, 10, 'threshold'),
  'redTeam.queue.reviewStartsPerTickWhileIdle': instant(0, 24, 0),
  'heavyAdmission.cap': instant(1, 32, 2),
  'heavyAdmission.fastSlots': instant(0, 16, 1),
  'deliveryCapacity.openPrCap': instant(1, 200, 18),
  'deliveryCapacity.maxStartsPerCheck': instant(0, 48, 8),
  'deliveryCapacity.softOverCapStarts': instant(0, 24, 2),
  'reviewSeats.codex': instant(0, 10000, 80),
  'reviewSeats.agy-claude': instant(0, 10000, 300),
  'reviewSeats.agy-gemini': instant(0, 10000, 0),
  'reviewSeats.extraSeatsDailyCap': instant(0, 10000, 40),
  'forgeSlots.forge': instant(1, 128, 14),
  'forgeSlots.forge-b': instant(1, 128, 8),
  'ghThrottle.cap': instant(1, 50, 6),
  'ghThrottle.perCallerMax': instant(1, 50, 4),
  'fixDispatchMaxConcurrent': instant(1, 16, 6),

  'reviewConcurrency.maxLiveReviewRounds': capacityLeaf(integer(1, OPERATOR_CAPACITY_MAX.review), 'cap', 3),
  'host.maxReviewDispatchPerTick': capacityLeaf(integer(1, OPERATOR_CAPACITY_MAX.review), 'cap', 2),
  'fix.conflictFixesPerPass': capacityLeaf(integer(0, OPERATOR_CAPACITY_MAX.fix), 'cap', 1),
  'fix.conflictFixExemptPerPass': capacityLeaf(integer(0, 10), 'cap', 1), // existing exemption operational maximum
  'resourceGate.fixCap.floor': capacityLeaf(integer(1, OPERATOR_CAPACITY_MAX.fix), 'cap', 2),
  'resourceGate.fixCap.ceiling': capacityLeaf(integer(1, OPERATOR_CAPACITY_MAX.fix), 'cap', 6),
  'resourceGate.fixCap.raiseMinMemFreePct': capacityLeaf(v => Number.isFinite(v) && v >= 25 && v <= 60, 'threshold', 40),
  'redTeamQueue.minConcurrent': capacityLeaf(integer(0, OPERATOR_CAPACITY_MAX.redTeam), 'cap', 0),
  'deliveryCapacity.pinUnits': capacityLeaf(integer(1, 200), 'cap', 1),
  'deliveryCapacity.pinUntil': capacityLeaf(epochMs, 'cap', 0),
  'deliveryCapacity.holdUntil': capacityLeaf(epochMs, 'threshold', Number.MAX_SAFE_INTEGER),
});
/** Every expiring override is capped at this many hours so a forgotten pin or hold dies. */
export const OVERRIDE_MAX_HOURS = 72;
/** Newest audited reason for a key, for readouts (bounded tail read; never throws). */
export function lastOverrideReason(key, { file } = {}) {
  try {
    const log = join(dirname(file ?? operatorOverridesPath()), 'operator-overrides.log.jsonl');
    const lines = readFileSync(log, 'utf8').slice(-65536).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const row = JSON.parse(lines[i]); if (row.key === key && row.new !== null) return safe(row.reason).slice(0, 120); } catch { /* partial line */ }
    }
  } catch { /* no audit log */ }
  return undefined;
}
/** Resolve invalid or unreadable operator evidence without relaxing a configured bound. */
export function failClosedCapacity(key, value, { codeDefault, log = console.error, reason = 'unreadable' } = {}) {
  const { direction, failClosedFallback } = CAPACITY_LEAVES[key];
  const stricter = direction === 'cap' ? Math.min : Math.max;
  const fallback = Number.isFinite(codeDefault) ? stricter(codeDefault, failClosedFallback) : failClosedFallback;
  const result = Number.isFinite(value) ? stricter(value, fallback) : fallback;
  warn(log, `operator-override: operator-db-${reason} ${key}; using finite stricter value ${result}`);
  return result;
}
export const OPERATOR_OVERRIDES_RELATIVE_PATH = '.claude/operator-overrides.json';
// userInfo().homedir comes from the account database, not $HOME, so a launcher cannot redirect the host-wide store.
export const operatorOverridesPath = () => join(userInfo().homedir, OPERATOR_OVERRIDES_RELATIVE_PATH);
const safe = s => String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
function warn(log, message) { try { log(safe(message)); } catch { /* Diagnostics never break reads. */ } }
export function validateKey(key) {
  if (!Object.hasOwn(CAPACITY_LEAVES, key)) throw Error(`operator-override: refused ${key}; guard leaves need the signed-attestation slice`);
}
/** `normalize: false` returns the stored values without lowering an inverted floor (the writer audits against them). */
export function readOperatorOverrides({ file, log = console.error, normalize = true } = {}) {
  if (file === undefined) {
    try { file = operatorOverridesPath(); } catch (error) {
      warn(log, `operator-override: operator-db-unreadable store path (${error.message}); using code value`);
      return { readable: false, values: {} };
    }
  }
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
  // Accept both canonical dotted writer output and nested operator-authored JSON.
  // Never expand unsafe segments, or recurse into an object supplied as a known numeric leaf.
  function* entries(object, prefix = '') {
    for (const [part, value] of Object.entries(object)) {
      const key = prefix ? `${prefix}.${part}` : part;
      const unsafe = key.split('.').some(k => ['__proto__', 'constructor', 'prototype'].includes(k));
      if (!unsafe && !Object.hasOwn(CAPACITY_LEAVES, key) && value && typeof value === 'object' && !Array.isArray(value)) {
        if (Object.keys(value).length) yield* entries(value, key);
        else yield [key, value];
      } else yield [key, value];
    }
  }
  for (const [key, value] of entries(data)) {
    const known = Object.hasOwn(CAPACITY_LEAVES, key);
    if (!known || !CAPACITY_LEAVES[key].validate(value)) {
      const policy = key.split('.')[0];
      invalidPolicies.add(policy);
      warn(log, `operator-override: operator-db-invalid ${key} (${known ? 'invalid type or outside hard range' : 'guard leaves need the signed-attestation slice'}); dropping this key and retaining valid leaves`);
    } else values[key] = value;
  }
  if (normalize && values['resourceGate.fixCap.ceiling'] < values['resourceGate.fixCap.floor']) {
    values['resourceGate.fixCap.floor'] = values['resourceGate.fixCap.ceiling'];
  }
  return { readable: true, values, ...(invalidPolicies.size ? { invalidPolicies: [...invalidPolicies] } : {}) };
}
