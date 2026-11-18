import { describe, it, expect, vi } from 'vitest';
import { resetCascadeLogForTest } from '../../lib/policy-cascade.mjs';
import { resolvePreparePolicy, readPreparePolicy } from '../prepare-policy-settings.mjs';

describe('prepare policy cascade', () => {
  it('defaults booleans to true and runner to codex', () => {
    expect(resolvePreparePolicy()).toEqual({ batchParallel: true, batchMaxParallel: 3, batchSize: 6, aheadCount: 20, lightRevalidate: true, lightRevalidateMaxDiffLines: 400, retryUnstampedOnce: true, autoSize: true, runner: 'codex', mergedGuardHours: 24, maxPrListingCallsPerTick: 128, launchPrListingReserve: 32, parkedPrListingCacheMinutes: 15,
      sources: { batchParallel: 'standard', batchMaxParallel: 'standard', batchSize: 'standard', aheadCount: 'standard', lightRevalidate: 'standard', lightRevalidateMaxDiffLines: 'standard', retryUnstampedOnce: 'standard', autoSize: 'standard', runner: 'standard', mergedGuardHours: 'standard', maxPrListingCallsPerTick: 'standard', launchPrListingReserve: 'standard', parkedPrListingCacheMinutes: 'standard' } });
  });
  it('cascades the launch listing reserve and parked listing TTL with validation and sources', () => {
    expect(resolvePreparePolicy({ tool: { launchPrListingReserve: 8, parkedPrListingCacheMinutes: 30 } }))
      .toMatchObject({ launchPrListingReserve: 8, parkedPrListingCacheMinutes: 30, sources: { launchPrListingReserve: 'tool', parkedPrListingCacheMinutes: 'tool' } });
    expect(resolvePreparePolicy({ tool: { launchPrListingReserve: -1, parkedPrListingCacheMinutes: 'x' } }))
      .toMatchObject({ launchPrListingReserve: 32, parkedPrListingCacheMinutes: 15 });
    expect(resolvePreparePolicy({ env: { WE_PREPARE_LAUNCH_PR_LISTING_RESERVE: '4', WE_PREPARE_PARKED_PR_LISTING_CACHE_MINUTES: '0' } }))
      .toMatchObject({ launchPrListingReserve: 4, parkedPrListingCacheMinutes: 0, sources: { launchPrListingReserve: 'env', parkedPrListingCacheMinutes: 'env' } });
  });
  it('cascades mergedGuardHours with numeric validation and sources', () => {
    const env = { WE_PLATFORM_PREFERENCES_FILE: '/nonexistent/prepare-test.json' };
    expect(resolvePreparePolicy()).toMatchObject({ mergedGuardHours: 24, maxPrListingCallsPerTick: 128, launchPrListingReserve: 32, parkedPrListingCacheMinutes: 15, sources: { mergedGuardHours: 'standard', maxPrListingCallsPerTick: 'standard', launchPrListingReserve: 'standard', parkedPrListingCacheMinutes: 'standard' } });
    expect(resolvePreparePolicy({ platform: { mergedGuardHours: 48 } }))
      .toMatchObject({ mergedGuardHours: 48, sources: { mergedGuardHours: 'platform' } });
    expect(readPreparePolicy({ env, read: () => ({ prepare: { mergedGuardHours: 12 } }) }))
      .toMatchObject({ mergedGuardHours: 12, sources: { mergedGuardHours: 'tool' } });
    expect(resolvePreparePolicy({ platform: { mergedGuardHours: 48 }, tool: { mergedGuardHours: 12 } }))
      .toMatchObject({ mergedGuardHours: 12, sources: { mergedGuardHours: 'tool' } });
    for (const hours of ['0', '1.5', '72']) {
      expect(readPreparePolicy({ env: { ...env, WE_PREPARE_MERGED_GUARD_HOURS: hours },
        read: () => ({ prepare: { mergedGuardHours: 12 } }) }))
        .toMatchObject({ mergedGuardHours: Number(hours), sources: { mergedGuardHours: 'env' } });
    }
    for (const hours of [-1, Infinity, NaN, '12', true, null, {}]) {
      expect(resolvePreparePolicy({ platform: { mergedGuardHours: hours }, tool: { mergedGuardHours: hours } }))
        .toMatchObject({ mergedGuardHours: 24, maxPrListingCallsPerTick: 128, launchPrListingReserve: 32, parkedPrListingCacheMinutes: 15, sources: { mergedGuardHours: 'standard', maxPrListingCallsPerTick: 'standard', launchPrListingReserve: 'standard', parkedPrListingCacheMinutes: 'standard' } });
    }
    for (const hours of ['-1', 'Infinity', 'NaN', 'oops', '', ' ']) {
      expect(resolvePreparePolicy({ tool: { mergedGuardHours: 12 }, env: { WE_PREPARE_MERGED_GUARD_HOURS: hours } }))
        .toMatchObject({ mergedGuardHours: 12, sources: { mergedGuardHours: 'tool' } });
    }
  });
  it('cascades runner independently with exact validation', () => {
    expect(resolvePreparePolicy({ platform: { runner: 'scope' }, tool: { runner: 'claude' } }))
      .toMatchObject({ runner: 'claude', sources: { runner: 'tool' } });
    expect(resolvePreparePolicy({ tool: { runner: 'claude' }, env: { WE_PREPARE_RUNNER: 'scope' } }))
      .toMatchObject({ runner: 'scope', sources: { runner: 'env' } });
    for (const runner of ['gpt', 'Codex', ' codex ', true, {}]) {
      expect(resolvePreparePolicy({ platform: { runner }, tool: { runner }, env: { WE_PREPARE_RUNNER: runner } }))
        .toMatchObject({ runner: 'codex', mergedGuardHours: 24, maxPrListingCallsPerTick: 128, launchPrListingReserve: 32, parkedPrListingCacheMinutes: 15, sources: { runner: 'standard', mergedGuardHours: 'standard', maxPrListingCallsPerTick: 'standard', launchPrListingReserve: 'standard', parkedPrListingCacheMinutes: 'standard' } });
    }
    expect(resolvePreparePolicy({ tool: { runner: 'claude' }, env: { WE_PREPARE_RUNNER: 'gpt' } }))
      .toMatchObject({ runner: 'claude', sources: { runner: 'tool' } });
  });
  it('layers each boolean independently', () => {
    expect(resolvePreparePolicy({ platform: { autoSize: false, retryUnstampedOnce: false },
      tool: { autoSize: true }, env: { WE_PREPARE_RETRY_UNSTAMPED_ONCE: '1', WE_PREPARE_AUTO_SIZE: '0' } }))
      .toEqual({ batchParallel: true, batchMaxParallel: 3, batchSize: 6, aheadCount: 20, lightRevalidate: true, lightRevalidateMaxDiffLines: 400, autoSize: false, retryUnstampedOnce: true, runner: 'codex', mergedGuardHours: 24, maxPrListingCallsPerTick: 128, launchPrListingReserve: 32, parkedPrListingCacheMinutes: 15, sources: { batchParallel: 'standard', batchMaxParallel: 'standard', batchSize: 'standard', aheadCount: 'standard', lightRevalidate: 'standard', lightRevalidateMaxDiffLines: 'standard', autoSize: 'env', retryUnstampedOnce: 'env', runner: 'standard', mergedGuardHours: 'standard', maxPrListingCallsPerTick: 'standard', launchPrListingReserve: 'standard', parkedPrListingCacheMinutes: 'standard' } });
    expect(resolvePreparePolicy({ platform: { autoSize: false }, tool: { retryUnstampedOnce: false } }).sources)
      .toEqual({ batchParallel: 'standard', batchMaxParallel: 'standard', batchSize: 'standard', aheadCount: 'standard', lightRevalidate: 'standard', lightRevalidateMaxDiffLines: 'standard', autoSize: 'platform', retryUnstampedOnce: 'tool', runner: 'standard', mergedGuardHours: 'standard', maxPrListingCallsPerTick: 'standard', launchPrListingReserve: 'standard', parkedPrListingCacheMinutes: 'standard' });
  });
  it('ignores invalid values at their layer', () => {
    expect(resolvePreparePolicy({ platform: { autoSize: false, retryUnstampedOnce: 'false' },
      tool: { autoSize: 'true', retryUnstampedOnce: 0 }, env: { WE_PREPARE_AUTO_SIZE: 'oops' } }))
      .toEqual({ batchParallel: true, batchMaxParallel: 3, batchSize: 6, aheadCount: 20, lightRevalidate: true, lightRevalidateMaxDiffLines: 400, autoSize: false, retryUnstampedOnce: true, runner: 'codex', mergedGuardHours: 24, maxPrListingCallsPerTick: 128, launchPrListingReserve: 32, parkedPrListingCacheMinutes: 15, sources: { batchParallel: 'standard', batchMaxParallel: 'standard', batchSize: 'standard', aheadCount: 'standard', lightRevalidate: 'standard', lightRevalidateMaxDiffLines: 'standard', autoSize: 'platform', retryUnstampedOnce: 'standard', runner: 'standard', mergedGuardHours: 'standard', maxPrListingCallsPerTick: 'standard', launchPrListingReserve: 'standard', parkedPrListingCacheMinutes: 'standard' } });
    expect(resolvePreparePolicy({ env: { WE_PREPARE_AUTO_SIZE: 'false', WE_PREPARE_RETRY_UNSTAMPED_ONCE: 'true' } }).autoSize).toBe(false);
  });
  it('uses the cascade source logger', () => {
    resetCascadeLogForTest();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      readPreparePolicy({ env: { WE_PLATFORM_PREFERENCES_FILE: '/nonexistent/prepare-test.json',
        WE_POLICY_CASCADE_LOG: '1', WE_PREPARE_AUTO_SIZE: 'false' }, read: () => ({ prepare: { retryUnstampedOnce: false } }) });
      expect(log).toHaveBeenCalledWith('policy-cascade · prepare: batchParallel=true (standard), batchMaxParallel=3 (standard), batchSize=6 (standard), aheadCount=20 (standard), lightRevalidate=true (standard), lightRevalidateMaxDiffLines=400 (standard), retryUnstampedOnce=false (tool), runner="codex" (standard), mergedGuardHours=24 (standard), maxPrListingCallsPerTick=128 (standard), launchPrListingReserve=32 (standard), parkedPrListingCacheMinutes=15 (standard), autoSize=false (env)');
    } finally { log.mockRestore(); resetCascadeLogForTest(); }
  });
  it('reads the feature block and tolerates unreadable settings', () => {
    const env = { WE_PLATFORM_PREFERENCES_FILE: '/nonexistent/prepare-test.json' };
    expect(readPreparePolicy({ env, read: () => ({ prepare: { autoSize: false, runner: 'claude' } }) }))
      .toMatchObject({ runner: 'claude', sources: { autoSize: 'tool', runner: 'tool' } });
    expect(readPreparePolicy({ env, read: () => { throw Error('unreadable'); } }).autoSize).toBe(true);
  });
});


