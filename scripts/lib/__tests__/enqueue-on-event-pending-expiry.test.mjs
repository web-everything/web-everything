/**
 * RED contract for enqueue-on-event.mjs (existing exports, extended behavior):
 * - planCatchUp accepts pendingSince: Map<num, epochMs> and
 *   pendingExpiryMinutes (default ENQUEUE_ON_EVENT_DEFAULTS.catchUp.pendingExpiryMinutes).
 *   Pending age strictly greater than expiry removes ONLY the 'already pending'
 *   veto; ordinary eligibility, ordering and capacity still apply. The returned
 *   expired:number[] lists expired pending PRs from this listing, in listing order.
 *   Missing timestamps are fresh (including persisted pre-timestamp state).
 * - ENQUEUE_ON_EVENT_DEFAULTS.catchUp.pendingExpiryMinutes is 15.
 * - resolveEnqueueOnEventSetting validates finite positive numeric expiry values
 *   through the existing policy cascade, with effective value/source in line.
 * Hermetic: explicit clocks, policy layers and inputs; no daemon, gh or network.
 */
import { describe, it, expect } from 'vitest';
import {
  planCatchUp, ENQUEUE_ON_EVENT_DEFAULTS, resolveEnqueueOnEventSetting,
} from '../enqueue-on-event.mjs';

const MINUTE = 60_000;
const NOW = 100 * MINUTE;
const candidate = (num, extra = {}) => ({
  num, readyAt: num, firstAcceptedAt: num, isDraft: false, inQueue: false,
  labels: [{ name: 'ready-to-merge' }, { name: 'review:accepted' }],
  baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', ...extra,
});
const plan = (extra = {}) => planCatchUp({
  prs: [candidate(42)], queued: 0, capacity: 3, repo: 'example/web',
  now: NOW, pendingNums: [42], pendingSince: new Map([[42, NOW - 80 * MINUTE]]), ...extra,
});
const resolve = (tool = {}, platform = {}) => resolveEnqueueOnEventSetting({ env: {}, tool, platform });

describe('catch-up releases expired unsuccessful pending entries', () => {
  it('reconsiders an 80-minute pending CLEAN approved PR and reports its expired number', () => {
    expect(plan()).toMatchObject({ run: [{ num: 42, readyAt: 42 }], skipped: [], later: [], expired: [42] });
  });

  it('keeps a fresh pending PR skipped as already pending', () => {
    expect(plan({ pendingSince: new Map([[42, NOW - 14 * MINUTE]]) }))
      .toMatchObject({ run: [], skipped: [{ num: 42, reason: 'already pending' }], expired: [] });
  });

  it('uses a strict expiry boundary: exactly N minutes stays pending, one ms older retries', () => {
    const since = NOW - 5 * MINUTE;
    expect(plan({ pendingExpiryMinutes: 5, pendingSince: new Map([[42, since]]) }))
      .toMatchObject({ run: [], skipped: [{ num: 42, reason: 'already pending' }], expired: [] });
    expect(plan({ pendingExpiryMinutes: 5, pendingSince: new Map([[42, since - 1]]) }))
      .toMatchObject({ run: [{ num: 42, readyAt: 42 }], skipped: [], expired: [42] });
  });

  it('fails closed for persisted pending numbers without pendingSince (no retry storm)', () => {
    expect(plan({ pendingSince: undefined })).toMatchObject({
      run: [], skipped: [{ num: 42, reason: 'already pending' }], expired: [],
    });
    expect(plan({ pendingSince: new Map() })).toMatchObject({
      run: [], skipped: [{ num: 42, reason: 'already pending' }], expired: [],
    });
  });

  it('accepts epoch zero as a timestamp rather than treating it as missing', () => {
    expect(plan({ now: 16 * MINUTE, pendingSince: new Map([[42, 0]]) }))
      .toMatchObject({ run: [{ num: 42, readyAt: 42 }], expired: [42] });
  });

  it('expires only pending listed numbers, retaining fresh and legacy entries without mutating inputs', () => {
    const pendingNums = [42, 43, 44, 99];
    const pendingSince = new Map([[42, NOW - 80 * MINUTE], [43, NOW - MINUTE], [99, 0], [45, 0]]);
    const before = new Map(pendingSince);
    const result = plan({ prs: [candidate(42), candidate(43), candidate(44), candidate(45)], pendingNums, pendingSince });
    expect(result).toMatchObject({
      run: [{ num: 42, readyAt: 42 }, { num: 45, readyAt: 45 }], expired: [42],
      skipped: [{ num: 43, reason: 'already pending' }, { num: 44, reason: 'already pending' }],
    });
    expect(pendingNums).toEqual([42, 43, 44, 99]);
    expect(pendingSince).toEqual(before);
  });

  it('bounds retries by queue capacity and preserves expired candidates in later', () => {
    const result = plan({ prs: [candidate(42), candidate(7)], queued: 1, capacity: 2 });
    expect(result).toMatchObject({ run: [{ num: 7, readyAt: 7 }], later: [42], skipped: [], expired: [42] });
    expect(plan({ queued: 4, capacity: 3 }))
      .toMatchObject({ run: [], later: [42], expired: [42] });
  });

  it.each([
    ['draft', { isDraft: true }],
    ['already queued', { inQueue: true }],
    ['CONFLICTING', { mergeable: 'CONFLICTING' }],
    ['review:changes', { labels: [{ name: 'review:changes' }] }],
    ['labels unreadable', { labels: undefined }],
  ])('expiry never bypasses the %s refusal', (reason, extra) => {
    expect(plan({ prs: [candidate(42, extra)] })).toMatchObject({
      run: [], skipped: [{ num: 42, reason }],
    });
  });
});

