import { describe, it, expect } from 'vitest';
import { readFilteredInOrder } from '../stream-filter-runs.mjs';

// The reference: today's array form. Each case must throw the same error or return the same hits.
const arrayForm = (ids, read, keep) => ids.map(read).filter(keep);
const outcome = (fn) => { try { return { value: fn() }; } catch (error) { return { error: error.message }; } };

describe('readFilteredInOrder (xwu9oxh S1a)', () => {
  const runs = { a: { n: 1, ok: true }, b: { n: 2, ok: false }, c: { n: 3, ok: true } };
  const read = (log) => (id) => { log.push(id); if (!(id in runs)) throw new Error(`no run ${id}`); return runs[id]; };

  it('returns the same hits in id order and reads every id once, in order', () => {
    const logA = []; const logB = [];
    const keep = (r) => r.ok;
    expect(readFilteredInOrder(['a', 'b', 'c'], read(logA), keep)).toEqual(arrayForm(['a', 'b', 'c'], read(logB), keep));
    expect(logA).toEqual(['a', 'b', 'c']);
  });

  it('a read error throws at the same id, even after a keep error', () => {
    const keep = (r) => { if (r.n === 1) throw new Error('keep broke'); return true; };
    const ids = ['a', 'b', 'missing', 'c'];
    expect(outcome(() => readFilteredInOrder(ids, read([]), keep))).toEqual(outcome(() => arrayForm(ids, read([]), keep)));
    expect(outcome(() => readFilteredInOrder(ids, read([]), keep)).error).toBe('no run missing');
  });

  it('the first keep error is thrown once every read succeeded; later runs are not tested', () => {
    const tested = [];
    const keep = (r) => { tested.push(r.n); if (r.n >= 2) throw new Error(`keep broke at ${r.n}`); return true; };
    const ids = ['a', 'b', 'c'];
    expect(outcome(() => readFilteredInOrder(ids, read([]), keep))).toEqual(outcome(() => arrayForm(ids, read([]), (r) => keep(r))));
    tested.length = 0;
    expect(() => readFilteredInOrder(ids, read([]), keep)).toThrow('keep broke at 2');
    expect(tested).toEqual([1, 2]);
  });

  it('projects matching runs with their id', () => {
    expect(readFilteredInOrder(['a', 'b', 'c'], read([]), (r) => r.ok, (run, id) => ({ id, run })))
      .toEqual([{ id: 'a', run: runs.a }, { id: 'c', run: runs.c }]);
  });
});
