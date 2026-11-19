/** @file hot-patch-settings.mjs - R1100 settings, resolved through the shared policy cascade. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cascadePolicy, readPlatformPreferences } from './policy-cascade.mjs';

export const hotPatchDefaults = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'hot-patch-settings.json'), 'utf8'));
// The JSON is the sole floor definition; consumers cannot mutate or replace it.
export const neverPatchFloor = Object.freeze(hotPatchDefaults.neverPatchPaths);
Object.freeze(hotPatchDefaults);

export function resolveHotPatchSettings({ env = process.env, tool = hotPatchDefaults, log } = {}) {
  if (readPlatformPreferences({ env }).errors.length) throw new Error('unreadable hot-patch settings; repair settings or use ordinary delivery');
  let envValues = {};
  if (env.WE_HOT_PATCH !== undefined) {
    try { envValues = JSON.parse(env.WE_HOT_PATCH); } catch { throw new Error('invalid WE_HOT_PATCH; repair settings before retrying'); }
  }
  const positive = v => Number.isFinite(v) && v > 0;
  const strings = v => Array.isArray(v) && v.length > 0 && v.every(s => typeof s === 'string' && s.length > 0);
  const r = cascadePolicy('hotPatch', tool, { env, log, envValues, standard: hotPatchDefaults,
    valid: { ticks: v => positive(v) && Number.isInteger(v), minMinutes: positive, owedPrMinutes: positive,
      owedMergeHours: positive, queueExemptionMinutes: positive, wake: v => typeof v === 'boolean', wakeMinIntervalMs: positive,
      maxFiles: positive, maxPathChars: positive, ioTimeoutMs: positive, registrationTimeoutMs: positive,
      maxOutputBytes: positive, eligibleKinds: strings, neverPatchPaths: strings } });
  // Settings may extend protection; a preset never waives the never-patch floor.
  return { ...r.value, neverPatchPaths: [...new Set([...neverPatchFloor, ...r.value.neverPatchPaths])] };
}
