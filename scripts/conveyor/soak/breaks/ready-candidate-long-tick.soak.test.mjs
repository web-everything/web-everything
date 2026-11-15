import b from './ready-candidate-long-tick.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
import { describe, expect, it } from 'vitest';
import { createAdoptYieldProbe, safeAdoptYield } from '../../../lib/daemon-rebuild/adopt-yield.mjs';

defineBreakTest(b);

describe('createAdoptYieldProbe — boot HEAD and restart spacing', () => {
  const candidate = {
    prevHead: 'boot-head', passedAt: '2026-11-14T20:00:00.000Z',
    adopt: { finalSha: 'candidate-head' },
  };
  const options = {
    root: '.', env: {}, bootHead: 'boot-head', readReady: () => candidate,
  };

  it('does not yield when candidate prevHead differs from boot HEAD', () => {
    const probe = createAdoptYieldProbe({ ...options, now: () => 0,
      readReady: () => ({ ...candidate, prevHead: 'another-boot-head' }) });
    expect(probe()).toBe(false);
  });

  it('does not yield when bootAt is missing and restart spacing is positive', () => {
    const probe = createAdoptYieldProbe({ ...options, now: () => 10000,
      swapMinIntervalMs: 5000 });
    expect(probe()).toBe(false);
  });

  it('does not yield when elapsed uptime is below restart spacing', () => {
    const probe = createAdoptYieldProbe({ ...options, now: () => 5999,
      bootAt: 1000, swapMinIntervalMs: 5000 });
    expect(probe()).toBe(false);
  });

  it('yields at the exact restart-spacing boundary', () => {
    const probe = createAdoptYieldProbe({ ...options, now: () => 6000,
      bootAt: 1000, swapMinIntervalMs: 5000 });
    expect(probe()).toBe(true);
  });
});

describe('safeAdoptYield — fail-closed callbacks', () => {
  it('does not yield when the callback is absent', () => {
    expect(safeAdoptYield()).toBe(false);
  });

  it.each([null, true, 1, 'ready', {}, []])('does not yield for a non-function callback: %j', probe => {
    expect(safeAdoptYield(probe)).toBe(false);
  });

  it('does not yield when the callback throws', () => {
    expect(safeAdoptYield(() => { throw new Error('unreadable readiness'); })).toBe(false);
  });

  it.each([undefined, null, 0, 1, '', 'ready', {}, []])(
    'does not yield for a non-boolean callback result: %j', value => {
      expect(safeAdoptYield(() => value)).toBe(false);
    },
  );

  it('does not yield when the callback returns false', () => {
    expect(safeAdoptYield(() => false)).toBe(false);
  });

  it('yields only when the callback returns true', () => {
    expect(safeAdoptYield(() => true)).toBe(true);
  });
});
