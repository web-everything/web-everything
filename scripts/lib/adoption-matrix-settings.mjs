/** Read-only adoption matrix overrides; unreadable or malformed settings throw. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUILT_IN_ADOPTION_MATRIX_SETTINGS = Object.freeze({
  clones: Object.freeze([]), excludeClones: Object.freeze([]), fixReadyPath: null,
});
const path = value => typeof value === 'string' && value.trim().length > 0;
const paths = value => Array.isArray(value) && value.every(path);

export function validateAdoptionMatrixSettings(raw) {
  const config = { ...BUILT_IN_ADOPTION_MATRIX_SETTINGS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Invalid adoption matrix settings');
  for (const key of ['clones', 'excludeClones']) {
    if (!Object.hasOwn(raw, key)) continue;
    if (!paths(raw[key])) throw new TypeError(`Invalid adoption matrix settings: ${key}`);
    config[key] = Object.freeze([...raw[key]]);
  }
  if (Object.hasOwn(raw, 'fixReadyPath')) {
    if (raw.fixReadyPath !== null && !path(raw.fixReadyPath)) throw new TypeError('Invalid adoption matrix settings: fixReadyPath');
    config.fixReadyPath = raw.fixReadyPath;
  }
  return Object.freeze(config);
}

export function loadAdoptionMatrixSettingsFile(
  path = join(dirname(fileURLToPath(import.meta.url)), 'adoption-matrix-settings.json'),
  { readText = file => readFileSync(file, 'utf8') } = {},
) {
  return validateAdoptionMatrixSettings(JSON.parse(readText(path)));
}
