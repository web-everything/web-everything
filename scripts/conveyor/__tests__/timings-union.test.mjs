import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { unionTimings, TIMINGS_PATH } from '../timings-union.mjs';
const text = value => JSON.stringify(value, null, 1) + '\n';
const merge = (base, ours, theirs) => unionTimings({ base: text(base), ours: text(ours), theirs: text(theirs) });

describe("test-timings union resolver merges both sides' keys, takes main's value on same-key timing drift, keeps the PR's new keys, and refuses non-JSON or structural conflicts (fail closed)", () => {
  it('merges key-disjoint additions and sorts sections that main sorted', () => {
    expect(merge({ unit: { b: 1 } }, { unit: { a: 2, b: 1 } }, { unit: { b: 1, c: 3 } }))
      .toEqual({ ok: true, text: text({ unit: { a: 2, b: 1, c: 3 } }) });
  });
  it('takes main for same-key different ms and keeps keys the PR deleted', () => {
    expect(merge({ unit: { a: 1, b: 2 } }, { unit: { a: 8 } }, { unit: { a: 9, b: 3 } }))
      .toEqual({ ok: true, text: text({ unit: { a: 9, b: 3 } }) });
  });
  it('retains new PR sections with flat path-to-seconds maps', () => {
    expect(merge({ soak: { b: 1 } }, { soak: { a: 2, b: 4 }, unit: { x: 1 } }, { soak: { b: 3 } }))
      .toEqual({ ok: true, text: text({ soak: { a: 2, b: 3 }, unit: { x: 1 } }) });
  });
  it('keeps main-deleted keys and untouched whole sections deleted', () => {
    expect(merge({ unit: { a: 1 }, soak: { old: 1 } }, { unit: { a: 5, b: 2 }, soak: { old: 1 } }, { unit: {} }))
      .toEqual({ ok: true, text: text({ unit: { b: 2 } }) });
  });
  it.each([{ old: 1, added: 2 }, { old: 2 }, {}])('refuses a main-deleted section changed by the PR: %j', pr => {
    expect(merge({ soak: { old: 1 } }, { soak: pr }, {}))
      .toMatchObject({ ok: false, reason: expect.stringContaining('resolve manually') });
  });
  it.each([
    [1, 2, 1, 2, 'PR-only change'],
    [1, 1, 3, 3, 'main-only change'],
    [1, 2, 3, 3, 'concurrent drift'],
    [undefined, 2, 3, 3, 'add/add key'],
  ])('uses three-way values (%s, %s, %s): %s for %s', (base, pr, main, expected) => {
    expect(merge({ unit: base === undefined ? {} : { a: base } }, { unit: { a: pr } }, { unit: { a: main } }))
      .toEqual({ ok: true, text: text({ unit: { a: expected } }) });
  });
  it.each([undefined, ''])('accepts an absent/empty add-add base (%s)', base => {
    expect(unionTimings({ base, ours: text({ unit: { a: 1 } }), theirs: text({ unit: { b: 2 } }) }))
      .toEqual({ ok: true, text: text({ unit: { a: 1, b: 2 } }) });
  });
  it('preserves unsorted main key order when adding keys', () => {
    expect(merge({}, { unit: { a: 1 } }, { unit: { z: 2, b: 3 } }).text)
      .toBe(text({ unit: { z: 2, b: 3, a: 1 } }));
  });
  it.each(['base', 'ours', 'theirs'])('refuses malformed %s JSON', side => {
    expect(unionTimings({ base: '{}', ours: '{}', theirs: '{}', [side]: '{broken' }))
      .toMatchObject({ ok: false, reason: expect.any(String) });
  });
  it.each([
    [{ unit: { a: 1 } }, { unit: { a: {} } }, { unit: { a: 2 } }],
    [{ unit: 1 }, { unit: {} }, {}],
    [{}, { unit: [] }, {}],
    [{}, { unit: {} }, { unit: [] }],
    [{}, {}, { unit: null }],
    [{}, { unit: { a: true } }, {}],
    [{}, { _doc: 'changed' }, { _doc: 'original' }],
    [{}, { unit: { a: 1 } }, { unit: { a: '1' } }],
  ])('refuses structural conflicts, including deleted paths: %j', (base, ours, theirs) => {
    expect(merge(base, ours, theirs)).toMatchObject({ ok: false, reason: expect.any(String) });
  });
  describe.each(['base', 'ours', 'theirs'])('validates all evidence on %s', side => {
    it.each(['-1', '1e400', 'NaN', '"1"', 'null', 'true', '{}', '[]'])('rejects invalid timing value %s even on deleted paths', value => {
      expect(unionTimings({ base: '{}', ours: '{}', theirs: '{}', [side]: `{"unit":{"a":${value}}}` }).ok).toBe(false);
    });
    it.each(['1', '"map"', 'null', '[]'])('rejects a non-map section %s', value => {
      expect(unionTimings({ base: '{}', ours: '{}', theirs: '{}', [side]: `{"unit":${value}}` }).ok).toBe(false);
    });
    it.each(['unit', 'soak', 'integration', 'custom'])('rejects traversal in %s using the shared key validator', section => {
      expect(unionTimings({ base: '{}', ours: '{}', theirs: '{}', [side]: text({ [section]: { '../outside': 1 } }) }))
        .toMatchObject({ ok: false, reason: expect.stringContaining('Invalid timing key') });
    });
    it('rejects non-string _doc metadata', () => {
      expect(unionTimings({ base: '{}', ours: '{}', theirs: '{}', [side]: '{"_doc":1}' }).ok).toBe(false);
    });
  });
  it('round-trips the current timings file byte for byte with 1-space indentation and trailing newline', () => {
    expect(TIMINGS_PATH).toBe('scripts/ci/test-timings.json');
    const current = readFileSync(TIMINGS_PATH, 'utf8');
    expect(text(JSON.parse(current))).toBe(current);
    expect(unionTimings({ base: current, ours: current, theirs: current })).toEqual({ ok: true, text: current });
  });
  it('handles JSON property names without prototype mutation', () => {
    const result = unionTimings({ ours: '{"unit":{"__proto__":1}}', theirs: '{"unit":{}}' });
    expect(result).toEqual({ ok: true, text: text(JSON.parse('{"unit":{"__proto__":1}}')) });
  });
});
