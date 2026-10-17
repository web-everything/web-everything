import { platformPreference, resolveCascade, logCascadeSources } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';

export function readBuildUnconfirmedSettings({ env = process.env, platform, tool, log } = {}) {
  const keys = ['unconfirmedLaunchMax', 'unconfirmedCooldownMin'];
  const select = layer => Object.fromEntries(keys.filter(key => layer?.[key] !== undefined).map(key => [key, layer[key]]));
  const positive = v => Number.isFinite(v) && v > 0;
  const parsed = key => env[key] === undefined ? undefined : Number(env[key]);
  const resolved = resolveCascade({
    standard: { unconfirmedLaunchMax: 2, unconfirmedCooldownMin: 120 },
    platform: select(platform ?? platformPreference('build', { env })), tool: select(tool ?? readSettings()?.build),
    envValues: { unconfirmedLaunchMax: parsed('WE_BUILD_UNCONFIRMED_LAUNCH_MAX'),
      unconfirmedCooldownMin: parsed('WE_BUILD_UNCONFIRMED_COOLDOWN_MIN') },
    valid: { unconfirmedLaunchMax: v => positive(v) && Number.isInteger(v), unconfirmedCooldownMin: positive },
  });
  logCascadeSources('build', resolved, { env, ...(log ? { log } : {}) });
  return resolved.value;
}
