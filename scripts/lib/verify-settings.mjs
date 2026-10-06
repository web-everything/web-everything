import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const BUILT_IN_VERIFY_SETTINGS = Object.freeze({
  relatedMode: 'all', testTimeoutFactor: 3, standards: 'always', phaseAdmission: true, fastTargets: 5,
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
};
const envKeys = {
  relatedMode: 'WE_VERIFY_RELATED', testTimeoutFactor: 'WE_VERIFY_TEST_TIMEOUT_FACTOR',
  standards: 'WE_VERIFY_STANDARDS', phaseAdmission: 'WE_VERIFY_PHASE_ADMISSION', fastTargets: 'WE_VERIFY_FAST_TARGETS',
};
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
    if (key === 'phaseAdmission') value = value === '0' ? false : value === '1' ? true : undefined;
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