it('cascades and logs the bounded prepare listing budget', () => {
  expect(resolvePreparePolicy({ platform: { maxPrListingCallsPerTick: 40 } }))
    .toMatchObject({ maxPrListingCallsPerTick: 40, sources: { maxPrListingCallsPerTick: 'platform' } });
  expect(resolvePreparePolicy({ tool: { maxPrListingCallsPerTick: 20 } }))
    .toMatchObject({ maxPrListingCallsPerTick: 20, sources: { maxPrListingCallsPerTick: 'tool' } });
  expect(resolvePreparePolicy({ tool: { maxPrListingCallsPerTick: 20 }, env: { WE_PREPARE_MAX_PR_LISTING_CALLS_PER_TICK: '12' } }))
    .toMatchObject({ maxPrListingCallsPerTick: 12, sources: { maxPrListingCallsPerTick: 'env' } });
  for (const value of [-1, 1.5, Infinity, '20', null]) expect(resolvePreparePolicy({ tool: { maxPrListingCallsPerTick: value } }).maxPrListingCallsPerTick).toBe(128);
});

it('cascades batch and JIT limits independently, rejecting malformed limits', () => {
  expect(resolvePreparePolicy()).toMatchObject({ batchSize: 6, aheadCount: 20 });
  expect(resolvePreparePolicy({ platform: { batchSize: 8, aheadCount: 30 }, tool: { batchSize: 4 }, env: { WE_PREPARE_AHEAD_COUNT: '12' } }))
    .toMatchObject({ batchSize: 4, aheadCount: 12, sources: { batchSize: 'tool', aheadCount: 'env' } });
  for (const value of [-1, 1.5, {}, '6', null]) expect(resolvePreparePolicy({ tool: { batchSize: value, aheadCount: value } }))
    .toMatchObject({ batchSize: 6, aheadCount: 20 });
  expect(resolvePreparePolicy({ env: { WE_PREPARE_BATCH_SIZE: '1', WE_PREPARE_AHEAD_COUNT: '0' } }))
    .toMatchObject({ batchSize: 1, aheadCount: 0, sources: { batchSize: 'env', aheadCount: 'env' } });
});

