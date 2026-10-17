/** Hand-off policy leaves use the shared standard/platform/tool/env cascade and source log. */
import { cascadePolicy, platformPreference } from './policy-cascade.mjs';
import { isUnderTest } from './under-test.mjs';
import { readSettings } from './settings-files.mjs';
export function resolveHandoffSettings(policy = 'fix', { env = process.env, tool = readSettings()[policy], platform } = {}) {
  const standard = policy === 'fix' ? { sendBackReservedSlots: 1, ciMissingAfterPushMin: 10 } : { mergeableUnknownRepollSec: 20 };
  const envValues = {};
  for (const key of Object.keys(standard)) {
    const name = `WE_${policy.toUpperCase()}_${key.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`;
    if (env[name] !== undefined) envValues[key] = /^\d+$/.test(env[name]) ? Number(env[name]) : env[name];
  }
  const select = layer => Object.fromEntries(Object.keys(standard).filter(key => layer?.[key] !== undefined).map(key => [key, layer[key]]));
  const logEnv = { ...env, WE_POLICY_CASCADE_LOG: env.WE_POLICY_CASCADE_LOG ?? (isUnderTest(env) ? '0' : '1') };
  return cascadePolicy(policy, select(tool), { standard, platform: select(platform ?? platformPreference(policy, { env })), env: logEnv, envValues,
    valid: value => Number.isInteger(value) && value >= 0 && value <= 3600 });
}
