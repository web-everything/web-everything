import { describe, it, expect, vi } from 'vitest';
import { resetCascadeLogForTest } from '../../lib/policy-cascade.mjs';
import { resolvePreparePolicy, readPreparePolicy } from '../prepare-policy-settings.mjs';

describe('prepare policy cascade', () => {
  it('defaults both leaves to standard true', () => {
    expect(resolvePreparePolicy()).toEqual({ retryUnstampedOnce: true, autoSize: true,
      sources: { retryUnstampedOnce: 'standard', autoSize: 'standard' } });
  });
  it('layers each boolean independently', () => {
    expect(resolvePreparePolicy({ platform: { autoSize: false, retryUnstampedOnce: false },
      tool: { autoSize: true }, env: { WE_PREPARE_RETRY_UNSTAMPED_ONCE: '1', WE_PREPARE_AUTO_SIZE: '0' } }))
      .toEqual({ autoSize: false, retryUnstampedOnce: true, sources: { autoSize: 'env', retryUnstampedOnce: 'env' } });
    expect(resolvePreparePolicy({ platform: { autoSize: false }, tool: { retryUnstampedOnce: false } }).sources)
      .toEqual({ autoSize: 'platform', retryUnstampedOnce: 'tool' });
  });
  it('ignores invalid values at their layer', () => {
    expect(resolvePreparePolicy({ platform: { autoSize: false, retryUnstampedOnce: 'false' },
      tool: { autoSize: 'true', retryUnstampedOnce: 0 }, env: { WE_PREPARE_AUTO_SIZE: 'oops' } }))
      .toEqual({ autoSize: false, retryUnstampedOnce: true, sources: { autoSize: 'platform', retryUnstampedOnce: 'standard' } });
    expect(resolvePreparePolicy({ env: { WE_PREPARE_AUTO_SIZE: 'false', WE_PREPARE_RETRY_UNSTAMPED_ONCE: 'true' } }).autoSize).toBe(false);
  });
  it('uses the cascade source logger', () => {
    resetCascadeLogForTest();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      readPreparePolicy({ env: { WE_PLATFORM_PREFERENCES_FILE: '/nonexistent/prepare-test.json',
        WE_POLICY_CASCADE_LOG: '1', WE_PREPARE_AUTO_SIZE: 'false' }, read: () => ({ prepare: { retryUnstampedOnce: false } }) });
      expect(log).toHaveBeenCalledWith('policy-cascade · prepare: retryUnstampedOnce=false (tool), autoSize=false (env)');
    } finally { log.mockRestore(); resetCascadeLogForTest(); }
  });
  it('reads the feature block and tolerates unreadable settings', () => {
    const env = { WE_PLATFORM_PREFERENCES_FILE: '/nonexistent/prepare-test.json' };
    expect(readPreparePolicy({ env, read: () => ({ prepare: { autoSize: false } }) }).sources.autoSize).toBe('tool');
    expect(readPreparePolicy({ env, read: () => { throw Error('unreadable'); } }).autoSize).toBe(true);
  });
});
