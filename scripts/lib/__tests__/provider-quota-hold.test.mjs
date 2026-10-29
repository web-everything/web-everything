import { describe, expect, it } from 'vitest';
import * as quota from '../provider-quota-hold.mjs';

const now = Date.parse('2026-10-29T08:00:00Z');
const providerMessages = [
  "You've hit your weekly limit · resets Oct 30 at 4pm (America/Toronto)",
  "You've hit your daily limit · resets tomorrow",
  "You've hit your monthly limit · resets Nov 1",
  "You've hit your usage limit",
  "You've hit your session limit",
  "You've hit your hourly limit",
  "You've hit your 5-hour limit",
  'You exceeded your current quota',
];
const structuredRateLimit = '{"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded"}}';
const quotaErrors = [
  ...providerMessages,
  ...['rate_limit_error', 'insufficient_quota'].flatMap(type => [
    { type },
    { error: { type } },
    { type: 'error', error: { type, message: 'Request failed' } },
  ].flatMap(payload => ['', 'API Error: 429 ', 'API Error: 400 ']
    .map(prefix => `${prefix}${JSON.stringify(payload)}`))),
];
// Former positives deliberately moved here: free text and arbitrary wrappers fail closed.
const droppedQuotaErrors = [
  '429 Too Many Requests', 'HTTP 429 Too Many Requests',
  '429 rate_limit_error', '429 rate_limit_error Rate limit exceeded',
  'status 429 Too Many Requests', 'rate_limit_error', 'insufficient_quota',
  'RESOURCE_EXHAUSTED: Quota exceeded',
  ...['rate_limit_error', 'insufficient_quota'].map(type => `error type: ${type}`),
  ...['API Error: ', 'Error: ', '429 ', 'API Error: 429 ', 'Error: 429 ']
    .flatMap(prefix => providerMessages.map(message => `${prefix}${message}`)),
  ...['429 ', 'Error: 429 '].map(prefix => `${prefix}${structuredRateLimit}`),
  'API Error: 429 rate_limit_error',
];
const ordinaryErrors = [
  ...droppedQuotaErrors,
  '',
  '429 Rate limit exceeded', 'HTTP 429: Too Many Requests',
  'rate limit exceeded', 'Too Many Requests',
  ...['rate_limit_error', 'insufficient_quota'].flatMap(type => [
    JSON.stringify({ message: type }),
    JSON.stringify({ error: { message: type } }),
    JSON.stringify([{ type }]),
    JSON.stringify({ type: `${type}_config` }),
    JSON.stringify({ type: type.toUpperCase() }),
    JSON.stringify({ error: { type: `${type} ` } }),
    JSON.stringify({ error: { type: [type] } }),
    JSON.stringify(type),
    `{"type":"${type}"`,
    `{"type":"${type}"} trailing diagnostic`,
    `diagnostic {"type":"${type}"}`,
  ]),
  '{}', 'null', '[]',
  ...['Error: ', 'API Error: ', 'HTTP 429 ', 'API Error: nope ']
    .map(prefix => `${prefix}${structuredRateLimit}`),
  "You've hit your limit of 2 repair rounds",
  "You've hit your limit",
  'schema invalid', 'the juror failed with no result text',
  'HTTP 429 fixture failed: expected 429, received 500',
  'HTTP 429', 'HTTP 429 request failed', 'status 429 fixture',
  '429', '429 fixture failed',
  'disk quota exceeded on /tmp', 'schema invalid at line 429',
  'port 4290 refused', 'quota-check script crashed',
  'rate_limit', 'rate limit', 'too many requests', 'usage limit reached',
  ...['', 'API Error: ', 'Error: ', '429 ', 'API Error: 429 ', 'Error: 429 ']
    .map(prefix => `${prefix}Usage limit reached`),
  'rate limit must be a positive integer',
  'too many requests configured: expected at most 10',
  'Rate limit is configured wrong',
  'usage limit reached for your plan setting (config error)',
  ...['rate_limit_error_config', 'insufficient_quota_config', 'rate_limit'].flatMap(type => [
    `error type: ${type}`,
    JSON.stringify({ type: 'error', error: { type, message: 'Invalid configuration' } }),
  ]),
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

  it.each(ordinaryErrors)('fails closed without structural provider evidence: %s', text => {
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
