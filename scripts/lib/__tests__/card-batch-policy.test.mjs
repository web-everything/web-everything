// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  CARD_BATCH_KINDS, loadCardBatchPolicy, validateCardBatchPolicy,
  shouldSeal, bypassesBatch, cardOnlyEligibility,
} from '../card-batch-policy.mjs';

const copy = () => structuredClone(loadCardBatchPolicy());
const kind = loadCardBatchPolicy().prevention;
const card = (path = 'backlog/123-card.md', extra = {}) => ({ status: 'A', mode: '100644', path, ...extra });
const refused = result => {
  expect(result.ok).toBe(false);
  expect(result.reason).toEqual(expect.any(String));
};

describe('card batch policy', () => {
  it('provides frozen platform defaults and a frozen kind catalog', () => {
    expect(CARD_BATCH_KINDS).toEqual(['prevention', 'filing', 'prepare']);
    expect(Object.isFrozen(CARD_BATCH_KINDS)).toBe(true);
    const policy = loadCardBatchPolicy();
    expect(Object.isFrozen(policy)).toBe(true);
    for (const name of CARD_BATCH_KINDS) {
      // Filing carries the operator's cards.* defaults (2026-10-10): batching on, 10 cards or 60 minutes.
      expect(policy[name]).toEqual({ enabled: name !== 'prepare', maxCards: 10, maxAgeMinutes: name === 'filing' ? 60 : 120, highPriorityBypass: true });
      expect(Object.isFrozen(policy[name])).toBe(true);
    }
  });

  it('validates a full policy without freezing or retaining its input', () => {
    const raw = copy();
    const result = validateCardBatchPolicy(raw);
    expect(result).toEqual({ ok: true, policy: raw });
    expect(Object.isFrozen(result.policy)).toBe(true);
    raw.prevention.maxCards = 99;
    expect(result.policy.prevention.maxCards).toBe(10);
  });

  it('layers project overrides per kind with nearest values winning', () => {
    const raw = { prevention: { enabled: false, maxCards: 3 }, filing: { enabled: true, maxAgeMinutes: 5, highPriorityBypass: false } };
    const policy = loadCardBatchPolicy(raw);
    expect(policy.prevention).toEqual({ ...kind, enabled: false, maxCards: 3 });
    expect(policy.filing).toEqual({ enabled: true, maxCards: 10, maxAgeMinutes: 5, highPriorityBypass: false });
    expect(policy.prepare).toEqual(loadCardBatchPolicy().prepare);
    expect(loadCardBatchPolicy({})).toEqual(loadCardBatchPolicy());
    expect(raw.prevention).toEqual({ enabled: false, maxCards: 3 });
    expect(Object.isFrozen(raw.prevention)).toBe(false);
  });

  it.each([null, [], 'policy', 42, true, undefined])('refuses non-object complete policy %s', raw => {
    refused(validateCardBatchPolicy(raw));
    if (raw !== undefined) expect(() => loadCardBatchPolicy(raw)).toThrow(TypeError);
  });

  it('refuses unknown kinds and keys, including a malformed override', () => {
    for (const raw of [{ ...copy(), typo: kind }, { ...copy(), prevention: { ...kind, typo: true } }]) {
      refused(validateCardBatchPolicy(raw));
      expect(() => loadCardBatchPolicy(raw)).toThrow(/unknown/);
    }
    expect(() => loadCardBatchPolicy({ typo: {} })).toThrow(/unknown/);
    expect(() => loadCardBatchPolicy({ prevention: { typo: true } })).toThrow(/unknown/);
  });

  for (const name of CARD_BATCH_KINDS) {
    it(`refuses missing kind ${name} in complete policies`, () => {
      const raw = copy(); delete raw[name];
      expect(validateCardBatchPolicy(raw)).toMatchObject({ ok: false, reason: expect.stringContaining(name) });
    });
    it.each(Object.keys(kind))(`refuses missing ${name}.%s`, key => {
      const raw = copy(); delete raw[name][key];
      refused(validateCardBatchPolicy(raw));
    });
    it.each([null, [], 'bad', 1, undefined])(`refuses non-object ${name}: %s without fallback`, value => {
      const raw = copy(); raw[name] = value;
      refused(validateCardBatchPolicy(raw));
      expect(() => loadCardBatchPolicy({ [name]: value })).toThrow(TypeError);
    });
    for (const key of ['enabled', 'highPriorityBypass']) {
      it.each([null, undefined, 'true', 'false', 0, 1, {}, []])(`refuses non-boolean ${name}.${key}: %s`, value => {
        const raw = copy(); raw[name][key] = value;
        refused(validateCardBatchPolicy(raw));
        expect(() => loadCardBatchPolicy({ [name]: { [key]: value } })).toThrow(TypeError);
      });
    }
    for (const key of ['maxCards', 'maxAgeMinutes']) {
      it.each([NaN, Infinity, -Infinity, 1.5, '10', 0, -1, Number.MAX_SAFE_INTEGER + 1, null, undefined, true])(`refuses invalid ${name}.${key}: %s without fallback`, value => {
        const raw = copy(); raw[name][key] = value;
        refused(validateCardBatchPolicy(raw));
        expect(() => loadCardBatchPolicy({ [name]: { [key]: value } })).toThrow(TypeError);
      });
    }
  }
  it('accepts positive safe integer endpoints', () => {
    expect(loadCardBatchPolicy({ prepare: { maxCards: 1, maxAgeMinutes: Number.MAX_SAFE_INTEGER } }).prepare.maxAgeMinutes).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('sealing', () => {
  const age = 120 * 60000;
  it.each([
    [0, 0, null], [9, age - 1, null], [10, 0, 'count'], [11, 0, 'count'],
    [0, age, 'age'], [9, age + 1, 'age'], [10, age, 'count'],
  ])('count %s at age %s yields %s', (count, now, expected) => {
    expect(shouldSeal({ count, openedAt: 0, now }, kind)).toBe(expected);
  });
  it('accepts ISO strings and mixed millisecond/ISO input', () => {
    const openedAt = '2026-10-06T00:00:00.000Z';
    const now = '2026-10-06T02:00:00.000Z';
    expect(shouldSeal({ count: 1, openedAt, now }, kind)).toBe('age');
    expect(shouldSeal({ count: 1, openedAt: Date.parse(openedAt), now }, kind)).toBe('age');
    expect(shouldSeal({ count: 1, openedAt, now: Date.parse(now) - 1 }, kind)).toBe(null);
  });
  it.each([-1, 1.2, NaN, Infinity, '10', null, undefined, Number.MAX_SAFE_INTEGER + 1])('throws on invalid count %s', count => {
    expect(() => shouldSeal({ count, openedAt: 0, now: 0 }, kind)).toThrow(TypeError);
  });
  for (const key of ['openedAt', 'now']) {
    it.each([NaN, Infinity, -Infinity, null, undefined, '', 'garbage', '123', '2026-99-99T00:00:00Z', {}, new Date()])(`throws on invalid ${key}: %s even at count limit`, value => {
      expect(() => shouldSeal({ count: 10, openedAt: 0, now: 0, [key]: value }, kind)).toThrow(TypeError);
    });
  }
  it('throws for missing state, reversed time, or invalid kind policy', () => {
    for (const state of [undefined, null, {}, { count: 0, openedAt: 1, now: 0 }]) {
      expect(() => shouldSeal(state, kind)).toThrow(TypeError);
    }
    expect(() => shouldSeal({ count: 0, openedAt: 0, now: 0 }, { ...kind, maxCards: 0 })).toThrow(TypeError);
  });
});

describe('priority bypass', () => {
  it.each(['high', 'urgent'])('bypasses %s only when enabled', priority => {
    expect(bypassesBatch({ priority }, kind)).toBe(true);
    expect(bypassesBatch({ priority }, { ...kind, highPriorityBypass: false })).toBe(false);
  });
  it.each(['medium', 'low', 'normal', 'critical', 'HIGH', 'Urgent', '', undefined, null, 1])('does not bypass %s', priority => {
    expect(bypassesBatch({ priority }, kind)).toBe(false);
  });
});

describe('card-only eligibility', () => {
  it('accepts regular added cards with distinct textual ids', () => {
    expect(cardOnlyEligibility([card(), card('backlog/abc-other.md'), card('backlog/001-third.md')])).toEqual({ ok: true });
  });
  it.each([[], null, undefined, {}, 'rows'])('refuses empty/non-array rows %s', rows => {
    refused(cardOnlyEligibility(rows));
  });
  it.each(['M', 'D', 'R', 'R100', 'R050', 'T', 'C', 'C100', '?', '', undefined])('refuses status %s', status => {
    expect(cardOnlyEligibility([card('backlog/123-bad.md', { status })])).toMatchObject({ ok: false, reason: expect.stringContaining('backlog/123-bad.md') });
  });
  it.each(['100755', '120000', '160000', '040000', '100664', '', undefined, 100644])('refuses mode %s', mode => {
    expect(cardOnlyEligibility([card('backlog/123-bad.md', { mode })])).toMatchObject({ ok: false, reason: expect.stringContaining('backlog/123-bad.md') });
  });
  it.each([
    'src/123-card.md', 'backlog-tools/123-card.md', 'backlog/../123-card.md', '../backlog/123-card.md',
    'backlog/..', 'backlog/nested/123-card.md', 'backlog/./123-card.md', 'backlog/',
    'backlog/123-card.txt', 'backlog/card.md', 'backlog/-card.md', 'backlog/123-.md',
    'backlog/123-card.md\0', '/backlog/123-card.md',
  ])('refuses invalid card path %s', path => {
    expect(cardOnlyEligibility([card(path)])).toMatchObject({ ok: false, reason: expect.stringContaining(path) });
  });
  it('refuses malformed rows and non-string paths', () => {
    for (const row of [null, {}, { ...card(), path: 123 }, { ...card(), path: undefined }]) refused(cardOnlyEligibility([row]));
  });
  it('names the first offending path in mixed changes', () => {
    const result = cardOnlyEligibility([card(), card('src/source.mjs'), card('backlog/456-later.md', { status: 'D' })]);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('src/source.mjs') });
    expect(result.reason).not.toContain('456-later');
  });
  it.each(['backlog/123-second.md', 'backlog/123-card.md'])('refuses duplicate id at %s', path => {
    expect(cardOnlyEligibility([card(), card(path)])).toMatchObject({ ok: false, reason: expect.stringContaining(`${path}: duplicate card id 123`) });
  });
});
