import { describe, expect, it } from 'vitest';
import { classify, directionFor, isLoosening } from '../settings-safe-direction.mjs';

describe('settings safe direction', () => {
  it('classifies the seeded gate keys as safety and the rest as unclassed', () => {
    expect(classify('review', 'unattendedAcceptRequiresCleanReferrals')).toBe('safety');
    expect(classify('review.careExemptPaths', '')).toBe('safety');
    expect(classify('redTeam', 'statusLabels')).toBe('unclassed');
    expect(classify('review', 'toString')).toBe('unclassed');
    expect(directionFor('nope', 'x')).toBeUndefined();
  });
  it('boolean: only the safe value tightens; equal never loosens', () => {
    expect(isLoosening('true', true, false)).toBe(true);
    expect(isLoosening('true', true, true)).toBe(false);
    expect(isLoosening('true', false, false)).toBe(false);
    expect(isLoosening('false', false, true)).toBe(true);
  });
  it('uncomparable values count as loosening (fail closed)', () => {
    expect(isLoosening('true', true, 'off')).toBe(true);
    expect(isLoosening('subset', ['a'], 'a')).toBe(true);
    expect(isLoosening('subset', undefined, ['a'])).toBe(true);
    expect(isLoosening('min', 3, '2')).toBe(true);
    expect(isLoosening('min', 3, NaN)).toBe(true);
    expect(isLoosening({}, 1, 1.5)).toBe(true);
    expect(isLoosening('mystery', 1, 2)).toBe(true);
  });
  it('equal malformed values are still loosening (validate before equality)', () => {
    expect(isLoosening('min', NaN, NaN)).toBe(true);
    expect(isLoosening('subset', 'bad', 'bad')).toBe(true);
    expect(isLoosening('true', 'x', 'x')).toBe(true);
    expect(isLoosening('enum:a,b', 'zz', 'zz')).toBe(true);
    expect(isLoosening('true', {}, {})).toBe(true);
  });
  it('subset, min, max and enum directions', () => {
    expect(isLoosening('subset', ['a', 'b'], ['a'])).toBe(false);
    expect(isLoosening('subset', ['a'], ['a', 'b'])).toBe(true);
    expect(isLoosening('min', 5, 4)).toBe(false);
    expect(isLoosening('min', 5, 6)).toBe(true);
    expect(isLoosening('max', 5, 6)).toBe(false);
    expect(isLoosening('max', 5, 4)).toBe(true);
    expect(isLoosening('enum:strict,normal,lax', 'normal', 'strict')).toBe(false);
    expect(isLoosening('enum:strict,normal,lax', 'normal', 'lax')).toBe(true);
    expect(isLoosening('enum:strict,normal,lax', 'normal', 'other')).toBe(true);
  });
});
