import { describe, expect, it } from 'vitest';
import { assignByTime, median, ambiguousFilters, timingsFromReports, parseShardArg } from '../shard-assign.mjs';

describe('shard-assign — balance by measured time (card 11)', () => {
  const files = ['a', 'b', 'c', 'd', 'e', 'f'];
  const timings = { a: 60, b: 30, c: 30, d: 20, e: 10, f: 10 };

  it('puts every file in exactly one shard', () => {
    const shards = assignByTime(files, timings, 3);
    const flat = shards.flat();
    expect(flat.sort()).toEqual([...files].sort());
  });

  it('keeps shard loads within the heaviest single file of each other', () => {
    const shards = assignByTime(files, timings, 3);
    const loads = shards.map((s) => s.reduce((n, f) => n + timings[f], 0));
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(Math.max(...Object.values(timings)));
    expect(Math.max(...loads)).toBe(60); // 160 total / 3 shards, the 60s file alone is the floor
  });

  it('is deterministic and independent of input order', () => {
    expect(assignByTime([...files].reverse(), timings, 3)).toEqual(assignByTime(files, timings, 3));
  });

  it('a file with no stored timing gets the median of the known ones', () => {
    expect(median([1, 5, 9])).toBe(5);
    const shards = assignByTime(['a', 'b', 'new'], { a: 10, b: 10 }, 3);
    expect(shards.flat().sort()).toEqual(['a', 'b', 'new']);
    expect(shards.every((s) => s.length === 1)).toBe(true);
  });

  it('more shards than files leaves extra shards empty, not erroring', () => {
    expect(assignByTime(['a'], { a: 1 }, 3).filter((s) => s.length === 0).length).toBe(2);
  });

  it('rejects a bad shard count', () => {
    expect(() => assignByTime(files, timings, 0)).toThrow();
  });
});

describe('shard-assign — vitest substring-filter guard', () => {
  it('flags a filter that is a substring of another test path', () => {
    expect(ambiguousFilters(['x/a.test.ts'], ['x/a.test.ts', 'x/a.test.tsx'])).toEqual([['x/a.test.ts', 'x/a.test.tsx']]);
    expect(ambiguousFilters(['x/a.test.ts'], ['x/a.test.ts', 'x/b.test.ts'])).toEqual([]);
  });
});

describe('shard-assign — timings from vitest json reports', () => {
  it('maps absolute names to repo-relative seconds, keeping the largest sample', () => {
    const root = '/repo';
    const r1 = { testResults: [{ name: '/repo/a/x.test.mjs', startTime: 0, endTime: 2500 }] };
    const r2 = { testResults: [{ name: '/repo/a/x.test.mjs', startTime: 0, endTime: 1000 }, { name: '/repo/b.test.ts', startTime: 10, endTime: 510 }] };
    expect(timingsFromReports([r1, r2], root)).toEqual({ 'a/x.test.mjs': 2.5, 'b.test.ts': 0.5 });
  });

  it('parses --shard=i/N and rejects a bad index', () => {
    expect(parseShardArg(['--shard=2/4'])).toEqual({ shard: 2, total: 4 });
    expect(() => parseShardArg(['--shard=5/4'])).toThrow();
  });
});
