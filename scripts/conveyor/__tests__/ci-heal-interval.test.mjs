import { describe, expect, it } from 'vitest';
import { resolveCiHealInterval } from '../ci-heal-interval.mjs';

const resolve = (settings = {}, env = {}) => resolveCiHealInterval({ settings, env });
describe('CI-heal interval policy', () => {
  it('resolves the standard, tool setting and environment precedence with provenance', () => {
    expect(resolve()).toEqual({ seconds: 300, source: 'standard' });
    expect(resolve({ ciHeal: { intervalSec: 120 } })).toEqual({ seconds: 120, source: 'tool' });
    expect(resolve({ ciHeal: { intervalSec: 120 } }, { WE_CI_HEAL_INTERVAL_SEC: '90' }))
      .toEqual({ seconds: 90, source: 'env' });
  });
  it.each([0, 59, 1801, 'abc', '90', 90.5, null, NaN, Infinity])('invalid setting %s falls back to 300', intervalSec => {
    expect(resolve({ ciHeal: { intervalSec } }).seconds).toBe(300);
  });
  it.each(['0', '59', '1801', 'abc', '90.5', '', 'NaN', 'Infinity', ' 90', '1e2'])('invalid env %s overrides a valid tool value with 300', value => {
    expect(resolve({ ciHeal: { intervalSec: 120 } }, { WE_CI_HEAL_INTERVAL_SEC: value }))
      .toEqual({ seconds: 300, source: 'env' });
  });
  it.each([60, 1800])('accepts inclusive boundary %s for the setting and environment', seconds => {
    expect(resolve({ ciHeal: { intervalSec: seconds } }).seconds).toBe(seconds);
    expect(resolve({}, { WE_CI_HEAL_INTERVAL_SEC: String(seconds) }).seconds).toBe(seconds);
  });
});