it('cascades isolated batch settings and logs their sources', () => {
  expect(resolvePreparePolicy()).toMatchObject({ batchParallel: true, batchMaxParallel: 3 });
  expect(resolvePreparePolicy({ platform: { batchParallel: false, batchMaxParallel: 8 },
    tool: { batchMaxParallel: 2 } })).toMatchObject({ batchParallel: false, batchMaxParallel: 2,
      sources: { batchParallel: 'platform', batchMaxParallel: 'tool' } });
  expect(resolvePreparePolicy({ tool: { batchParallel: false }, env: {
    WE_PREPARE_BATCH_PARALLEL: 'true', WE_PREPARE_BATCH_MAX_PARALLEL: '5' } }))
    .toMatchObject({ batchParallel: true, batchMaxParallel: 5, sources: { batchParallel: 'env', batchMaxParallel: 'env' } });
  for (const value of [0, -1, 1.5, '3', null]) expect(resolvePreparePolicy({ tool: { batchMaxParallel: value } }).batchMaxParallel).toBe(3);
  resetCascadeLogForTest();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  readPreparePolicy({ env: { WE_POLICY_CASCADE_LOG: '1', WE_PLATFORM_PREFERENCES_FILE: '/nonexistent/batch.json' }, read: () => ({ prepare: { batchParallel: false } }) });
  expect(log.mock.calls.flat().join(' ')).toMatch(/batchParallel=false.*tool/);
  expect(log.mock.calls.flat().join(' ')).toMatch(/batchMaxParallel=3.*standard/);
  log.mockRestore();
});

