import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assignByTime, median, ambiguousFilters, timingsFromReports, parseShardArg, listUnitTestFiles, loadTimings, assertTimingKeys, formatUpdatedTimings, REPO_ROOT } from '../shard-assign.mjs';

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
  it('rejects report filenames outside the checkout instead of storing parent-traversing keys', () => {
    const report = { testResults: [{ name: '/other-checkout/a.test.mjs', startTime: 0, endTime: 1000 }] };
    expect(() => timingsFromReports([report], '/repo')).toThrow(/repository-relative/);
  });

  it.each(['/absolute.test.mjs', '../outside.test.mjs', 'a/../../outside.test.mjs', 'C:/checkout/a.test.mjs', 'a\\b.test.mjs'])('rejects nonportable persisted timing key %s in the shared standards guard and writer', (key) => {
    const unit = { [key]: 1 };
    expect(() => assertTimingKeys({ unit })).toThrow(/repository-relative/);
    expect(() => formatUpdatedTimings({ unit: {}, soak: {} }, 'unit', unit)).toThrow(/repository-relative/);
    expect(() => assertTimingKeys({ soak: unit })).toThrow(/repository-relative/);
  });

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


describe('shard-assign — persisted unit timing freshness', () => {
  it('committed unit timing keys match discovered test filenames', async () => {
    const files = new Set(await listUnitTestFiles());
    const unit = loadTimings().unit;
    expect(Object.keys(unit).filter(file => !files.has(file))).toEqual([]);
  }, 30_000);

  it('discovery preserves include/exclude rules without executing tests, setupFiles or globalSetup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shard-discovery-'));
    try {
      const sentinels = join(root, 'sentinels');
      mkdirSync(sentinels);
      const touch = (name) => `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(sentinels, name))}, '');\n`;
      for (const dir of ['tests/deep', 'tests/skip', 'other']) mkdirSync(join(root, dir), { recursive: true });
      for (const [file, name] of [['tests/a.test.mjs', 'a'], ['tests/deep/b.test.mjs', 'b'], ['tests/skip/c.test.mjs', 'c'], ['other/d.test.mjs', 'd'], ['tests/helper.mjs', 'helper']]) {
        writeFileSync(join(root, file), touch(name));
      }
      writeFileSync(join(root, 'setup.mjs'), touch('setup'));
      writeFileSync(join(root, 'global.mjs'), `${touch('global')}export default () => {};\n`);
      writeFileSync(join(root, 'vitest.config.ts'), `export default { test: ${JSON.stringify({
        include: ['tests/**/*.test.mjs'], exclude: ['tests/skip/**'], setupFiles: ['./setup.mjs'], globalSetup: ['./global.mjs'],
      })} };\n`);
      symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
      expect(await listUnitTestFiles(root)).toEqual(['tests/a.test.mjs', 'tests/deep/b.test.mjs']);
      expect(readdirSync(sentinels)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
