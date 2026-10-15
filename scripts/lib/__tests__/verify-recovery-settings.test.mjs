import { describe, it, expect } from 'vitest';
import { loadVerifyRecoverySettings } from '../verify-recovery-settings.mjs';

describe('verify recovery cascade', () => {
  const read = overrides => loadVerifyRecoverySettings({ tool: {}, platform: {}, env: {}, ...overrides });
  it('defaults to three retries, fifteen minutes, and a load-scaled ceiling', () => {
    const r = read();
    expect(r.value).toEqual({ infraRetry: { maxAttempts: 3, backoffMinutes: 15 }, gateCeiling: 'load-scaled' });
    expect(r.sources['infraRetry.maxAttempts']).toBe('standard');
  });
  it('resolves independent leaves and reports their source', () => {
    const r = read({ platform: { infraRetry: { maxAttempts: 5, backoffMinutes: 20 } },
      tool: { infraRetry: { maxAttempts: 2 } }, env: { WE_VERIFY_GATE_CEILING: 'fixed' } });
    expect(r.value).toEqual({ infraRetry: { maxAttempts: 2, backoffMinutes: 20 }, gateCeiling: 'fixed' });
    expect(r.sources).toMatchObject({ 'infraRetry.maxAttempts': 'tool', 'infraRetry.backoffMinutes': 'platform', gateCeiling: 'env' });
  });
  it('ignores invalid overrides, preserving the lower valid layer and allowing zero retries', () => {
    const r = read({ platform: { infraRetry: { maxAttempts: 0 } },
      tool: { infraRetry: { maxAttempts: -1, backoffMinutes: 'oops' }, gateCeiling: 'forever' } });
    expect(r.value).toEqual({ infraRetry: { maxAttempts: 0, backoffMinutes: 15 }, gateCeiling: 'load-scaled' });
    expect(r.invalid).toHaveLength(3);
  });
});
