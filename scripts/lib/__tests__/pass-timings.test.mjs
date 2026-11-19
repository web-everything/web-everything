/**
 * @file scripts/lib/__tests__/pass-timings.test.mjs
 * @description Unit proof of x2e120n's per-step pass timer + summary-line formatter — the "why so slow"
 * instrumentation `scripts/merge-ai-prs.mjs`'s `sweepOnce()` wraps its major steps with. Pure/dependency-free
 * (an injectable clock stands in for `Date.now`), so no real timers or I/O here.
 */
import { describe, it, expect } from 'vitest';
import { createStepTimer, formatTimingsSummary, PASS_STEP_ORDER } from '../pass-timings.mjs';

describe('createStepTimer', () => {
  it('accumulates ms under a label across repeated sync time() calls', () => {
    let clock = 0;
    const timer = createStepTimer(() => clock);
    timer.time('listing', () => { clock += 100; });
    timer.time('listing', () => { clock += 50; });
    expect(timer.snapshot()).toEqual({ listing: 150 });
  });

  it('accumulates ms across a distinct label independently', () => {
    let clock = 0;
    const timer = createStepTimer(() => clock);
    timer.time('a', () => { clock += 10; });
    timer.time('b', () => { clock += 20; });
    expect(timer.snapshot()).toEqual({ a: 10, b: 20 });
  });

  it('times an async fn and still records elapsed ms even when it throws', async () => {
    let clock = 0;
    const timer = createStepTimer(() => clock);
    await expect(timer.timeAsync('x', async () => { clock += 30; throw new Error('boom'); })).rejects.toThrow('boom');
    expect(timer.snapshot()).toEqual({ x: 30 });
  });

  it('records elapsed ms for a sync fn even when it throws (finally-based)', () => {
    let clock = 0;
    const timer = createStepTimer(() => clock);
    expect(() => timer.time('y', () => { clock += 5; throw new Error('nope'); })).toThrow('nope');
    expect(timer.snapshot()).toEqual({ y: 5 });
  });

  it('add() accumulates a manually-measured delta onto the same label as time()', () => {
    let clock = 0;
    const timer = createStepTimer(() => clock);
    timer.time('z', () => { clock += 10; });
    timer.add('z', 5);
    expect(timer.snapshot()).toEqual({ z: 15 });
  });

  it('mark() returns the injected clock reading', () => {
    const timer = createStepTimer(() => 42);
    expect(timer.mark()).toBe(42);
  });

  it('ignores a non-positive or non-finite delta (never contributes NaN/negative)', () => {
    const timer = createStepTimer();
    timer.add('a', -5);
    timer.add('a', 0);
    timer.add('a', NaN);
    timer.add('a', Infinity);
    expect(timer.snapshot()).toEqual({});
  });

  it('ignores an empty/non-string label', () => {
    const timer = createStepTimer();
    timer.add('', 10);
    timer.add(null, 10);
    expect(timer.snapshot()).toEqual({});
  });

  it('snapshot() returns an independent copy — later mutation does not alter a prior snapshot', () => {
    let clock = 0;
    const timer = createStepTimer(() => clock);
    timer.time('a', () => { clock += 10; });
    const s1 = timer.snapshot();
    timer.time('a', () => { clock += 10; });
    expect(s1).toEqual({ a: 10 });
    expect(timer.snapshot()).toEqual({ a: 20 });
  });

  it('defaults to a real clock (Date.now) when none is injected — elapsed ms is non-negative', () => {
    const timer = createStepTimer();
    timer.time('real', () => {});
    expect(timer.snapshot().real === undefined || timer.snapshot().real >= 0).toBe(true);
  });
});

describe('formatTimingsSummary', () => {
  it('includes pre-listing ops, policy and other setup phases before listing in the pass summary', async () => {
    let clock = 0;
    const timer = createStepTimer(() => clock);
    await timer.timeAsync('setup.opsFetch', async () => { clock += 21; });
    timer.time('setup.policy', () => { clock += 12; });
    timer.time('setup.other', () => { clock += 1; });
    timer.time('listing', () => { clock += 2; });
    expect(formatTimingsSummary(timer.snapshot(), { order: PASS_STEP_ORDER }))
      .toBe('setup.opsFetch=21ms setup.policy=12ms setup.other=1ms listing=2ms total=36ms');
  });
  it('renders label=NNNms pairs plus a trailing total, in caller order', () => {
    const line = formatTimingsSummary({ b: 20, a: 10 }, { order: ['a', 'b'] });
    expect(line).toBe('a=10ms b=20ms total=30ms');
  });

  it('appends a step not named in order AFTER the ordered ones, in its own insertion order', () => {
    const line = formatTimingsSummary({ a: 1, z: 3, b: 2 }, { order: ['a', 'b'] });
    expect(line).toBe('a=1ms b=2ms z=3ms total=6ms');
  });

  it('falls back to Object.keys order when no order list is given', () => {
    const line = formatTimingsSummary({ a: 1, b: 2 });
    expect(line).toBe('a=1ms b=2ms total=3ms');
  });

  it('uses an explicit total instead of summing the parts (a real pass total exceeds its labelled steps)', () => {
    const line = formatTimingsSummary({ a: 1, b: 2 }, { total: 100 });
    expect(line).toBe('a=1ms b=2ms total=100ms');
  });

  it('rounds fractional ms', () => {
    const line = formatTimingsSummary({ a: 1.6 });
    expect(line).toBe('a=2ms total=2ms');
  });

  it('is defensive against a non-object timings map', () => {
    expect(formatTimingsSummary(null)).toBe('total=0ms');
    expect(formatTimingsSummary(undefined)).toBe('total=0ms');
  });

  it('handles an empty timings map', () => {
    expect(formatTimingsSummary({})).toBe('total=0ms');
  });
});

describe('PASS_STEP_ORDER', () => {
  it('is a non-empty array of distinct string labels', () => {
    expect(Array.isArray(PASS_STEP_ORDER)).toBe(true);
    expect(PASS_STEP_ORDER.length).toBeGreaterThan(0);
    expect(new Set(PASS_STEP_ORDER).size).toBe(PASS_STEP_ORDER.length);
    for (const k of PASS_STEP_ORDER) expect(typeof k).toBe('string');
  });
});