it('cascades light revalidation switches and validates the diff cap with sources', () => {
  expect(resolvePreparePolicy()).toMatchObject({ lightRevalidate: true, lightRevalidateMaxDiffLines: 400,
    sources: { lightRevalidate: 'standard', lightRevalidateMaxDiffLines: 'standard' } });
  expect(resolvePreparePolicy({ platform: { lightRevalidate: false, lightRevalidateMaxDiffLines: 200 } }))
    .toMatchObject({ lightRevalidate: false, lightRevalidateMaxDiffLines: 200,
      sources: { lightRevalidate: 'platform', lightRevalidateMaxDiffLines: 'platform' } });
  expect(resolvePreparePolicy({ tool: { lightRevalidate: false, lightRevalidateMaxDiffLines: 100 } }))
    .toMatchObject({ sources: { lightRevalidate: 'tool', lightRevalidateMaxDiffLines: 'tool' } });
  expect(resolvePreparePolicy({ tool: { lightRevalidate: false, lightRevalidateMaxDiffLines: 100 },
    env: { WE_PREPARE_LIGHT_REVALIDATE: 'true', WE_PREPARE_LIGHT_REVALIDATE_MAX_DIFF_LINES: '0' } }))
    .toMatchObject({ lightRevalidate: true, lightRevalidateMaxDiffLines: 0,
      sources: { lightRevalidate: 'env', lightRevalidateMaxDiffLines: 'env' } });
  for (const cap of [-1, 1.5, Infinity, '400', null]) {
    expect(resolvePreparePolicy({ tool: { lightRevalidateMaxDiffLines: cap } }).lightRevalidateMaxDiffLines).toBe(400);
  }
});
