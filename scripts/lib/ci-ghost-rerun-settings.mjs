/**
 * @file scripts/lib/ci-ghost-rerun-settings.mjs
 * @description Ghost CI recovery settings through the shared policy cascade.
 */
import { platformPreference, resolveCascade, logCascadeSources } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';

export function readCiGhostRerunSettings({ env = process.env, platform, tool, log } = {}) {
  const standard = { thresholdMin: 15, maxPerWindow: 1, windowHours: 2, cancelWaitSec: 60 };
  const select = layer => Object.fromEntries(Object.keys(standard)
    .filter(key => layer?.[key] !== undefined).map(key => [key, layer[key]]));
  const envValues = Object.fromEntries(Object.keys(standard).map(key => {
    const name = `WE_CI_GHOST_RERUN_${key.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`;
    return [key, env[name] === undefined ? undefined : Number(env[name])];
  }));
  const resolved = resolveCascade({ standard,
    platform: select(platform ?? platformPreference('ciGhostRerun', { env })),
    tool: select(tool ?? readSettings()?.ciGhostRerun), envValues,
    valid: Object.fromEntries(Object.keys(standard).map(key => [key, value =>
      Number.isFinite(value) && value > 0 && (key !== 'maxPerWindow' || Number.isInteger(value))])),
  });
  logCascadeSources('ciGhostRerun', resolved, { env, ...(log ? { log } : {}) });
  return resolved.value;
}
