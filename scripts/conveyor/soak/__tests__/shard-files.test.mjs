import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { shardFiles, parseShardArg, listBreakTestFiles, BASELINE_FILE, REPO_ROOT } from '../shard-files.mjs';
import { loadTimings } from '../../../ci/shard-assign.mjs';

describe('soak shard-files — isolated baseline and time-balanced breaks', () => {
  it('every file (baseline + breaks) is assigned to exactly one shard', () => {
    const total = 4;
    const seen = [];
    for (let shard = 1; shard <= total; shard += 1) seen.push(...shardFiles({ shard, total }));
    const expected = [BASELINE_FILE, ...listBreakTestFiles()].length;
    expect(seen.length).toBe(expected);
    expect(new Set(seen).size).toBe(expected); // none dropped, none duplicated
  });

  it('total=1 runs everything in the single shard (baseline + every break)', () => {
    const files = shardFiles({ shard: 1, total: 1 });
    expect(files.length).toBe(1 + listBreakTestFiles().length);
    expect(files[0]).toBe('scripts/conveyor/soak/daemon-soak.soak.test.mjs');
  });

  // Real fixtures (a temp `breaks/` dir via the `breaksDir` override), not two calls on one list.
  function withBreaks(names, fn) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-shard-'));
    try {
      for (const n of names) writeFileSync(join(dir, n), '');
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('keeps the baseline alone even when its timing is missing or underestimates its cost', () => {
    withBreaks(['a.soak.test.mjs', 'b.soak.test.mjs', 'c.soak.test.mjs'], (dir) => {
      const opts = { total: 3, breaksDir: dir, baselineFile: join(dir, 'base.soak.test.mjs'), repoRoot: dir };
      for (const baselineTiming of [{}, { 'base.soak.test.mjs': 1 }]) {
        const timings = { 'a.soak.test.mjs': 100, 'b.soak.test.mjs': 50, 'c.soak.test.mjs': 50, ...baselineTiming };
        const shards = [1, 2, 3].map((shard) => shardFiles({ ...opts, shard, timings }));
        expect(shards[0]).toEqual(['base.soak.test.mjs']);
        expect(shards.slice(1)).toEqual([['a.soak.test.mjs'], ['b.soak.test.mjs', 'c.soak.test.mjs']]);
      }
    });
  });

  it('isolates the baseline even when missing or understated timings would co-schedule breaks', () => {
    withBreaks(['a.soak.test.mjs', 'b.soak.test.mjs'], (dir) => {
      for (const timings of [{}, { 'base.soak.test.mjs': 1, 'a.soak.test.mjs': 100 }]) {
        const opts = { total: 2, breaksDir: dir, baselineFile: join(dir, 'base.soak.test.mjs'), repoRoot: dir, timings };
        expect(shardFiles({ ...opts, shard: 1 })).toEqual(['base.soak.test.mjs']);
        expect(shardFiles({ ...opts, shard: 2 })).toEqual(['a.soak.test.mjs', 'b.soak.test.mjs']);
      }
    });
  });

  it('the shared sharding CLI uses the same isolated baseline assignment', () => {
    const output = execFileSync(process.execPath, ['scripts/ci/shard-assign.mjs', '--suite=soak', '--shard=1/4'], { encoding: 'utf8' });
    expect(output.trim().split('\n')).toEqual(shardFiles({ shard: 1, total: 4 }));
  });

  it('reserves shard 1 for the baseline even when timings make it the cheapest file', () => {
    withBreaks(['a.soak.test.mjs', 'b.soak.test.mjs'], (dir) => {
      const opts = { total: 3, breaksDir: dir, baselineFile: join(dir, 'base.soak.test.mjs'), repoRoot: dir };
      for (const timings of [{}, { 'base.soak.test.mjs': 1, 'a.soak.test.mjs': 100, 'b.soak.test.mjs': 200 }]) {
        expect(shardFiles({ ...opts, shard: 1, timings })).toEqual(['base.soak.test.mjs']);
        const breaks = [2, 3].flatMap((shard) => shardFiles({ ...opts, shard, timings }));
        expect(breaks.sort()).toEqual(['a.soak.test.mjs', 'b.soak.test.mjs']);
      }
    });
  });

  it('balances break scenarios by stored timings across the remaining shards', () => {
    withBreaks(['a.soak.test.mjs', 'b.soak.test.mjs', 'c.soak.test.mjs'], (dir) => {
      const opts = { total: 3, breaksDir: dir, baselineFile: join(dir, 'base.soak.test.mjs'), repoRoot: dir,
        timings: { 'base.soak.test.mjs': 1, 'a.soak.test.mjs': 40, 'b.soak.test.mjs': 20, 'c.soak.test.mjs': 20 } };
      expect(shardFiles({ ...opts, shard: 1 })).toEqual(['base.soak.test.mjs']);
      expect(shardFiles({ ...opts, shard: 2 })).toEqual(['a.soak.test.mjs']);
      expect(shardFiles({ ...opts, shard: 3 })).toEqual(['b.soak.test.mjs', 'c.soak.test.mjs']);
    });
  });

  it('total=2 puts all breaks in the second shard', () => {
    const names = ['a.soak.test.mjs', 'b.soak.test.mjs', 'c.soak.test.mjs', 'd.soak.test.mjs'];
    withBreaks(names, (dir) => {
      const opts = { total: 3, breaksDir: dir, baselineFile: join(dir, 'base.soak.test.mjs'), repoRoot: dir };
      const timings = { 'base.soak.test.mjs': 1, 'a.soak.test.mjs': 30, 'b.soak.test.mjs': 10, 'c.soak.test.mjs': 10, 'd.soak.test.mjs': 10 };
      const s1 = shardFiles({ ...opts, shard: 1, timings });
      const s2 = shardFiles({ ...opts, shard: 2, timings });
      expect(s1).toEqual(['base.soak.test.mjs']);
      expect(s2).toEqual(['a.soak.test.mjs']);
      expect(shardFiles({ ...opts, shard: 3, timings })).toEqual(['b.soak.test.mjs', 'c.soak.test.mjs', 'd.soak.test.mjs']);
    });
  });

  it('keeps the baseline alone even when its timing is missing or smaller than every break', () => {
    withBreaks(['a.soak.test.mjs', 'b.soak.test.mjs', 'c.soak.test.mjs', 'd.soak.test.mjs'], (dir) => {
      const opts = { total: 3, breaksDir: dir, baselineFile: join(dir, 'base.soak.test.mjs'), repoRoot: dir };
      const breaks = { 'a.soak.test.mjs': 40, 'b.soak.test.mjs': 30, 'c.soak.test.mjs': 20, 'd.soak.test.mjs': 10 };
      for (const timings of [breaks, { ...breaks, 'base.soak.test.mjs': 1 }]) {
        expect(shardFiles({ ...opts, shard: 1, timings })).toEqual(['base.soak.test.mjs']);
        const remaining = [2, 3].map((shard) => shardFiles({ ...opts, shard, timings }));
        expect(remaining.flat().sort()).toEqual(Object.keys(breaks).sort());
        expect(remaining.map((files) => files.reduce((sum, file) => sum + timings[file], 0))).toEqual([50, 50]);
      }
    });
  });

  it('a new break with no stored timing is assigned (median fallback), none lost', () => {
    withBreaks(['a.soak.test.mjs', 'new.soak.test.mjs'], (dir) => {
      const opts = { total: 3, breaksDir: dir, baselineFile: join(dir, 'base.soak.test.mjs'), repoRoot: dir, timings: { 'a.soak.test.mjs': 5, 'base.soak.test.mjs': 50 } };
      const all = [1, 2, 3].flatMap((shard) => shardFiles({ ...opts, shard }));
      expect(all.sort()).toEqual(['a.soak.test.mjs', 'base.soak.test.mjs', 'new.soak.test.mjs']);
    });
  });

  it('the stored timings cover most break files (a stale table would only cost balance)', () => {
    const timings = loadTimings().soak;
    const all = [BASELINE_FILE, ...listBreakTestFiles()];
    const known = all.filter((f) => Number.isFinite(timings[f.slice(f.indexOf('scripts/conveyor'))]));
    expect(known.length / all.length).toBeGreaterThan(0.8);
  });

  it('more shards than break files leaves the extra shards empty, not erroring', () => {
    // Derived from the live break count, never a hardcoded ceiling: a fixed 30 silently stopped being "more"
    // the day the 29th break file landed (29 buckets, one file each, zero empty shards).
    const total = listBreakTestFiles().length + 5;
    const emptyShards = [];
    for (let shard = 2; shard <= total; shard += 1) {
      if (shardFiles({ shard, total }).length === 0) emptyShards.push(shard);
    }
    expect(emptyShards.length).toBeGreaterThan(0);
  });

  it('rejects an out-of-range or malformed shard index', () => {
    expect(() => shardFiles({ shard: 0, total: 4 })).toThrow();
    expect(() => shardFiles({ shard: 5, total: 4 })).toThrow();
    expect(() => shardFiles({ shard: 1, total: 0 })).toThrow();
  });

  it('BASELINE_FILE resolves to the 50-tick soak test', () => {
    expect(BASELINE_FILE).toMatch(/daemon-soak\.soak\.test\.mjs$/);
  });

  it('the generic timing CLI uses the same soak allocation as the runner', () => {
    for (const shard of [1, 2]) {
      const out = execFileSync(process.execPath, [join(REPO_ROOT, 'scripts/ci/shard-assign.mjs'),
        '--suite=soak', `--shard=${shard}/4`], { encoding: 'utf8' });
      expect(out.trim().split('\n')).toEqual(shardFiles({ shard, total: 4 }));
    }
  });
});

describe('parseShardArg', () => {
  it('parses --shard=i/N', () => {
    expect(parseShardArg(['--shard=2/4'])).toEqual({ shard: 2, total: 4 });
  });

  it('throws a usage error when missing', () => {
    expect(() => parseShardArg([])).toThrow(/usage/);
  });

  it('throws on malformed values', () => {
    expect(() => parseShardArg(['--shard=abc'])).toThrow();
    expect(() => parseShardArg(['--shard=2'])).toThrow();
  });
});
