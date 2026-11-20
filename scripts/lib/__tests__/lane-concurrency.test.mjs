/**
 * @file scripts/lib/__tests__/lane-concurrency.test.mjs
 * @description Unit proof of the shared LANE-DISPATCH CONCURRENCY CEILING (#xupukxa) — the resolver and the
 *   trim function `we:scripts/readiness/dispatch-plan.mjs` and `we:scripts/conveyor/tick-core.mjs` both import,
 *   so the two independent lane-consuming decisions can never drift apart on what the cap actually is.
 */
import { describe, it, expect } from 'vitest';
import { capToConcurrency, resolveMaxConcurrentLanes, DEFAULT_MAX_CONCURRENT_LANES, MAX_CONCURRENT_LANES_ENV } from '../lane-concurrency.mjs';

describe('resolveMaxConcurrentLanes', () => {
  it('defaults to DEFAULT_MAX_CONCURRENT_LANES with no env set', () => {
    expect(DEFAULT_MAX_CONCURRENT_LANES).toBe(12);
    expect(resolveMaxConcurrentLanes({})).toBe(DEFAULT_MAX_CONCURRENT_LANES);
  });

  it('keeps an env raise within the built-in bound', () => {
    expect(resolveMaxConcurrentLanes({ [MAX_CONCURRENT_LANES_ENV]: '20' })).toBe(12);
  });

  it('clamps to a floor of 1 — a cap of 0 or negative would wedge all new dispatch', () => {
    expect(resolveMaxConcurrentLanes({ [MAX_CONCURRENT_LANES_ENV]: '0' })).toBe(DEFAULT_MAX_CONCURRENT_LANES);
    expect(resolveMaxConcurrentLanes({ [MAX_CONCURRENT_LANES_ENV]: '-5' })).toBe(DEFAULT_MAX_CONCURRENT_LANES);
  });

  it('ignores a non-numeric override and falls back to the default', () => {
    expect(resolveMaxConcurrentLanes({ [MAX_CONCURRENT_LANES_ENV]: 'not-a-number' })).toBe(DEFAULT_MAX_CONCURRENT_LANES);
  });

  it('floors a fractional override', () => {
    expect(resolveMaxConcurrentLanes({ [MAX_CONCURRENT_LANES_ENV]: '8.9' })).toBe(8);
  });
});

describe('capToConcurrency', () => {
  it('admits everything when the cap comfortably covers active + candidate lanes', () => {
    expect(capToConcurrency([1, 2, 3], { activeCount: 0, cap: 8 })).toEqual({ admitted: [1, 2, 3], overflow: [] });
  });

  it('trims to the room left after already-active lanes, preserving order', () => {
    expect(capToConcurrency([1, 2, 3], { activeCount: 2, cap: 3 })).toEqual({ admitted: [1], overflow: [2, 3] });
  });

  it('admits nothing when active lanes already meet or exceed the cap', () => {
    expect(capToConcurrency([1, 2], { activeCount: 5, cap: 5 })).toEqual({ admitted: [], overflow: [1, 2] });
    expect(capToConcurrency([1, 2], { activeCount: 9, cap: 5 })).toEqual({ admitted: [], overflow: [1, 2] });
  });

  it('is defensive against a non-array candidate list and missing budget fields', () => {
    expect(capToConcurrency(null, { activeCount: 0, cap: 8 })).toEqual({ admitted: [], overflow: [] });
    expect(capToConcurrency([1, 2], {})).toEqual({ admitted: [1, 2], overflow: [] }); // default cap = DEFAULT_MAX_CONCURRENT_LANES, activeCount 0
  });

  it('an Infinity cap (dispatch-plan.mjs / tick-core.mjs pure-core default) never trims anything', () => {
    expect(capToConcurrency([1, 2, 3], { activeCount: 100, cap: Infinity })).toEqual({ admitted: [1, 2, 3], overflow: [] });
  });
});
