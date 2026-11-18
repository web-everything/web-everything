/** Prepare policy: standard → platform → feature settings → environment. */
import { readSettings } from '../lib/settings-files.mjs';
import { cascadePolicy, resolveCascade, platformPreference } from '../lib/policy-cascade.mjs';

const standard = Object.freeze({ batchParallel: true, batchMaxParallel: 3, batchSize: 6, aheadCount: 20, lightRevalidate: true, lightRevalidateMaxDiffLines: 400, retryUnstampedOnce: true, autoSize: true, runner: 'codex', mergedGuardHours: 24, maxPrListingCallsPerTick: 128, launchPrListingReserve: 32, parkedPrListingCacheMinutes: 15 });
const bool = v => typeof v === 'boolean';
const valid = { batchParallel: bool, batchMaxParallel: v => Number.isSafeInteger(v) && v >= 1 && v <= 100, batchSize: v => Number.isSafeInteger(v) && v >= 1 && v <= 100, aheadCount: v => Number.isSafeInteger(v) && v >= 0 && v <= 10000, lightRevalidate: bool, lightRevalidateMaxDiffLines: v => Number.isInteger(v) && v >= 0, maxPrListingCallsPerTick: v => Number.isInteger(v) && v >= 0 && v <= 1000, launchPrListingReserve: v => Number.isInteger(v) && v >= 0 && v <= 1000, parkedPrListingCacheMinutes: v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1440, retryUnstampedOnce: bool, autoSize: bool, runner: v => ['codex', 'claude', 'scope'].includes(v),
  mergedGuardHours: v => typeof v === 'number' && Number.isFinite(v) && v >= 0 };
const parseBool = v => {
  if (bool(v)) return v;
  if (typeof v !== 'string') return undefined;
  const text = v.trim().toLowerCase();
  return ['true', '1'].includes(text) ? true : ['false', '0'].includes(text) ? false : undefined;
};
// Select only valid known leaves: malformed nested objects must not become cascade leaves.
const block = value => Object.fromEntries(Object.keys(standard)
  .filter(key => valid[key](value?.[key])).map(key => [key, value[key]]));
const envValues = env => ({
  batchParallel: parseBool(env?.WE_PREPARE_BATCH_PARALLEL),
  batchMaxParallel: env?.WE_PREPARE_BATCH_MAX_PARALLEL?.trim() ? Number(env.WE_PREPARE_BATCH_MAX_PARALLEL) : undefined,
  batchSize: env?.WE_PREPARE_BATCH_SIZE?.trim() ? Number(env.WE_PREPARE_BATCH_SIZE) : undefined,
  aheadCount: env?.WE_PREPARE_AHEAD_COUNT?.trim() ? Number(env.WE_PREPARE_AHEAD_COUNT) : undefined,
  lightRevalidate: parseBool(env?.WE_PREPARE_LIGHT_REVALIDATE),
  lightRevalidateMaxDiffLines: env?.WE_PREPARE_LIGHT_REVALIDATE_MAX_DIFF_LINES?.trim() ? Number(env.WE_PREPARE_LIGHT_REVALIDATE_MAX_DIFF_LINES) : undefined,
  retryUnstampedOnce: parseBool(env?.WE_PREPARE_RETRY_UNSTAMPED_ONCE),
  autoSize: parseBool(env?.WE_PREPARE_AUTO_SIZE),
  runner: env?.WE_PREPARE_RUNNER,
  maxPrListingCallsPerTick: env?.WE_PREPARE_MAX_PR_LISTING_CALLS_PER_TICK?.trim() ? Number(env.WE_PREPARE_MAX_PR_LISTING_CALLS_PER_TICK) : undefined,
  launchPrListingReserve: env?.WE_PREPARE_LAUNCH_PR_LISTING_RESERVE?.trim() ? Number(env.WE_PREPARE_LAUNCH_PR_LISTING_RESERVE) : undefined,
  parkedPrListingCacheMinutes: env?.WE_PREPARE_PARKED_PR_LISTING_CACHE_MINUTES?.trim() ? Number(env.WE_PREPARE_PARKED_PR_LISTING_CACHE_MINUTES) : undefined,
  mergedGuardHours: typeof env?.WE_PREPARE_MERGED_GUARD_HOURS === 'string'
    && env.WE_PREPARE_MERGED_GUARD_HOURS.trim() !== '' ? Number(env.WE_PREPARE_MERGED_GUARD_HOURS) : undefined,
});
const result = resolved => ({
  batchParallel: resolved.value.batchParallel,
  batchMaxParallel: resolved.value.batchMaxParallel,
  batchSize: resolved.value.batchSize,
  aheadCount: resolved.value.aheadCount,
  lightRevalidate: resolved.value.lightRevalidate,
  lightRevalidateMaxDiffLines: resolved.value.lightRevalidateMaxDiffLines,
  retryUnstampedOnce: resolved.value.retryUnstampedOnce,
  autoSize: resolved.value.autoSize,
  runner: resolved.value.runner,
  maxPrListingCallsPerTick: resolved.value.maxPrListingCallsPerTick,
  launchPrListingReserve: resolved.value.launchPrListingReserve,
  parkedPrListingCacheMinutes: resolved.value.parkedPrListingCacheMinutes,
  mergedGuardHours: resolved.value.mergedGuardHours,
  sources: {
    batchParallel: resolved.sources.batchParallel,
    batchMaxParallel: resolved.sources.batchMaxParallel,
    batchSize: resolved.sources.batchSize,
    aheadCount: resolved.sources.aheadCount,
    lightRevalidate: resolved.sources.lightRevalidate,
    lightRevalidateMaxDiffLines: resolved.sources.lightRevalidateMaxDiffLines,
    retryUnstampedOnce: resolved.sources.retryUnstampedOnce,
    autoSize: resolved.sources.autoSize,
    runner: resolved.sources.runner,
    maxPrListingCallsPerTick: resolved.sources.maxPrListingCallsPerTick,
    launchPrListingReserve: resolved.sources.launchPrListingReserve,
    parkedPrListingCacheMinutes: resolved.sources.parkedPrListingCacheMinutes,
    mergedGuardHours: resolved.sources.mergedGuardHours,
  },
});

/** PURE: invalid leaves are ignored independently at each layer. */
export function resolvePreparePolicy({ platform, tool, env = {} } = {}) {
  return result(resolveCascade({ standard, platform: block(platform), tool: block(tool), envValues: envValues(env), valid }));
}

/** IO: discover the feature file and let the shared cascade log the effective sources. */
export function readPreparePolicy({ env = process.env, read = readSettings } = {}) {
  let tool;
  try { tool = read()?.prepare; } catch { /* unreadable settings are an absent layer */ }
  return result(cascadePolicy('prepare', block(tool), { standard, platform: block(platformPreference('prepare', { env })), envValues: envValues(env), valid, env }));
}
