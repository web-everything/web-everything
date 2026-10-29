import { describe, expect, it } from 'vitest';
import * as quota from '../provider-quota-hold.mjs';

const now = Date.parse('2026-10-29T08:00:00Z');
const quotaErrors = [
  "You've hit your weekly limit · resets ...",
  'HTTP 429', 'rate_limit', 'rate limit', 'too many requests',
];
const ordinaryErrors = ['schema invalid', 'the juror failed with no result text'];

describe('quota error evidence', () => {
  it.each(quotaErrors)('recognizes quota exhaustion: %s', text => {
    expect(quota.isQuotaError, 'isQuotaError export').toBeTypeOf('function');
    expect(quota.isQuotaError(text)).toBe(true);
  });

  it.each(ordinaryErrors)('keeps ordinary juror failures countable: %s', text => {
    expect(quota.isQuotaError, 'isQuotaError export').toBeTypeOf('function');
    expect(quota.isQuotaError(text)).toBe(false);
  });

  it.each(quotaErrors)('creates a timestamped hold row without inventing a reset: %s', error => {
    expect(quota.quotaHoldRow, 'quotaHoldRow export').toBeTypeOf('function');
    expect(quota.quotaHoldRow({ provider: 'claude', error, now })).toEqual({
      provider: 'claude', status: 'quota-exhausted',
      scoredAt: new Date(now).toISOString(), quotaResetsAt: null,
    });
  });

  it.each(ordinaryErrors)('does not create a quota row for %s', error => {
    expect(quota.quotaHoldRow, 'quotaHoldRow export').toBeTypeOf('function');
    expect(quota.quotaHoldRow({ provider: 'claude', error, now })).toBeNull();
  });

  it('holds an unparseable reset for exactly QUOTA_COOLOFF_MS, scoped to its provider', () => {
    expect(quota.quotaHoldRow, 'quotaHoldRow export').toBeTypeOf('function');
    const row = quota.quotaHoldRow({ provider: 'claude', error: quotaErrors[0], now });
    expect(quota.providerQuotaHold([row], 'claude', now)).toEqual(expect.any(String));
    expect(quota.providerQuotaHold([row], 'claude', now + quota.QUOTA_COOLOFF_MS - 1)).toEqual(expect.any(String));
    expect(quota.providerQuotaHold([row], 'claude', now + quota.QUOTA_COOLOFF_MS)).toBeNull();
    expect(quota.providerQuotaHold([row], 'codex', now)).toBeNull();
  });
});
