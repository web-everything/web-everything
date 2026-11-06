import { describe, it, expect } from 'vitest';
import { loadVerifyRecoverySettings } from '../verify-recovery-settings.mjs';

describe('verify recovery cascade', () => {
  const read = overrides => loadVerifyRecoverySettings({ tool: {}, platform: {}, env: {}, ...overrides });
  it('defaults to three retries, fifteen minutes, and a load-scaled ceiling', () => {
    const r = read();
    expect(r.value).toEqual({ loadRetry: { maxAttempts: 3 }, infraRetry: { maxAttempts: 3, backoffMinutes: 15 }, gateCeiling: 'load-scaled' });
    expect(r.sources['infraRetry.maxAttempts']).toBe('standard');
  });
  it('resolves independent leaves and reports their source', () => {
    const r = read({ platform: { infraRetry: { maxAttempts: 5, backoffMinutes: 20 } },
      tool: { infraRetry: { maxAttempts: 2 } }, env: { WE_VERIFY_GATE_CEILING: 'fixed' } });
    expect(r.value).toEqual({ loadRetry: { maxAttempts: 3 }, infraRetry: { maxAttempts: 2, backoffMinutes: 20 }, gateCeiling: 'fixed' });
    expect(r.sources).toMatchObject({ 'infraRetry.maxAttempts': 'tool', 'infraRetry.backoffMinutes': 'platform', gateCeiling: 'env' });
  });
  it('ignores invalid overrides, preserving the lower valid layer and allowing zero retries', () => {
    const r = read({ platform: { infraRetry: { maxAttempts: 0 } },
      tool: { infraRetry: { maxAttempts: -1, backoffMinutes: 'oops' }, gateCeiling: 'forever' } });
    expect(r.value).toEqual({ loadRetry: { maxAttempts: 3 }, infraRetry: { maxAttempts: 0, backoffMinutes: 15 }, gateCeiling: 'load-scaled' });
    expect(r.invalid).toHaveLength(3);
  });
});

it('load retry bounds resolve per layer, reject invalid values and allow disabling', () => {
  const read = (tool, platform = {}) => loadVerifyRecoverySettings({ tool, platform, env: {} });
  expect(read({}, { loadRetry: { maxAttempts: 5 } })).toMatchObject({ value: { loadRetry: { maxAttempts: 5 } }, sources: { 'loadRetry.maxAttempts': 'platform' } });
  expect(read({ loadRetry: { maxAttempts: 0 } }, { loadRetry: { maxAttempts: 5 } })).toMatchObject({ value: { loadRetry: { maxAttempts: 0 } }, sources: { 'loadRetry.maxAttempts': 'tool' } });
  for (const maxAttempts of [-1, 1.5, '3', Infinity]) expect(read({ loadRetry: { maxAttempts } }).value.loadRetry.maxAttempts).toBe(3);
});

it('environment load retry overrides win and invalid values fall back', () => {
  const read = value => loadVerifyRecoverySettings({ tool: { loadRetry: { maxAttempts: 2 } }, platform: {}, env: { WE_VERIFY_LOAD_RETRY_MAX_ATTEMPTS: value } });
  expect(read('1')).toMatchObject({ value: { loadRetry: { maxAttempts: 1 } }, sources: { loadRetry: 'env' } });
  for (const invalid of ['-1', 'oops', '1.5', '']) expect(read(invalid).value.loadRetry.maxAttempts).toBe(2);
});
