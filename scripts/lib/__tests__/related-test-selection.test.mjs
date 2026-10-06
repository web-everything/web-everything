/**
 * @file scripts/lib/__tests__/related-test-selection.test.mjs
 * @description #5128 — bounded selection keeps direct importers; all fixtures live in memory.
 */
import { describe, expect, it } from 'vitest';
import { buildReverseImportGraph, resolveSpecifier, testDepths, selectRelatedTests, isVitestTestFile } from '../related-test-selection.mjs';

const graph = files => buildReverseImportGraph({ files: Object.keys(files), readFile: path => files[path] });
function hubFiles() {
  const files = { 'hub.mjs': '', 'changed.test.mjs': '' };
  for (let i = 0; i < 2; i++) files[`direct${i}.test.mjs`] = "import './hub.mjs'";
  for (let i = 0; i < 3; i++) {
    files[`mid${i}.mjs`] = "import './hub.mjs'";
    for (let j = 0; j < 10; j++) files[`deep${i}-${j}.test.mjs`] = `import './mid${i}.mjs'`;
  }
  return files;
}
const selectHub = overrides => selectRelatedTests({ changedFiles: ['hub.mjs', 'changed.test.mjs'],
  reverse: graph(hubFiles()), maxTests: 5, maxDepth: 2, ...overrides });

describe('#5128 — related import graph', () => {
  it('reads static, multiline, re-export, dynamic, side-effect and CommonJS imports', () => {
    const targets = ['src/a.mjs', 'b.mjs', 'src/c.mjs', 'src/d.mjs', 'src/e.mjs', 'src/f.cjs', 'src/g.mjs', 'src/h.ts'];
    const files = Object.fromEntries(targets.map(path => [path, '']));
    files['src/main.mjs'] = `
      import x from './a.mjs';
      import {
        a, // it's a comment with a quote
      } from '../b.mjs';
      export * from './c.mjs';
      await import('./d.mjs');
      import './e.mjs';
      require('./f.cjs');
      import g from './g';
      import h from './h.js';
      import fs from 'node:fs';
      import { it } from 'vitest';
    `;
    expect(graph(files)).toEqual(new Map(targets.map(path => [path, new Set(['src/main.mjs'])])));
  });

  it.each([
    ['./g', 'src/g.mjs'], ['./h.js', 'src/h.ts'], ['./g.mjs?raw', 'src/g.mjs'],
    ['./folder', 'src/folder/index.ts'], ['node:fs', null], ['vitest', null], ['./missing', null], ['../../outside', null],
  ])('resolves %s to %s', (specifier, expected) => {
    expect(resolveSpecifier('src/main.mjs', specifier, new Set(['src/g.mjs', 'src/h.ts', 'src/folder/index.ts'])))
      .toBe(expected);
  });

  it('recognizes Vitest suffixes without mistaking helpers or Playwright specs for tests', () => {
    for (const ext of ['mjs', 'cjs', 'js', 'jsx', 'ts', 'tsx', 'mts', 'cts']) expect(isVitestTestFile(`x.test.${ext}`)).toBe(true);
    for (const path of ['__tests__/helper.mjs', 'x.spec.ts', 'x.test.json']) expect(isVitestTestFile(path)).toBe(false);
  });
});

describe('#5128 — bounded related-test selection', () => {
  it('drops to depth one, keeping direct tests and an unrelated changed test', () => {
    expect(selectHub()).toMatchObject({ status: 'selection-truncated', depth: 1,
      tests: ['changed.test.mjs', 'direct0.test.mjs', 'direct1.test.mjs'],
      fullTestCount: 33, selectedTestCount: 3, droppedCount: 30 });
  });

  it.each([33, 50, 0])('keeps the complete graph when maxTests is %s', maxTests => {
    expect(selectHub({ maxTests })).toMatchObject({ status: 'complete', tests: null,
      fullTestCount: 33, selectedTestCount: 33, droppedCount: 0, depth: null });
  });

  it('treats non-test helpers under __tests__ as zero-cost hops', () => {
    const reverse = graph({ 'hub.mjs': '', '__tests__/helper.mjs': "import '../hub.mjs'",
      '__tests__/a.test.mjs': "import './helper.mjs'", '__tests__/b.test.mjs': "import './helper.mjs'" });
    expect(testDepths(['hub.mjs'], reverse)).toEqual(new Map([
      ['__tests__/a.test.mjs', 1], ['__tests__/b.test.mjs', 1],
    ]));
    expect(selectRelatedTests({ changedFiles: ['hub.mjs'], reverse, maxTests: 1, maxDepth: 2 }))
      .toMatchObject({ status: 'selection-truncated', depth: 1, tests: ['__tests__/a.test.mjs', '__tests__/b.test.mjs'] });
  });

  it('takes the nearest ring when depth one would select no tests', () => {
    const files = hubFiles();
    delete files['direct0.test.mjs'];
    delete files['direct1.test.mjs'];
    expect(selectHub({ changedFiles: ['hub.mjs'], reverse: graph(files) }))
      .toMatchObject({ status: 'selection-truncated', depth: 2, fullTestCount: 30, selectedTestCount: 30,
        tests: Object.keys(files).filter(path => path.startsWith('deep')).sort(), droppedCount: 0 });
  });

  it('ranks changed non-test hubs by transitive reach with direct counts', () => {
    expect(selectHub({ changedFiles: ['mid0.mjs', 'changed.test.mjs', 'hub.mjs'] }).hubs).toEqual([
      { file: 'hub.mjs', direct: 2, transitive: 32 }, { file: 'mid0.mjs', direct: 10, transitive: 10 },
    ]);
  });

  it('always retains every direct importer of any changed file across seeded graphs', () => {
    let seed = 5128;
    const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    for (let trial = 0; trial < 30; trial++) {
      const files = { 'a.mjs': '', 'b.mjs': '', 'mid.mjs': "import './a.mjs'; import './b.mjs'" };
      const direct = [];
      for (let i = 0; i < 12; i++) {
        const target = ['a.mjs', 'b.mjs', 'mid.mjs'][random(3)];
        const test = `t${i}.test.mjs`;
        files[test] = `import './${target}'`;
        if (target !== 'mid.mjs') direct.push(test);
      }
      const selected = selectRelatedTests({ changedFiles: ['a.mjs', 'b.mjs'], reverse: graph(files),
        maxTests: 1 + random(5), maxDepth: 1 + random(3) });
      expect(selected.status).toBe('selection-truncated');
      for (const test of direct) expect(selected.tests).toContain(test);
    }
  });
});
