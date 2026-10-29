import { describe, expect, it } from 'vitest';
import * as quota from '../provider-quota-hold.mjs';

const now = Date.parse('2026-10-29T08:00:00Z');
const providerMessages = [
  "You've hit your weekly limit · resets Oct 30 at 4pm (America/Toronto)",
  "You've hit your usage limit",
  'Usage limit reached',
  'You exceeded your current quota',
];
const structuredRateLimit = '429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded"}}';
const quotaErrors = [
  "You've hit your weekly limit · resets ...",
  "You've hit your weekly limit · resets Oct 30",
  'HTTP 429', 'status 429 Too Many Requests', 'rate_limit', 'rate_limit_error',
  'rate limit', 'too many requests', 'usage limit reached', 'insufficient_quota',
  ...['', 'API Error: ', 'Error: ', '429 ', 'API Error: 429 ', 'Error: 429 ']
    .flatMap(prefix => providerMessages.map(message => `${prefix}${message}`)),
  structuredRateLimit, `API Error: ${structuredRateLimit}`, `Error: ${structuredRateLimit}`,
  'API Error: 429 rate_limit_error',
];
const ordinaryErrors = [
  'schema invalid', 'the juror failed with no result text',
  'disk quota exceeded on /tmp', 'schema invalid at line 429',
  'port 4290 refused', 'quota-check script crashed',
  // A resource failure or incidental keyword is not provider quota evidence.
  'RESOURCE_EXHAUSTED', 'RESOURCE_EXHAUSTED: Out of memory',
  'TypeError: rate limit is not a function',
  'build log mentions HTTP 429 in a fixture', 'disk quota exceeded',
  ...providerMessages.map(message => `build log mentions ${message} in a fixture`),
  `build log mentions ${structuredRateLimit} in a fixture`,
  'build log mentions API Error: 429 rate_limit_error in a fixture',
];

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
