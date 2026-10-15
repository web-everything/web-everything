import { describe, it, expect, vi } from 'vitest';
import { resetCascadeLogForTest } from '../../lib/policy-cascade.mjs';
import { resolvePreparePolicy, readPreparePolicy } from '../prepare-policy-settings.mjs';

describe('prepare policy cascade', () => {
  it('defaults booleans to true and runner to codex', () => {
    expect(resolvePreparePolicy()).toEqual({ retryUnstampedOnce: true, autoSize: true, runner: 'codex',
      sources: { retryUnstampedOnce: 'standard', autoSize: 'standard', runner: 'standard' } });
  });
  it('cascades runner independently with exact validation', () => {
    expect(resolvePreparePolicy({ platform: { runner: 'scope' }, tool: { runner: 'claude' } }))
      .toMatchObject({ runner: 'claude', sources: { runner: 'tool' } });
    expect(resolvePreparePolicy({ tool: { runner: 'claude' }, env: { WE_PREPARE_RUNNER: 'scope' } }))
      .toMatchObject({ runner: 'scope', sources: { runner: 'env' } });
    for (const runner of ['gpt', 'Codex', ' codex ', true, {}]) {
      expect(resolvePreparePolicy({ platform: { runner }, tool: { runner }, env: { WE_PREPARE_RUNNER: runner } }))
        .toMatchObject({ runner: 'codex', sources: { runner: 'standard' } });
    }
    expect(resolvePreparePolicy({ tool: { runner: 'claude' }, env: { WE_PREPARE_RUNNER: 'gpt' } }))
      .toMatchObject({ runner: 'claude', sources: { runner: 'tool' } });
  });
  it('layers each boolean independently', () => {
    expect(resolvePreparePolicy({ platform: { autoSize: false, retryUnstampedOnce: false },
      tool: { autoSize: true }, env: { WE_PREPARE_RETRY_UNSTAMPED_ONCE: '1', WE_PREPARE_AUTO_SIZE: '0' } }))
      .toEqual({ autoSize: false, retryUnstampedOnce: true, runner: 'codex', sources: { autoSize: 'env', retryUnstampedOnce: 'env', runner: 'standard' } });
    expect(resolvePreparePolicy({ platform: { autoSize: false }, tool: { retryUnstampedOnce: false } }).sources)
      .toEqual({ autoSize: 'platform', retryUnstampedOnce: 'tool', runner: 'standard' });
  });
  it('ignores invalid values at their layer', () => {
    expect(resolvePreparePolicy({ platform: { autoSize: false, retryUnstampedOnce: 'false' },
      tool: { autoSize: 'true', retryUnstampedOnce: 0 }, env: { WE_PREPARE_AUTO_SIZE: 'oops' } }))
      .toEqual({ autoSize: false, retryUnstampedOnce: true, runner: 'codex', sources: { autoSize: 'platform', retryUnstampedOnce: 'standard', runner: 'standard' } });
    expect(resolvePreparePolicy({ env: { WE_PREPARE_AUTO_SIZE: 'false', WE_PREPARE_RETRY_UNSTAMPED_ONCE: 'true' } }).autoSize).toBe(false);
  });
  it('uses the cascade source logger', () => {
    resetCascadeLogForTest();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      readPreparePolicy({ env: { WE_PLATFORM_PREFERENCES_FILE: '/nonexistent/prepare-test.json',
        WE_POLICY_CASCADE_LOG: '1', WE_PREPARE_AUTO_SIZE: 'false' }, read: () => ({ prepare: { retryUnstampedOnce: false } }) });
      expect(log).toHaveBeenCalledWith('policy-cascade · prepare: retryUnstampedOnce=false (tool), runner="codex" (standard), autoSize=false (env)');
    } finally { log.mockRestore(); resetCascadeLogForTest(); }
  });
  it('reads the feature block and tolerates unreadable settings', () => {
    const env = { WE_PLATFORM_PREFERENCES_FILE: '/nonexistent/prepare-test.json' };
    expect(readPreparePolicy({ env, read: () => ({ prepare: { autoSize: false, runner: 'claude' } }) }))
      .toMatchObject({ runner: 'claude', sources: { autoSize: 'tool', runner: 'tool' } });
    expect(readPreparePolicy({ env, read: () => { throw Error('unreadable'); } }).autoSize).toBe(true);
  });
});
