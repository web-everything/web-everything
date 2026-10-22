/** Shared orchestrator builder capacity, resolved through the policy cascade. */
import { readSettings } from './settings-files.mjs';
import { cascadePolicy, platformPreference } from './policy-cascade.mjs';

export const BUILDER_SLOT_DEFAULTS = Object.freeze({ enabled: true, maxClaude: 1, maxExternal: 4, ttlMs: 1800000, waitMs: 600000 });
export function readBuilderSlotSettings({ env = process.env, read = readSettings, platform, log } = {}) {
  let tool;
  try { tool = read()?.builderSlots; } catch { /* keep lower layers */ }
  const integer = min => v => Number.isSafeInteger(v) && v >= min;
  const valid = { enabled: v => typeof v === 'boolean', maxClaude: integer(0), maxExternal: integer(0), ttlMs: integer(1000), waitMs: integer(0) };
  const layer = value => Object.fromEntries(Object.entries(valid).filter(([key, check]) => check(value?.[key])).map(([key]) => [key, value[key]]));
  const envValues = {};
  for (const [key, name] of Object.entries({ maxClaude: 'MAX_CLAUDE', maxExternal: 'MAX_EXTERNAL', ttlMs: 'TTL_MS', waitMs: 'WAIT_MS' })) {
    const raw = env[`WE_BUILDER_SLOTS_${name}`];
    if (raw !== undefined) envValues[key] = /^\d+$/.test(raw) ? Number(raw) : raw;
  }
  if (env.WE_BUILDER_SLOTS !== undefined) {
    const raw = String(env.WE_BUILDER_SLOTS).toLowerCase();
    envValues.enabled = ['off', '0', 'false'].includes(raw) ? false : ['on', '1', 'true'].includes(raw) ? true : raw;
  }
  const r = cascadePolicy('builderSlots', layer(tool), { standard: BUILDER_SLOT_DEFAULTS, platform: layer(platform ?? platformPreference('builderSlots', { env })), env, log, envValues, valid });
  return { ...r.value, sources: r.sources };
}
