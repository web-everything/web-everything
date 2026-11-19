/** Churn-volume settings: standard → platform → tool → environment. */
import { accessSync, constants, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, normalize, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPlatformPreferences, resolveCascade } from './policy-cascade.mjs';
import { boundedText } from './host-overload-settings.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const stderr =message => process.stderr.write(`${message}\n`);
const logged = new Set();
function once(message) { if (!logged.has(message)) { logged.add(message); stderr(message); } }
const pathValue = value => value === '' || (typeof value === 'string' && (isAbsolute(value) || value.startsWith('~/')));
const leaves = {
  'lanes.root': ['', 'LANE_POOL_ROOT', v => pathValue(v) && (v === '' || basename(normalize(v)) === '.lanes')],
  'heavy.tmpRoot': ['', 'WE_HEAVY_TMP_ROOT', pathValue],
  'health.fseventsd.warnMb': [1024, 'WE_FSEVENTSD_WARN_MB', v => Number.isFinite(v) && v > 0],
  'health.fseventsd.throttleMb': [2048, 'WE_FSEVENTSD_THROTTLE_MB', v => Number.isFinite(v) && v > 0],
};
function flatten(object) {
  const result = {};
  for (const key of Object.keys(leaves)) {
    let value = object;
    for (const part of key.split('.')) { if (value === undefined) break; value = value?.[part]; }
    if (value !== undefined) result[key] = value;
  }
  return result;
}
/** Injectable layers avoid machine preferences in deterministic tests. Invalid evidence is refused. */
export function readVolumeSettings({ env = process.env, prefs, tool, log = once } = {}) {
  if (prefs === undefined) {
    const read = readPlatformPreferences({ env, readFile: path => boundedText(path instanceof URL ? fileURLToPath(path) : path, 1024 * 1024) });
    if (read.errors.length) throw Error(`volume settings: ${read.errors.join(', ')}`);
    prefs = read.prefs;
  }
  if (tool === undefined) {
    try { tool = JSON.parse(boundedText(join(HERE, '../settings/lanes-volume.json'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; tool = {}; }
  }
  const envValues = {};
  for (const [key, [, name]] of Object.entries(leaves)) if (env[name] !== undefined) {
    envValues[key] = key.endsWith('Mb') ? Number(env[name]) : env[name];
  }
  const resolved = resolveCascade({ standard: Object.fromEntries(Object.entries(leaves).map(([k, [v]]) => [k, v])),
    platform: flatten(prefs), tool: flatten(tool), envValues,
    valid: Object.fromEntries(Object.entries(leaves).map(([k, [, , valid]]) => [k, valid])) });
  if (resolved.invalid.length) throw Error(`volume settings invalid: ${resolved.invalid.join(', ')}`);
  if (resolved.value['health.fseventsd.warnMb'] > resolved.value['health.fseventsd.throttleMb']) throw Error('fseventsd warnMb exceeds throttleMb');
  for (const [key, value] of Object.entries(resolved.value)) {
    // Unset paths are silent, preserving the existing default invocation's output.
    if (value !== '' && resolved.sources[key] !== 'standard') log(`policy-cascade · volumes: ${key}=${value} (${resolved.sources[key]})`);
  }
  return resolved;
}
/** Optional pool root; the caller supplies its existing workspace-derived default. */
export function readLanesRoot(options = {}) {
  const value = readVolumeSettings(options).value['lanes.root'];
  if (!value) return '';
  return normalize(value.startsWith('~/') ? join(options.env?.HOME || process.env.HOME || homedir(), value.slice(2)) : value);
}
/** Ensure an optional TMPDIR is usable; failure falls back and warns once per process. */
export function readHeavyTmpRoot(options = {}) {
  const fallback = options.defaultRoot ?? tmpdir();
  let value;
  try {
    value = readVolumeSettings(options).value['heavy.tmpRoot'];
    if (!value) return fallback;
    if (value.startsWith('~/')) value = join(options.env?.HOME || process.env.HOME || homedir(), value.slice(2));
    (options.mkdir ?? mkdirSync)(value, { recursive: true });
    (options.access ?? accessSync)(value, constants.W_OK | constants.X_OK);
    return value;
  } catch (error) {
    (options.log ?? once)(`heavy.tmpRoot unavailable; using ${fallback}: ${error.message}`);
    return fallback;
  }
}