describe('pending expiry settings follow the existing validation and provenance contract', () => {
  it('declares and resolves the 15 minute standard default', () => {
    expect(ENQUEUE_ON_EVENT_DEFAULTS.catchUp.pendingExpiryMinutes).toBe(15);
    const result = resolve();
    expect(result.catchUp.pendingExpiryMinutes).toBe(15);
    expect(result.sources['catchUp.pendingExpiryMinutes']).toBe('standard');
    expect(result.line).toContain('catchUp.pendingExpiryMinutes=15 (standard)');
  });

  it.each([0.5, 5, 60])('accepts positive numeric expiry %s from platform then tool', value => {
    const platform = resolve({}, { catchUp: { pendingExpiryMinutes: value } });
    expect(platform.catchUp.pendingExpiryMinutes).toBe(value);
    expect(platform.sources['catchUp.pendingExpiryMinutes']).toBe('platform');
    expect(platform.line).toContain(`catchUp.pendingExpiryMinutes=${value} (platform)`);
    const tool = resolve({ catchUp: { pendingExpiryMinutes: value } }, { catchUp: { pendingExpiryMinutes: 2 } });
    expect(tool.catchUp.pendingExpiryMinutes).toBe(value);
    expect(tool.sources['catchUp.pendingExpiryMinutes']).toBe('tool');
    expect(tool.line).toContain(`catchUp.pendingExpiryMinutes=${value} (tool)`);
  });

  it.each([0, -1, '15', null, true, Number.NaN, Number.POSITIVE_INFINITY])(
    'invalid expiry %s falls back to 15 and logs the rejected setting', value => {
      const result = resolve({ catchUp: { pendingExpiryMinutes: value } });
      expect(result.catchUp.pendingExpiryMinutes).toBe(15);
      expect(result.sources['catchUp.pendingExpiryMinutes']).toBe('standard');
      expect(result.invalid.join(';')).toContain('catchUp.pendingExpiryMinutes');
      expect(result.line).toContain('catchUp.pendingExpiryMinutes=15 (standard)');
      expect(result.line).toContain('ignored invalid:');
    });
});
