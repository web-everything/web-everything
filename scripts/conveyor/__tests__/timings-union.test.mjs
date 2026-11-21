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
  it('recurses into nested soak sections and retains new PR sections', () => {
    expect(merge({ soak: { nested: { b: 1 } } }, { soak: { nested: { a: 2, b: 4 } }, unit: { x: 1 } }, { soak: { nested: { b: 3 } } }))
      .toEqual({ ok: true, text: text({ soak: { nested: { a: 2, b: 3 } }, unit: { x: 1 } }) });
  });
  it('keeps main-deleted keys and whole sections deleted', () => {
    expect(merge({ unit: { a: 1 }, soak: { old: 1 } }, { unit: { a: 5, b: 2 }, soak: { old: 2, new: 3 } }, { unit: {} }))
      .toEqual({ ok: true, text: text({ unit: { b: 2 } }) });
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
