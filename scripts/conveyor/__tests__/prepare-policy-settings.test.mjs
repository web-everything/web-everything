import { describe, it, expect, vi } from 'vitest';
import { resetCascadeLogForTest } from '../../lib/policy-cascade.mjs';
import { resolvePreparePolicy, readPreparePolicy } from '../prepare-policy-settings.mjs';

describe('prepare policy cascade', () => {
  it('defaults booleans to true and runner to codex', () => {
    expect(resolvePreparePolicy()).toEqual({ retryUnstampedOnce: true, autoSize: true, runner: 'codex', mergedGuardHours: 24, maxPrListingCallsPerTick: 128,
      sources: { retryUnstampedOnce: 'standard', autoSize: 'standard', runner: 'standard', mergedGuardHours: 'standard', maxPrListingCallsPerTick: 'standard' } });
  });
  it('cascades mergedGuardHours with numeric validation and sources', () => {
    const env = { WE_PLATFORM_PREFERENCES_FILE: '/nonexistent/prepare-test.json' };
    expect(resolvePreparePolicy()).toMatchObject({ mergedGuardHours: 24, maxPrListingCallsPerTick: 128, sources: { mergedGuardHours: 'standard', maxPrListingCallsPerTick: 'standard' } });
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
        .toMatchObject({ mergedGuardHours: 24, maxPrListingCallsPerTick: 128, sources: { mergedGuardHours: 'standard', maxPrListingCallsPerTick: 'standard' } });
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
        .toMatchObject({ runner: 'codex', mergedGuardHours: 24, maxPrListingCallsPerTick: 128, sources: { runner: 'standard', mergedGuardHours: 'standard', maxPrListingCallsPerTick: 'standard' } });
    }
    expect(resolvePreparePolicy({ tool: { runner: 'claude' }, env: { WE_PREPARE_RUNNER: 'gpt' } }))
      .toMatchObject({ runner: 'claude', sources: { runner: 'tool' } });
  });
  it('layers each boolean independently', () => {
    expect(resolvePreparePolicy({ platform: { autoSize: false, retryUnstampedOnce: false },
      tool: { autoSize: true }, env: { WE_PREPARE_RETRY_UNSTAMPED_ONCE: '1', WE_PREPARE_AUTO_SIZE: '0' } }))
      .toEqual({ autoSize: false, retryUnstampedOnce: true, runner: 'codex', mergedGuardHours: 24, maxPrListingCallsPerTick: 128, sources: { autoSize: 'env', retryUnstampedOnce: 'env', runner: 'standard', mergedGuardHours: 'standard', maxPrListingCallsPerTick: 'standard' } });
    expect(resolvePreparePolicy({ platform: { autoSize: false }, tool: { retryUnstampedOnce: false } }).sources)
      .toEqual({ autoSize: 'platform', retryUnstampedOnce: 'tool', runner: 'standard', mergedGuardHours: 'standard', maxPrListingCallsPerTick: 'standard' });
  });
  it('ignores invalid values at their layer', () => {
    expect(resolvePreparePolicy({ platform: { autoSize: false, retryUnstampedOnce: 'false' },
      tool: { autoSize: 'true', retryUnstampedOnce: 0 }, env: { WE_PREPARE_AUTO_SIZE: 'oops' } }))
      .toEqual({ autoSize: false, retryUnstampedOnce: true, runner: 'codex', mergedGuardHours: 24, maxPrListingCallsPerTick: 128, sources: { autoSize: 'platform', retryUnstampedOnce: 'standard', runner: 'standard', mergedGuardHours: 'standard', maxPrListingCallsPerTick: 'standard' } });
    expect(resolvePreparePolicy({ env: { WE_PREPARE_AUTO_SIZE: 'false', WE_PREPARE_RETRY_UNSTAMPED_ONCE: 'true' } }).autoSize).toBe(false);
  });
  it('uses the cascade source logger', () => {
    resetCascadeLogForTest();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      readPreparePolicy({ env: { WE_PLATFORM_PREFERENCES_FILE: '/nonexistent/prepare-test.json',
        WE_POLICY_CASCADE_LOG: '1', WE_PREPARE_AUTO_SIZE: 'false' }, read: () => ({ prepare: { retryUnstampedOnce: false } }) });
      expect(log).toHaveBeenCalledWith('policy-cascade · prepare: retryUnstampedOnce=false (tool), runner="codex" (standard), mergedGuardHours=24 (standard), maxPrListingCallsPerTick=128 (standard), autoSize=false (env)');
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
