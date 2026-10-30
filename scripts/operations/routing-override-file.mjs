/** Serialized, atomic operator-file update, preserving every unrelated preference and routing entry. */
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { operatorPreferencesPath, readPlatformPreferences } from '../lib/policy-cascade.mjs';
import { applyRoutingOverrides } from '../lib/dispatch-routing-policy.mjs';
import { ROUTING_POLICY_PATH } from '../lib/dispatch-routing-policy-source.mjs';
import { ROUTING_OVERRIDE_EFFECT, planRoutingOverride } from './routing-override.mjs';
import { withFileLock } from '../lib/atomic-json-file.mjs';

export function writeRoutingOverride({ key, patch }, { env = process.env } = {}) {
  const path = operatorPreferencesPath(env);
  mkdirSync(dirname(path), { recursive: true });
  return withFileLock(`${path}.lock`, () => {
    const { prefs, errors } = readPlatformPreferences({ env: { WE_PLATFORM_PREFERENCES_FILE: path } });
    if (errors.length) throw new Error(`routing-override: refusing to overwrite unreadable preferences: ${errors.join('; ')}`);
    const policy = JSON.parse(readFileSync(ROUTING_POLICY_PATH, 'utf8'));
    const split = key.indexOf(':');
    planRoutingOverride({ operation: split < 0 ? key : key.slice(0, split), taskType: split < 0 ? '' : key.slice(split + 1),
      clear: patch === null, ...patch }, policy);
    if (prefs.routingOverrides !== undefined && (prefs.routingOverrides === null || typeof prefs.routingOverrides !== 'object' || Array.isArray(prefs.routingOverrides))) {
      throw new TypeError('routing-override: routingOverrides must be an object');
    }
    const overrides = { ...prefs.routingOverrides };
    if (patch === null) delete overrides[key];
    else overrides[key] = patch;
    applyRoutingOverrides(policy, overrides);
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
