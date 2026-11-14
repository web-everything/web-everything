/** Lock-free host capacity override reads; only Node builtins belong in this graph. */
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

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
export const OPERATOR_OVERRIDES_RELATIVE_PATH = '.claude/operator-overrides.json';
// userInfo().homedir comes from the account database, not $HOME, so a launcher cannot redirect the host-wide store.
export const operatorOverridesPath = () => join(userInfo().homedir, OPERATOR_OVERRIDES_RELATIVE_PATH);
const safe = s => String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
function warn(log, message) { try { log(safe(message)); } catch { /* Diagnostics never break reads. */ } }
export function validateKey(key) {
  if (!Object.hasOwn(CAPACITY_LEAVES, key)) throw Error(`operator-override: refused ${key}; guard leaves need the signed-attestation slice`);
}
export function readOperatorOverrides({ file = operatorOverridesPath(), log = console.error } = {}) {
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
