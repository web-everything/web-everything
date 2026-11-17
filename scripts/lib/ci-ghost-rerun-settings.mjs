/**
 * @file scripts/lib/ci-ghost-rerun-settings.mjs
 * @description Ghost CI recovery settings through the shared policy cascade.
 */
import { platformPreference, resolveCascade, logCascadeSources } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';

const bounds = {
  thresholdMin: value => Number.isFinite(value) && value >= 5,
  maxPerWindow: value => Number.isInteger(value) && value >= 1 && value <= 3,
  windowHours: value => Number.isFinite(value) && value >= 1 && value <= 24,
  cancelWaitSec: value => Number.isFinite(value) && value >= 5 && value <= 300,
};

export function isValidCiGhostRerunSettings(settings) {
  return !!settings && !settings.invalid
    && Object.entries(bounds).every(([key, valid]) => valid(settings[key]));
}

export function readCiGhostRerunSettings({ env = process.env, platform, tool, log } = {}) {
  const standard = { thresholdMin: 15, maxPerWindow: 1, windowHours: 2, cancelWaitSec: 60 };
  const select = layer => Object.fromEntries(Object.keys(standard)
    .filter(key => layer?.[key] !== undefined).map(key => [key, layer[key]]));
  const envValues = Object.fromEntries(Object.keys(standard).map(key => {
    const name = `WE_CI_GHOST_RERUN_${key.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`;
    return [key, env[name] === undefined ? undefined : Number(env[name])];
  }));
  const layers = {
    platform: select(platform ?? platformPreference('ciGhostRerun', { env })),
    tool: select(tool ?? readSettings()?.ciGhostRerun), env: envValues,
  };
  // Preserve invalid overrides even when the shared cascade selects a valid lower layer.
  // Check whole values too: an object must not disappear into cascade leaf traversal.
  const invalid = Object.entries(layers).flatMap(([layer, values]) => Object.entries(values)
    .filter(([key, value]) => value !== undefined && !bounds[key](value))
    .map(([key]) => `${layer}.${key}`));
  const resolved = resolveCascade({ standard, platform: layers.platform, tool: layers.tool,
    envValues, valid: bounds });
  logCascadeSources('ciGhostRerun', resolved, { env, ...(log ? { log } : {}) });
  return invalid.length ? { ...resolved.value, invalid } : resolved.value;
}
