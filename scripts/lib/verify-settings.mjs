import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const BUILT_IN_VERIFY_SETTINGS = Object.freeze({
  relatedMode: 'all', testTimeoutFactor: 3, standards: 'always', phaseAdmission: true, fastTargets: 5,
  // #66 — a dispatched child recognizes the requester's default gate under any declared settings variant.
  matchRequestVariants: true,
  // #65 — which in-flight gates a newer request may kill: 'newer' (a different sha, tree or gate; never an
  // identical re-request), 'never', or 'any' (the old behaviour: every re-stamp kills).
  supersede: 'newer',
  // #65 — on a daemon SIGTERM: 'adopt' leaves running gates alive for the successor, 'kill' is the old teardown.
  restartInFlight: 'adopt',
  // 75b — a red test phase still runs the scan and standards phases (only an infrastructure failure stops early),
  // so one run shows every problem. A tightening: it never turns a red green.
  runAllPhases: true,
  // 75c — failing test files outside the diff are re-run once, alone, before the gate is declared red:
  // 'untouched' (any failure kind, at most 3 files), 'timeouts' (only timeout failures), 'off'.
  // A pass alone is recorded on the marker as `isolatedRetry: 'flaky-outside-diff'`; CI still runs the full suite.
  isolatedRetry: 'untouched',
});

/** Use the WE root RUNNING verify-lane, never the target lane REPO or cwd:
 * a lane being verified must not be able to weaken its own gate. */
export function defaultVerifySettingsPath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../verify-settings.json');
}

const rules = {
  relatedMode: value => ['all', 'import-only'].includes(value),
  testTimeoutFactor: value => typeof value === 'number' && Number.isFinite(value) && value >= 1,
  standards: value => ['always', 'auto', 'ci-only'].includes(value),
  phaseAdmission: value => typeof value === 'boolean',
  fastTargets: value => Number.isSafeInteger(value) && value >= 0,
  matchRequestVariants: value => typeof value === 'boolean',
  supersede: value => ['newer', 'never', 'any'].includes(value),
  restartInFlight: value => ['adopt', 'kill'].includes(value),
  runAllPhases: value => typeof value === 'boolean',
  isolatedRetry: value => ['untouched', 'timeouts', 'off'].includes(value),
};
const envKeys = {
  relatedMode: 'WE_VERIFY_RELATED', testTimeoutFactor: 'WE_VERIFY_TEST_TIMEOUT_FACTOR',
  standards: 'WE_VERIFY_STANDARDS', phaseAdmission: 'WE_VERIFY_PHASE_ADMISSION', fastTargets: 'WE_VERIFY_FAST_TARGETS',
  matchRequestVariants: 'WE_VERIFY_MATCH_REQUEST_VARIANTS', supersede: 'WE_VERIFY_SUPERSEDE',
  restartInFlight: 'WE_VERIFY_RESTART_IN_FLIGHT',
  runAllPhases: 'WE_VERIFY_RUN_ALL_PHASES', isolatedRetry: 'WE_VERIFY_ISOLATED_RETRY',
};
const booleanKeys = new Set(['phaseAdmission', 'matchRequestVariants', 'runAllPhases']);
// Preserve which keys survived validation without adding configuration keys to the file shape.
const fileKeys = new WeakMap();

/** Normalize each key independently; malformed/missing keys keep the safe built-in value. */
export function validateVerifySettings(raw) {
  const config = { ...BUILT_IN_VERIFY_SETTINGS };
  const valid = new Set();
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, check] of Object.entries(rules)) {
      if (Object.hasOwn(raw, key) && check(raw[key]) && (!fileKeys.has(raw) || fileKeys.get(raw).has(key))) {
        config[key] = raw[key];
        valid.add(key);
      }
    }
  }
  fileKeys.set(config, valid);
  return Object.freeze(config);
}

export function loadVerifySettingsFile(path = defaultVerifySettingsPath()) {
  try { return validateVerifySettings(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { return validateVerifySettings(null); }
}

/** Environment overrides are per-key; invalid overrides retain the file/default value. */
export function resolveVerifySettings({ fileConfig, env = {} } = {}) {
  const validated = validateVerifySettings(fileConfig);
  const values = { ...validated };
  const sources = {};
  for (const [key, check] of Object.entries(rules)) {
    sources[key] = fileKeys.get(validated).has(key) ? 'file' : 'default';
    let value = env?.[envKeys[key]];
    if (booleanKeys.has(key)) value = value === '0' ? false : value === '1' ? true : undefined;
    else if (key === 'testTimeoutFactor' || key === 'fastTargets') {
      value = value != null && String(value).trim() !== '' ? Number(value) : undefined;
    }
    if (check(value)) {
      values[key] = value;
      sources[key] = 'env';
    }
  }
  return { values, sources };
}
