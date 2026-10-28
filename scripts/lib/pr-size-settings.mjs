import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cascadePolicy, readPlatformPreferences } from './policy-cascade.mjs';
import { BUILT_IN_PR_SIZE_SETTINGS } from './pr-size-defaults.mjs';

const arrayOf = check => value => Array.isArray(value) && value.every(v => typeof v === 'string' && check(v));
const valid = {
  dataExtensions: arrayOf(v => BUILT_IN_PR_SIZE_SETTINGS.dataExtensions.includes(v)),
  dataDirs: arrayOf(v => !!v && !/[\\/\x00-\x1f]/.test(v) && v !== '.' && v !== '..'),
  dataPaths: arrayOf(v => !!v && !v.startsWith('/') && !/[\\\x00-\x1f]/.test(v)
    && v.split('/').every(segment => segment && segment !== '.' && segment !== '..')
    && BUILT_IN_PR_SIZE_SETTINGS.dataExtensions.some(extension => v.endsWith(extension))),
};

function validateSettings(settings, layer) {
  if (settings === undefined) return;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`Invalid prSize ${layer} settings: expected an object`);
  }
  for (const key of Object.keys(valid)) {
    if (Object.hasOwn(settings, key) && !valid[key](settings[key])) {
      throw new Error(`Invalid prSize ${layer}.${key}`);
    }
  }
}

/** Standard → platform prSize → tool file → JSON-array environment overrides.
 * Validate every present layer before resolving; a bad override must never fall back.
 * The shared cascade records effective values and provenance.
 */
export function resolvePrSizeSettings({ tool, platform, env = process.env } = {}) {
  if (platform === undefined) {
    const { prefs, errors } = readPlatformPreferences({ env });
    if (errors.length) throw new Error(`Unreadable prSize platform settings: ${errors.join('; ')}`);
    platform = prefs.prSize;
  }
  validateSettings(platform, 'platform');
  validateSettings(tool, 'tool');
  const envValues = {};
  for (const [key, name] of Object.entries({ dataExtensions: 'WE_PR_SIZE_DATA_EXTENSIONS',
    dataDirs: 'WE_PR_SIZE_DATA_DIRS', dataPaths: 'WE_PR_SIZE_DATA_PATHS' })) {
    if (env?.[name] === undefined) continue;
    envValues[key] = JSON.parse(env[name]);
  }
  validateSettings(envValues, 'env');
  return cascadePolicy('prSize', tool, { standard: BUILT_IN_PR_SIZE_SETTINGS, platform: platform ?? {}, env, envValues, valid });
}

/** Resolve relative to the running tool, never a target lane's cwd. Only absent files use defaults. */
export function loadPrSizeSettingsFile(path = join(dirname(fileURLToPath(import.meta.url)), '../pr-size-settings.json'), options = {}) {
  let tool;
  try { tool = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { value } = resolvePrSizeSettings({ ...options, tool });
  return Object.freeze(Object.fromEntries(Object.keys(BUILT_IN_PR_SIZE_SETTINGS)
    .map(key => [key, Object.freeze([...value[key]])])));
}
