import { describe, expect, it } from 'vitest';
import { DISPOSITIONS, IMPACT_LEVELS } from '../jury-core.mjs';
import {
  REVIEW_STRINGENCY_CLASSES,
  REVIEW_STRINGENCY_CLASS_MAPPINGS,
  DISPOSITION_OUTCOMES,
  validateReviewStringencyClasses,
} from '../review-stringency-classes.mjs';

// Independent acceptance fixture: the ruled rows, including the decision's stale-state
// and PR-body cases. Delivery stability includes timeouts, performance, races,
// recovery and flaky tests; these are examples of that class, not separate rows.
const expected = {
  'delivery-stability': ['broken', 'blocker'],
  'weakened-guard': ['broken', 'blocker'],
  'fail-open-guard': ['broken', 'blocker'],
  'stale-state-treated-as-current': ['broken', 'blocker'],
  'irreversible-data-loss': ['unrecoverable', 'blocker'],
  'scope-violation': ['broken', 'blocker'],
  'nonexistent-package': ['broken', 'blocker'],
  'exposed-secret': ['unrecoverable', 'blocker'],
  'missing-test-on-guard-or-delivery-code': ['broken', 'blocker'],
  'missing-test-elsewhere': ['degraded', 'carve-out'],
  'high-severity-security': ['broken', 'blocker'],
  'lower-severity-security': ['degraded', 'carve-out'],
  'standards-conformance': ['degraded', 'carve-out'],
  'pr-description-wrong-about-change': ['degraded', 'carve-out'],
  'doc-or-card-drift': ['degraded', 'carve-out'],
  'pr-body-drift': ['degraded', 'carve-out'],
  'simplicity-and-style': ['cosmetic', 'nit'],
};

describe('review stringency closed classes (xdstsoh A1)', () => {
  it('passes the ratified list and maps every named class to the existing jury vocabulary', () => {
    expect(validateReviewStringencyClasses()).toBe(true);
    expect([...REVIEW_STRINGENCY_CLASSES].sort()).toEqual(Object.keys(expected).sort());
    expect(Object.keys(REVIEW_STRINGENCY_CLASS_MAPPINGS).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, [impact, disposition]] of Object.entries(expected)) {
      expect(REVIEW_STRINGENCY_CLASS_MAPPINGS[name]).toEqual({ impact, disposition });
      expect(Object.values(IMPACT_LEVELS)).toContain(impact);
      expect(Object.values(DISPOSITIONS)).toContain(disposition);
    }
  });

  it('preserves blocker → block, carve-out → debt and nit → advisory', () => {
    expect({ ...DISPOSITION_OUTCOMES }).toEqual({ blocker: 'block', 'carve-out': 'debt', nit: 'advisory' });
  });

  it('freezes the class list, mappings, mapping records and disposition outcomes', () => {
    for (const value of [REVIEW_STRINGENCY_CLASSES, REVIEW_STRINGENCY_CLASS_MAPPINGS,
      ...Object.values(REVIEW_STRINGENCY_CLASS_MAPPINGS), DISPOSITION_OUTCOMES]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(() => { REVIEW_STRINGENCY_CLASS_MAPPINGS['delivery-stability'].impact = 'cosmetic'; }).toThrow();
  });

  it.each(['unknown', 'constructor', '__proto__', 'toString', '', null, 42])(
    'fails closed on unknown class %s, including prototype names', (name) => {
      expect(() => validateReviewStringencyClasses([...REVIEW_STRINGENCY_CLASSES, name])).toThrow(/unknown class/i);
    },
  );

  it('rejects unknown mapping keys even when the class list is unchanged', () => {
    expect(() => validateReviewStringencyClasses(REVIEW_STRINGENCY_CLASSES, {
      ...REVIEW_STRINGENCY_CLASS_MAPPINGS, unknown: { impact: 'cosmetic', disposition: 'nit' },
    })).toThrow(/unknown class/i);
  });

  it('rejects an omitted ratified class and duplicate classes', () => {
    expect(() => validateReviewStringencyClasses(REVIEW_STRINGENCY_CLASSES.slice(1))).toThrow(/missing class/i);
    expect(() => validateReviewStringencyClasses([...REVIEW_STRINGENCY_CLASSES, 'delivery-stability'])).toThrow(/duplicate class/i);
  });

  it.each(Object.keys(expected))('fails when %s has no mapping', (name) => {
    const mappings = { ...REVIEW_STRINGENCY_CLASS_MAPPINGS };
    delete mappings[name];
    expect(() => validateReviewStringencyClasses(REVIEW_STRINGENCY_CLASSES, mappings)).toThrow(/missing mapping/i);
  });

  it.each([
    null, undefined, {}, [],
    { disposition: 'blocker' }, { impact: 'broken' },
    { impact: 'unknown', disposition: 'blocker' },
    { impact: 'broken', disposition: 'expedite' },
    { impact: 'constructor', disposition: 'blocker' },
    { impact: 'broken', disposition: 'toString' },
    { impact: IMPACT_LEVELS, disposition: 'blocker' },
    Object.create({ impact: 'broken', disposition: 'blocker' }),
  ])('fails on an incomplete or invalid mapping: %j', (mapping) => {
    expect(() => validateReviewStringencyClasses(REVIEW_STRINGENCY_CLASSES, {
      ...REVIEW_STRINGENCY_CLASS_MAPPINGS, 'delivery-stability': mapping,
    })).toThrow(/mapping/i);
  });

  it('does not accept inherited mappings', () => {
    expect(() => validateReviewStringencyClasses(REVIEW_STRINGENCY_CLASSES,
      Object.create(REVIEW_STRINGENCY_CLASS_MAPPINGS))).toThrow(/missing mapping/i);
  });

  it.each([null, {}, 'delivery-stability'])('rejects malformed class collections: %j', (classes) => {
    expect(() => validateReviewStringencyClasses(classes)).toThrow(/class list/i);
  });

  it.each([null, [], 'mapping'])('rejects malformed mapping collections: %j', (mappings) => {
    expect(() => validateReviewStringencyClasses(REVIEW_STRINGENCY_CLASSES, mappings)).toThrow(/mapping/i);
  });

  it('validates supplied data without mutating it', () => {
    const classes = [...REVIEW_STRINGENCY_CLASSES];
    const mappings = structuredClone(REVIEW_STRINGENCY_CLASS_MAPPINGS);
    const before = structuredClone({ classes, mappings });
    expect(validateReviewStringencyClasses(classes, mappings)).toBe(true);
    expect({ classes, mappings }).toEqual(before);
  });
});
