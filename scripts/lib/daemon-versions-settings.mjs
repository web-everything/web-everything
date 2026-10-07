/**
 * @file scripts/lib/daemon-versions-settings.mjs
 * @description Card 89 S1 — dormant versioning configuration; no runtime consumer yet.
 * Invalid keys retain built-in defaults, invalid env overrides retain file values.
 * clonesRoot null means `<workspace>/.daemon-clones`; paths remain declarative here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const BUILT_IN_DAEMON_VERSIONS_SETTINGS = Object.freeze({
  enabled: Object.freeze({}), clonesRoot: null, keep: 3, retainMinAgeMs: 21600000,
  nodeModules: 'store-link', nodeModulesStore: null,
  carryPaths: Object.freeze(['scripts/rust-scan/target']),
  statePaths: Object.freeze(['.conveyor', '.operations', '.claude/settings.local.json',
    '.claude/lane-ports.json', 'reports/.required-status-checks-cache.json']),
  carryUntracked: true, pickup: 'per-tick', updater: 'in-tick', probationMs: 900000,
  autoRollback: true, restartJitterMs: 30000, requestPollMs: 5000,
});

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const nullablePath = value => value === null || nonempty(value);
const relativePath = value => nonempty(value) && !value.startsWith('/') && !value.includes('\\')
  && value.split('/').every(part => part !== '..' && part !== '.' && part !== '');
const paths = value => Array.isArray(value) && value.every(relativePath);
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const boolean = value => typeof value === 'boolean';
const rules = {
  enabled: value => object(value) && Object.entries(value).every(([name, enabled]) =>
    relativePath(name) && !name.includes('/') && boolean(enabled)),
  clonesRoot: nullablePath, keep: positive, retainMinAgeMs: nonnegative,
  nodeModules: value => value === 'store-link', nodeModulesStore: nullablePath,
  carryPaths: paths, statePaths: paths, carryUntracked: boolean,
  pickup: value => value === 'per-tick', updater: value => value === 'in-tick',
  probationMs: nonnegative, autoRollback: boolean, restartJitterMs: nonnegative, requestPollMs: positive,
};
const fileKeys = new WeakMap();
const immutable = value => Array.isArray(value) ? Object.freeze([...value])
  : object(value) ? Object.freeze({ ...value }) : value;

export function defaultDaemonVersionsSettingsPath() {
  return join(dirname(fileURLToPath(import.meta.url)), 'daemon-versions-settings.json');
}

/** Normalize independently, rejecting malformed values in favor of safe defaults. */
export function validateDaemonVersionsSettings(raw) {
  const config = { ...BUILT_IN_DAEMON_VERSIONS_SETTINGS };
  const valid = new Set();
  if (object(raw)) {
    for (const [key, check] of Object.entries(rules)) {
      if (Object.hasOwn(raw, key) && check(raw[key]) && (!fileKeys.has(raw) || fileKeys.get(raw).has(key))) {
        config[key] = immutable(raw[key]);
        valid.add(key);
      }
    }
  }
  fileKeys.set(config, valid);
  return Object.freeze(config);
}

export function loadDaemonVersionsSettingsFile(path = defaultDaemonVersionsSettingsPath()) {
  try { return validateDaemonVersionsSettings(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { return validateDaemonVersionsSettings(null); }
}

/** WE_DAEMON_VERSIONS_<UPPER_SNAKE>; maps/arrays use JSON, booleans use 0/1 or true/false. */
export function resolveDaemonVersionsSettings({ fileConfig, env = {} } = {}) {
  const validated = validateDaemonVersionsSettings(fileConfig);
  const values = { ...validated };
  const sources = {};
  for (const [key, check] of Object.entries(rules)) {
    sources[key] = fileKeys.get(validated).has(key) ? 'file' : 'default';
    const envKey = `WE_DAEMON_VERSIONS_${key.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase()}`;
    let value = env?.[envKey];
    const fallback = BUILT_IN_DAEMON_VERSIONS_SETTINGS[key];
    if (typeof fallback === 'boolean') {
      value = value === '1' || value === 'true' ? true : value === '0' || value === 'false' ? false : undefined;
    } else if (typeof fallback === 'number') {
      value = value != null && String(value).trim() !== '' ? Number(value) : undefined;
    } else if (fallback !== null && typeof fallback === 'object') {
      try { value = JSON.parse(value); } catch { value = undefined; }
    } else if (fallback === null && value === 'null') value = null;
    if (check(value)) {
      values[key] = immutable(value);
      sources[key] = 'env';
    }
  }
  return { values: Object.freeze(values), sources };
}

/** Every clone is disabled unless its own map entry is explicitly true. */
export function isVersionedClone(name, settings = BUILT_IN_DAEMON_VERSIONS_SETTINGS) {
  return object(settings?.enabled) && Object.hasOwn(settings.enabled, name) && settings.enabled[name] === true;
}
