/** Serialized, atomic operator-file update, preserving every unrelated preference and routing entry. */
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, realpathSync, readlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { operatorPreferencesPath } from '../lib/policy-cascade.mjs';
import { applyRoutingOverrides } from '../lib/dispatch-routing-policy.mjs';
import { ROUTING_POLICY_PATH } from '../lib/dispatch-routing-policy-source.mjs';
import { ROUTING_OVERRIDE_EFFECT, planRoutingOverride, resolveRoutingOverrideRoute } from './routing-override.mjs';
import { withFileLock } from '../lib/atomic-json-file.mjs';

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Follow symlinks to the file to update, including a dangling link whose target does not exist yet. */
function preferencesWriteTarget(path) {
  for (let hops = 0; hops < 40; hops += 1) {
    try { return realpathSync(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { path = resolve(dirname(path), readlinkSync(path)); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'EINVAL') return path; throw error; }
  }
  throw new Error(`routing-override: too many symlink hops resolving ${path}`);
}

export function writeRoutingOverride({ key, patch }, { env = process.env } = {}) {
  const path = preferencesWriteTarget(operatorPreferencesPath(env));
  mkdirSync(dirname(path), { recursive: true });
  return withFileLock(`${path}.lock`, () => {
    let prefs = {};
    try {
      prefs = JSON.parse(readFileSync(path, 'utf8'), (key, value) => UNSAFE_KEYS.has(key) ? undefined : value);
      if (prefs === null || typeof prefs !== 'object' || Array.isArray(prefs)) throw new TypeError('not a JSON object');
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`routing-override: refusing to overwrite unreadable preferences: ${error.message}`);
    }
    const policy = JSON.parse(readFileSync(ROUTING_POLICY_PATH, 'utf8'));
    const split = key.indexOf(':');
    if (patch === null) planRoutingOverride({ operation: split < 0 ? key : key.slice(0, split),
      taskType: split < 0 ? '' : key.slice(split + 1), clear: true }, policy);
    if (prefs.routingOverrides !== undefined && (prefs.routingOverrides === null || typeof prefs.routingOverrides !== 'object' || Array.isArray(prefs.routingOverrides))) {
      throw new TypeError('routing-override: routingOverrides must be an object');
    }
    const overrides = { ...prefs.routingOverrides };
    if (patch === null) delete overrides[key];
    else overrides[key] = patch;
    const effectivePolicy = applyRoutingOverrides(policy, overrides);
    resolveRoutingOverrideRoute(key, effectivePolicy);
    prefs.routingOverrides = overrides;
    const scratch = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(scratch, `${JSON.stringify(prefs, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      renameSync(scratch, path);
    } finally { rmSync(scratch, { force: true }); }
    return { key, cleared: patch === null, source: 'platform' };
  });
}

export function createRoutingOverrideSinks(options) {
  return { [ROUTING_OVERRIDE_EFFECT]: payload => writeRoutingOverride(payload, options) };
}
