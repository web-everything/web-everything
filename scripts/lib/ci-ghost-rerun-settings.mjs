/**
 * @file scripts/lib/ci-ghost-rerun-settings.mjs
 * @description Ghost CI recovery settings through the shared policy cascade.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { PLATFORM_PREFERENCES_ENV, readPlatformPreferences, resolveCascade, logCascadeSources } from './policy-cascade.mjs';
import { readDeclaredSettings, SETTINGS_DIR } from './settings-files.mjs';

const isPlainObject = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

const bounds = {
  thresholdMin: value => Number.isFinite(value) && value >= 5,
  maxPerHead: value => Number.isInteger(value) && value >= 1 && value <= 2,
  maxPerWindow: value => Number.isInteger(value) && value >= 1 && value <= 3,
  windowHours: value => Number.isFinite(value) && value >= 1 && value <= 24,
  cancelWaitSec: value => Number.isFinite(value) && value >= 5 && value <= 300,
};

export function isValidCiGhostRerunSettings(settings) {
  return !!settings && !settings.invalid
    && Object.entries(bounds).every(([key, valid]) => valid(settings[key]));
}

export function readCiGhostRerunSettings({ env = process.env, platform, tool, log,
  readPlatform = readPlatformPreferences, readTool = readDeclaredSettings,
  readDirectory = readdirSync } = {}) {
  const standard = { thresholdMin: 15, maxPerWindow: 1, maxPerHead: 1, windowHours: 2, cancelWaitSec: 60 };
  const invalid = [];
  const load = (name, read, key) => {
    try {
      const result = read();
      if (result.errors.length) invalid.push(`${name}.read`);
      if (!isPlainObject(result[key])) { invalid.push(name); return undefined; }
      return result[key];
    } catch {
      invalid.push(`${name}.read`);
      return undefined;
    }
  };
  const block = (name, layer) => {
    if (layer == null) return undefined;
    if (!isPlainObject(layer)) { invalid.push(name); return undefined; }
    if (!Object.hasOwn(layer, 'ciGhostRerun')) return layer;
    if (!isPlainObject(layer.ciGhostRerun)) { invalid.push(`${name}.ciGhostRerun`); return undefined; }
    return layer.ciGhostRerun;
  };
  const select = layer => Object.fromEntries(Object.keys(standard)
    .filter(key => layer?.[key] !== undefined).map(key => [key, layer[key]]));
  const envValues = Object.fromEntries(Object.keys(standard).map(key => {
    const name = `WE_CI_GHOST_RERUN_${key.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`;
    return [key, env[name] === undefined ? undefined : Number(env[name])];
  }));
  const layers = {
    platform: select(block('platform', platform === undefined
      ? load('platform', () => readPlatform({ env, readFile: (...args) => {
        try { return readFileSync(...args); } catch (error) {
          // The shared reader ignores missing optional files. An explicit selector
          // must refuse recovery until the operator restores a readable file.
          if (error?.code === 'ENOENT' && String(env?.[PLATFORM_PREFERENCES_ENV] ?? '').trim()) {
            invalid.push('platform.read');
          }
          throw error;
        }
      } }), 'prefs') : platform)),
    tool: select(block('tool', tool === undefined
      ? load('tool', () => {
        // The shared reader silently treats an unreadable directory as empty.
        // Recovery must refuse until the operator restores readable settings.
        readDirectory(SETTINGS_DIR);
        return readTool();
      }, 'settings') : tool)), env: envValues,
  };
  // Preserve invalid overrides even when the shared cascade selects a valid lower layer.
  // Check whole values too: an object must not disappear into cascade leaf traversal.
  invalid.push(...Object.entries(layers).flatMap(([layer, values]) => Object.entries(values)
    .filter(([key, value]) => value !== undefined && !bounds[key](value))
    .map(([key]) => `${layer}.${key}`)));
  const resolved = resolveCascade({ standard, platform: layers.platform, tool: layers.tool,
    envValues, valid: bounds });
  logCascadeSources('ciGhostRerun', resolved, { env, ...(log ? { log } : {}) });
  return invalid.length ? { ...resolved.value, invalid } : resolved.value;
}
