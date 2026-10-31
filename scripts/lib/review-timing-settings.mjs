/** Source-logged timing policy cascade: standard < platform < repo < env. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cascadePolicy, platformPreference } from './policy-cascade.mjs';
import { REVIEW_TIMING_DEFAULTS, FIX_TIMING_DEFAULTS, normalizeFastChecks, validFastChecks } from './review-timing.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
const readJson = (path, read) => { try { return JSON.parse(read(path, 'utf8')); } catch { return {}; } };
const nonnegative = v => Number.isSafeInteger(v) && v >= 0;
const boolean = v => typeof v === 'boolean';
export function resolveTimingPolicy({ env = process.env, read = readFileSync, review, fix, platformReview, platformFix, log } = {}) {
  const envValues = (prefix, defaults) => Object.fromEntries(Object.keys(defaults).map(key => {
    const raw = env[`${prefix}_${key.replace(/[A-Z]/g, x => `_${x}`).toUpperCase()}`];
    let value;
    if (raw !== undefined) { try { value = JSON.parse(raw); } catch { value = raw; } }
    return [key, value];
  }));
  const pick = (value, defaults) => Object.fromEntries(Object.keys(defaults).filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
  // fastChecks merges per repo across layers: every layer is normalized to a repo-key map before the cascade.
  const pickReview = value => {
    const picked = pick(value, REVIEW_TIMING_DEFAULTS);
    if (picked.fastChecks !== undefined) picked.fastChecks = normalizeFastChecks(picked.fastChecks);
    return picked;
  };
  const reviewEnv = envValues('WE_REVIEW', REVIEW_TIMING_DEFAULTS);
  if (reviewEnv.fastChecks !== undefined) reviewEnv.fastChecks = normalizeFastChecks(reviewEnv.fastChecks);
  // Preserve the existing on/off control as an alias; the named timing setting wins when both are present.
  if (reviewEnv.skipDrainMechanical === undefined && ['on', 'off'].includes(env.WE_REVIEW_CARRY_ACROSS_REBASE))
    reviewEnv.skipDrainMechanical = env.WE_REVIEW_CARRY_ACROSS_REBASE === 'on';
  const reviewResult = cascadePolicy('review', pickReview(review ?? readJson(join(HERE, '..', 'review-settings.json'), read)), {
    standard: REVIEW_TIMING_DEFAULTS, platform: pickReview(platformReview ?? platformPreference('review', { env, readFile: read })), env, log,
    envValues: reviewEnv, valid: {
      startAfter: v => ['fast-checks', 'ci-green', 'push'].includes(v),
      fastChecks: validFastChecks,
      startBeforeCi: boolean, cancelOnCiRed: boolean, skipDrainMechanical: boolean, deltaMaxLines: nonnegative, deltaMaxFiles: nonnegative,
    },
  });
  const fixResult = cascadePolicy('fix', pick(fix ?? readJson(join(HERE, '..', 'settings', 'fix.json'), read)?.fix, FIX_TIMING_DEFAULTS), {
    standard: FIX_TIMING_DEFAULTS, platform: pick(platformFix ?? platformPreference('fix', { env, readFile: read }), FIX_TIMING_DEFAULTS), env, log,
    envValues: envValues('WE_FIX', FIX_TIMING_DEFAULTS), valid: { joinCiAndReview: boolean, joinWaitMaxMin: nonnegative, pushAfterCi: boolean, pushAfterCiMaxMin: nonnegative },
  });
  return { review: reviewResult.value, fix: fixResult.value, sources: { review: reviewResult.sources, fix: fixResult.sources } };
}
