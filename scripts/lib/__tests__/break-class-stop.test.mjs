/** Structured-history invariants, including the #6033 replay shape. */
import { expect, it } from 'vitest';
import { classKey, classify } from '../break-class-stop.mjs';

const finding = (path, extra = {}) => ({ category: 'edge-case', path, confirmed: true, ...extra });
const round = (n, findings = [finding(`src/${n}.mjs`)]) => ({ schema: 1, pr: 6033, head: `h${n}`, round: n, resultId: `r${n}`, source: 'gate', findings, complete: true });

it('I1 incomplete slices, missing rounds, duplicate rounds and incomplete records are UNKNOWN', () => {
  expect(classify([round(1)], { complete: false }).verdict).toBe('UNKNOWN');
  expect(classify([round(1), round(3)]).verdict).toBe('UNKNOWN');
  expect(classify([round(1), round(1)]).verdict).toBe('UNKNOWN');
  expect(classify([{ ...round(1), complete: false }]).verdict).toBe('UNKNOWN');
  expect(classify([round(2), round(1)]).verdict).toBe('CONTINUE');
});

it('I2 explicit malformed lines and self-detected invalid evidence force UNKNOWN', () => {
  const good = [round(1), round(2), round(3)];
  expect(classify(good, { malformed: 1 })).toMatchObject({ verdict: 'UNKNOWN', malformed: 1 });
  for (const bad of [{ ...round(4), schema: 2 }, round(4, [{ path: 'a', confirmed: true }]), round(4, [{ category: 'x', confirmed: false }]), round(4, [finding('a', { confirmed: 'yes' })])]) {
    expect(classify([...good, bad])).toMatchObject({ verdict: 'UNKNOWN', malformed: 1 });
  }
});

it('I3 totality handles junk, huge sparse arrays, cycles, accessors and nested findings', () => {
  const circular = {}; circular.self = circular;
  const hostile = { get schema() { throw new Error('getter'); } };
  for (const input of [null, undefined, 'abc', 7, circular, new Array(100001), [hostile], [round(1, [circular])], [round(1, [[[]]])], [round(1, new Array(100001))]]) {
    expect(() => classify(input)).not.toThrow();
    expect(['STOP', 'CONTINUE', 'UNKNOWN']).toContain(classify(input).verdict);
    expect(classify(input).verdict).toBe('UNKNOWN');
  }
  expect(classify(new Array(100001)).reason).toMatch(/operator review/);
  expect(classify([], null).verdict).toBe('UNKNOWN');
  expect(classify([], { threshold: 0 }).verdict).toBe('UNKNOWN');
});

it('I5 STOP survives a repeat round while the current streak resets', () => {
  const history = [round(1), round(2), round(3), round(4, [finding('src/1.mjs')])];
  expect(classify(history)).toMatchObject({ verdict: 'STOP', consecutive: 0, newClasses: [] });
  expect(classify([round(1), round(2, []), round(3)])).toMatchObject({ verdict: 'CONTINUE', consecutive: 1 });
  expect(classify([round(1, [finding('x', { confirmed: false })])])).toMatchObject({ consecutive: 0, newClasses: [] });
});

it('I6 identity uses normalized full paths, category and mechanism', () => {
  expect(classKey(finding(' ./src\\a//file.mjs '))).toBe(classKey(finding('src/a/file.mjs')));
  expect(classKey(finding('a/file.mjs'))).not.toBe(classKey(finding('b/file.mjs')));
  const result = classify([round(1, [finding('a/file.mjs'), finding('b/file.mjs'), finding('a/file.mjs'), finding('a/file.mjs', { mechanism: 'parse' }), finding('a/file.mjs', { category: 'security' })])]);
  expect(result.newClasses).toHaveLength(4);
  expect(classKey(finding(''))).toBeNull();
});

it('Replay #6033: nine rounds, six edge-case paths; STOP first appears at round three', () => {
  const history = Array.from({ length: 9 }, (_, i) => round(i + 1, [finding(`src/case-${i < 6 ? i : 0}.mjs`, { category: i < 6 ? 'edge-case' : 'other' })]));
  expect(classify(history.slice(0, 1)).verdict).toBe('CONTINUE');
  expect(classify(history.slice(0, 2)).verdict).toBe('CONTINUE');
  expect(classify(history.slice(0, 3))).toMatchObject({ verdict: 'STOP', consecutive: 3 });
  expect(classify(history).verdict).toBe('STOP');
});
