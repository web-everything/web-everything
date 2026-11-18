/**
 * @file scripts/lib/__tests__/related-test-selection.test.mjs
 * @description #5128 — bounded selection keeps direct importers; all fixtures live in memory.
 */
import { describe, expect, it, vi } from 'vitest';
import { replaySelections, runReplayCli } from '../../readiness/selection-replay.mjs';
import { selectTests } from '../../readiness/test-selection.mjs';
import { buildReverseImportGraph, resolveSpecifier, testDepths, selectRelatedTests, isVitestTestFile, resolvedImportsOf, loadCiSelection } from '../related-test-selection.mjs';

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
const selectHub = overrides => selectRelatedTests({ env: {}, changedFiles: ['hub.mjs', 'changed.test.mjs'],
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

  it('reads vi.mock / importActual style specifiers as edges', () => {
    const files = { 'src/a.mjs': '', 'src/b.mjs': '', 'src/c.mjs': '',
      'src/x.test.mjs': "vi.mock('./a.mjs'); const m = await vi.importActual('./b.mjs'); vi.doMock('./c.mjs', () => ({}))" };
    expect([...graph(files).keys()].sort()).toEqual(['src/a.mjs', 'src/b.mjs', 'src/c.mjs']);
  });

  it.each([
    ['./m.mjs', 'src/m.mts'], ['./folder2', 'src/folder2/index.tsx'], ['./folder3', 'src/folder3/index.cjs'],
    ['./g', 'src/g.mjs'], ['./h.js', 'src/h.ts'], ['./g.mjs?raw', 'src/g.mjs'],
    ['./folder', 'src/folder/index.ts'], ['node:fs', null], ['vitest', null], ['./missing', null], ['../../outside', null],
  ])('resolves %s to %s', (specifier, expected) => {
    expect(resolveSpecifier('src/main.mjs', specifier, new Set(['src/g.mjs', 'src/h.ts', 'src/folder/index.ts', 'src/m.mts', 'src/folder2/index.tsx', 'src/folder3/index.cjs'])))
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
    expect(selectRelatedTests({ env: {}, changedFiles: ['hub.mjs'], reverse, maxTests: 1, maxDepth: 2 }))
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

  it('keeps a changed hub reachable when an unrelated changed test would otherwise fill the list', () => {
    const files = hubFiles();
    delete files['direct0.test.mjs'];
    delete files['direct1.test.mjs'];
    const selected = selectHub({ reverse: graph(files) });
    expect(selected.status).toBe('selection-truncated');
    expect(selected.tests).toContain('changed.test.mjs');
    expect(selected.tests.filter(path => path.startsWith('deep'))).toHaveLength(30);
    expect(selected.depth).toBe(2);
  });

  it('does not add a ring for a changed file whose direct tests already run', () => {
    expect(selectHub().tests).toEqual(['changed.test.mjs', 'direct0.test.mjs', 'direct1.test.mjs']);
  });

  it('keeps the direct importer of a changed JSON fixture alongside a truncated hub', () => {
    const files = { ...hubFiles(), 'fixtures/data.json': '{}', 'json-user.test.mjs': "import data from './fixtures/data.json'" };
    const selected = selectHub({ changedFiles: ['hub.mjs', 'fixtures/data.json'], reverse: graph(files) });
    expect(selected.status).toBe('selection-truncated');
    expect(selected.tests).toContain('json-user.test.mjs');
    expect(selected.directTestCount).toBe(3);
  });

  it('skips a tracked file that cannot be read (deleted in the working tree) without dropping the rest of the graph', () => {
    const files = hubFiles();
    const reverse = buildReverseImportGraph({ files: [...Object.keys(files), 'gone.mjs'],
      readFile: path => { if (path === 'gone.mjs') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files[path]; } });
    expect(selectRelatedTests({ env: {}, changedFiles: ['hub.mjs', 'changed.test.mjs'], reverse, maxTests: 5, maxDepth: 2 }))
      .toMatchObject({ status: 'selection-truncated', depth: 1, tests: ['changed.test.mjs', 'direct0.test.mjs', 'direct1.test.mjs'] });
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
      const selected = selectRelatedTests({ env: {}, changedFiles: ['a.mjs', 'b.mjs'], reverse: graph(files),
        maxTests: 1 + random(5), maxDepth: 1 + random(3) });
      expect(selected.status).toBe('selection-truncated');
      for (const test of direct) expect(selected.tests).toContain(test);
    }
  });
});


describe('S1 static edges', () => {
  const reach = (source, changed = 'scripts/child.mjs', extra = {}, options = {}) => {
    const files = { [changed]: '', 'scripts/__tests__/edge.test.mjs': source, ...extra };
    return testDepths([changed], buildReverseImportGraph({ files: Object.keys(files), readFile: p => files[p], ...options }));
  };
  it.each([
    "const p = join(dir, '..', 'child.mjs'); spawn('node', [p]);",
    "execFile('node', [resolve(dir, '..', 'child.mjs')]);",
    "fork(new URL('../child.mjs', import.meta.url));",
    "spawn('node', ['scripts/child.mjs']);",
  ])('reaches a spawned path: %s', source => {
    expect([...reach(source).keys()]).toEqual(['scripts/__tests__/edge.test.mjs']);
  });
  it.each([
    "readFileSync('scripts/settings/policy.json', 'utf8')",
    "await fs.promises.readFile(new URL('../settings/policy.json', import.meta.url))",
    "readFile(join(dir, '..', 'settings', 'policy.json'), callback)",
    "readFileSync(resolve(dir, '..', 'settings', 'policy.json'), 'utf8')",
  ])('reaches literal settings reads: %s', source => {
    expect(reach(source, 'scripts/settings/policy.json').size).toBe(1);
  });
  it('uses ordinary transitive edges through a helper which spawns and reads', () => {
    for (const source of ["spawn('node', ['scripts/child.mjs'])", "readFileSync('scripts/child.mjs')"]) {
      expect(reach("import '../helper.mjs'", undefined, { 'scripts/helper.mjs': source }).size).toBe(1);
    }
  });
  it('resolves we, tsconfig aliases and vendored Frontier targets; retains external textual keys', () => {
    const files = new Set(['src/x.ts', 'plugs/x.ts']);
    expect(resolvedImportsOf('test.mjs', "import 'we:src/x'; import '@local/x'; import '@frontierui/plugs/x'", files,
      { aliases: { '@local/*': ['src/*'], '@frontierui/plugs/*': ['../frontierui/plugs/*'] } }).sort())
      .toEqual(['@frontierui/plugs/x', '@local/x', 'plugs/x.ts', 'src/x.ts']);
    expect(resolvedImportsOf('test.mjs', "import '@frontierui/plugs/external'", files)).toContain('@frontierui/plugs/external');
  });
  it('allows each static edge kind to be disabled for the import-only replay', () => {
    expect(reach("spawn('node', ['scripts/child.mjs']); readFileSync('scripts/child.mjs'); import 'we:scripts/child.mjs'",
      undefined, {}, { staticEdges: { spawnPath: false, literalRead: false, alias: false } }).size).toBe(0);
  });
  it('preserves the observed merge-gate-hold-class direct imports, including multiple named imports', () => {
    expect(reach(`// @vitest-environment node
      import { isCandidacyHold, deferCandidacyHoldsOnPrEvent } from '../merge-gate-hold-class.mjs';
      import { parsePrResultTable as rawParse } from '../merge-gate-hold-class.mjs';`, 'scripts/merge-gate-hold-class.mjs').size).toBe(1);
  });
  it('reports partial truncation and unlimited CI despite caller and environment caps', () => {
    expect(selectHub()).toMatchObject({ partial: true, status: 'selection-truncated' });
    for (const env of [{ CI: 'true' }, { GITHUB_ACTIONS: 'true', WE_CI_SELECTION: '{"maxTests":1,"maxTestsInCi":1}' }]) {
      expect(selectHub({ env })).toMatchObject({ partial: false, maxTests: 0, status: 'complete', fullTestCount: 33 });
    }
  });
  it('validates settings, falls back on malformed input, and records cascade sources', () => {
    const log = [];
    const load = extra => loadCiSelection({ platform: {}, tool: {}, env: {}, ...extra });
    expect(load({ readFile: () => '{', tool: undefined }).maxTests).toBe(0);
    expect(load({ env: { WE_CI_SELECTION: '{' } }).maxTests).toBe(0);
    expect(load({ tool: { maxTests: -1, maxTestsInCi: 5 } }).maxTests).toBe(0);
    expect(load({ env: { WE_CI_SELECTION: '{"maxTests":1.5}' } }).maxTests).toBe(0);
    expect(load({ tool: { maxTests: 5 }, env: { WE_CI_SELECTION: '{"maxTests":7}', WE_POLICY_CASCADE_LOG: '1' }, log: s => log.push(s) }).maxTests).toBe(7);
    expect(log.join(' ')).toMatch(/maxTests=7.*env/);
    expect(load({ tool: { staticEdges: { literalRead: 'bad' } } }).staticEdges.literalRead).toBe(true);
  });
  it('replays missing edges and marks absent historical test evidence incomplete', () => {
    const files = { 'scripts/child.mjs': '', 'edge.test.mjs': "spawn('node', ['scripts/child.mjs'])" };
    expect(replaySelections({ records: [{ pr: '7094', changedFiles: ['scripts/child.mjs'], testFiles: ['edge.test.mjs'], evidenceComplete: true }],
      files: Object.keys(files), readFile: p => files[p] })[0]).toMatchObject({ oldMissed: ['edge.test.mjs'], newMissed: [], evidenceComplete: true });
    const io = { runGh: () => 'scripts/child.mjs', runGit: () => Object.keys(files).join('\n'), readFile: p => files[p], print: () => {} };
    expect(runReplayCli(['7094'], io)[0].evidenceComplete).toBe(false);
    expect(() => runReplayCli(['7094', '--evidence=e.json'], { ...io, readFile: () => '{' })).toThrow();
    expect(() => runReplayCli(['$(bad)'], io)).toThrow();
  });
  it('falls back to full selection for deleted dependency targets', () => {
    const importer = 'docs/__tests__/importer.test.mjs';
    const files = { [importer]: "import '../deleted.mjs'" };
    const result = selectTests({ env: { WE_DIFF_TEST_SELECTION: '1' },
      runGit: args => args[0] === 'merge-base' ? 'abc' : 'docs/deleted.mjs',
      files: Object.keys(files), readFile: p => files[p] });
    // A committed deletion is absent from ls-files, so no surviving import edge resolves.
    expect(testDepths(['docs/deleted.mjs'], graph(files)).has(importer)).toBe(false);
    // Full mode runs every test, including the surviving importer that the graph would omit.
    expect(result).toMatchObject({ mode: 'full', partial: false,
      reasons: [expect.stringContaining('absent from tracked inventory (docs/deleted.mjs)')] });
    expect(result).not.toHaveProperty('selection');
  });
  it('composes explicit static tests and partial reasons in readiness selection', () => {
    const files = { 'docs/hub.mjs': '', 'direct.test.mjs': "readFileSync('docs/hub.mjs')",
      'mid.mjs': "spawn('node', ['docs/hub.mjs'])", 'deep.test.mjs': "import './mid.mjs'" };
    const options = { env: { WE_DIFF_TEST_SELECTION: '1' }, runGit: args => args[0] === 'merge-base' ? 'abc' : 'docs/hub.mjs',
      files: Object.keys(files), readFile: p => files[p], maxTests: 1, maxDepth: 1 };
    expect(selectTests({ ...options, files: null })).toMatchObject({ mode: 'full', partial: false,
      reasons: [expect.stringContaining('inventory unavailable')] });
    expect(selectTests(options)).toMatchObject({ mode: 'shrink', partial: true, selectedFiles: ['direct.test.mjs'],
      reasons: expect.arrayContaining([expect.stringContaining('partial:')]) });
    expect(selectTests({ ...options, env: { ...options.env, CI: 'true' } })).toMatchObject({ partial: false,
      selectedFiles: ['deep.test.mjs', 'direct.test.mjs'] });
  });
});


describe('readiness graph selection fails closed', () => {
  const select = (files, readFile = path => files[path], changed = 'docs/x.mjs') => selectTests({
    env: { WE_DIFF_TEST_SELECTION: '1' }, files: Object.keys(files), readFile,
    runGit: args => args[0] === 'merge-base' ? 'abc' : changed,
  });

  it('runs the full suite when a non-test change reaches zero graph tests', () => {
    const result = select({ 'docs/x.mjs': '', 'unrelated.test.mjs': '' });
    expect(result).toMatchObject({ mode: 'full', partial: false,
      reasons: [expect.stringContaining('zero tests for non-test changed files')] });
    expect(result).not.toHaveProperty('selection');
  });

  it('resolves a side-effect import with an inline comment and selects its test', () => {
    const files = { 'docs/x.mjs': '', 'docs/__tests__/x.test.mjs': 'import /* c */ "../x.mjs"' };
    expect(resolvedImportsOf('docs/__tests__/x.test.mjs', files['docs/__tests__/x.test.mjs'], new Set(Object.keys(files))))
      .toEqual(['docs/x.mjs']);
    expect(select(files)).toMatchObject({ mode: 'shrink', selectedFiles: ['docs/__tests__/x.test.mjs'] });
  });

  it('counts injected EACCES sources and runs the full suite despite a surviving test edge', () => {
    const files = { 'docs/x.mjs': '', 'direct.test.mjs': 'import "./docs/x.mjs"',
      'denied.mjs': '', 'denied.test.mjs': '' };
    const readFile = path => {
      if (path.startsWith('denied')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return files[path];
    };
    const reverse = buildReverseImportGraph({ files: Object.keys(files), readFile });
    expect(reverse.unreadable).toBe(2);
    expect(Object.keys(reverse)).not.toContain('unreadable');
    expect(testDepths(['docs/x.mjs'], reverse).has('direct.test.mjs')).toBe(true);
    const result = select(files, readFile);
    expect(result).toMatchObject({ mode: 'full', partial: false,
      reasons: [expect.stringContaining('2 unreadable graph source(s)')] });
    expect(result).not.toHaveProperty('selection');
  });

  it('keeps a changed test selected when it has no imports', () => {
    expect(select({ 'docs/x.test.mjs': '' }, undefined, 'docs/x.test.mjs'))
      .toMatchObject({ mode: 'shrink', selectedFiles: ['docs/x.test.mjs'] });
  });
});

describe('CI static edge policy', () => {
  const allEdges = { spawnPath: true, alias: true, literalRead: true };
  const cases = ['spawnPath', 'alias', 'literalRead'].flatMap(edge => ['env', 'file', 'platform'].map(layer => [edge, layer]));
  const load = (edge, layer, env) => {
    const staticEdges = { ...allEdges, [edge]: false };
    return loadCiSelection({ env: { ...env, ...(layer === 'env' ? { WE_CI_SELECTION: JSON.stringify({ staticEdges }) } : {}) },
      platform: layer === 'platform' ? { staticEdges } : {}, tool: layer === 'file' ? undefined : {},
      readFile: () => JSON.stringify({ ci: { selection: { staticEdges } } }) });
  };

  it.each(cases)('ignores disabling %s via %s under either CI flag', (edge, layer) => {
    for (const flag of ['CI', 'GITHUB_ACTIONS']) {
      expect(load(edge, layer, { [flag]: 'true' }).staticEdges).toEqual(allEdges);
    }
  });

  it.each(cases)('allows disabling %s via %s outside CI', (edge, layer) => {
    expect(load(edge, layer, {}).staticEdges).toEqual({ ...allEdges, [edge]: false });
  });

  it('keeps import-only replay explicit options effective with process.env.CI set', () => {
    vi.stubEnv('CI', 'true');
    try {
      expect(loadCiSelection({ tool: {}, platform: {}, env: { ...process.env,
        WE_CI_SELECTION: JSON.stringify({ staticEdges: { ...allEdges, spawnPath: false } }) } }).staticEdges).toEqual(allEdges);
      const files = { 'scripts/child.mjs': '', 'edge.test.mjs': "spawn('node', ['scripts/child.mjs'])" };
      expect(replaySelections({ records: [{ pr: '7094', changedFiles: ['scripts/child.mjs'],
        testFiles: ['edge.test.mjs'], evidenceComplete: true }], files: Object.keys(files), readFile: path => files[path] })[0])
        .toMatchObject({ oldMissed: ['edge.test.mjs'], newMissed: [] });
    } finally { vi.unstubAllEnvs(); }
  });
});
