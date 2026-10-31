// @repo-scanning-test scope=full — ownership coverage and CLI totals require the complete tracked inventory.
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { classify, existingTrackedPaths, totals } from '../constellation-ownership.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const map = JSON.parse(readFileSync(resolve(root, 'config/constellation-ownership.json'), 'utf8'));
const tracked = existingTrackedPaths(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  .split('\0').filter(Boolean));
const proposed = ['config/constellation-ownership.json', 'scripts/lib/constellation-ownership.mjs',
  'scripts/lib/__tests__/constellation-ownership.test.mjs'];
const paths = [...new Set([...tracked, ...proposed])];
const fixture = rules => ({ order: 'first-match', rules });

describe('constellation ownership', () => {
  it('A1: assigns every tracked file exactly once, including the proposed files', () => {
    const { files } = classify(paths, map);
    expect(files).toHaveLength(paths.length);
    expect(new Set(files.map(file => file.path)).size).toBe(paths.length);
    expect(tracked.every(path => files.some(file => file.path === path))).toBe(true);
  });

  it('A2: keeps executable implementation out of standard-def and prints S4 reclassifications', () => {
    const { files, reclassified } = classify(paths, map);
    expect(files.filter(file => file.destination === 'standard-def' &&
      /\.(?:mjs|cjs|js|ts|sh)$/.test(file.path) &&
      /^(?:scripts\/|eleventy\/|src\/|\.eleventy\.)/.test(file.path))).toEqual([]);
    expect(reclassified.length).toBeGreaterThan(0);
    expect(reclassified).toEqual(files.filter(file => file.original && file.original !== file.destination)
      .map(({ path, original, destination }) => ({ path, original, destination })));
    expect(classify(['scripts/gen-inventory.mjs'], map).reclassified)
      .toContainEqual({ path: 'scripts/gen-inventory.mjs', original: 'standard-def', destination: 'plateau' });
    console.log('S4 reclassified paths:\n' + JSON.stringify(reclassified, null, 2));
  });

  it('A3: separates conformance, delivery rules, definitions, data, config and product code', () => {
    const cases = {
      'scripts/check-standards.mjs': 'everstandards-conformance',
      'scripts/check-app-conformance.mjs': 'everstandards-conformance',
      'scripts/lib/validate-rules-anchors.cjs': 'everstandards-conformance',
      'capabilities/check.ts': 'everstandards-conformance',
      'capability-manifest/check.ts': 'everstandards-conformance',
      'scripts/web-rules/example.mjs': 'everstandards-conformance',
      'scripts/validators/example.mjs': 'everstandards-conformance',
      'scripts/check-standards-rules.mjs': 'longshore',
      'scripts/check-backlog-item.mjs': 'longshore',
      'scripts/backlog/operator-task.mjs': 'longshore',
      'scripts/delivery-rules/example.mjs': 'longshore',
      'scripts/operations/start-build.mjs': 'longshore',
      'scripts/lane-pool.mjs': 'longshore',
      'scripts/gen-decision-docket.mjs': 'plateau',
      'scripts/progress-board.mjs': 'plateau',
      'scripts/produce-pr-view.mjs': 'plateau',
      'scripts/codex-usage-report.mjs': 'plateau',
      'scripts/lib/component-render-build-hook.cjs': 'plateau',
      'eleventy/filters.cjs': 'plateau',
      'src/_data/blocks.js': 'plateau',
      'src/index.njk': 'plateau',
      'src/_data/blocks/button.json': 'standard-def',
      'src/_includes/block-descriptions/button.njk': 'standard-def',
      'contracts/backlog.ts': 'standard-def',
      'contracts/types.d.ts': 'standard-def',
      'backlog/example.md': 'data-by-topic',
      'src/_data/researchTopics/example.json': 'data-by-topic',
      'agent-memory-src/example.md': 'data-by-topic',
      'AGENTS.md': 'repo-local',
      '.github/workflows/example.yml': 'repo-local',
      'config/constellation-ownership.json': 'repo-local',
    };
    for (const file of classify(Object.keys(cases), map).files) expect(file.destination, file.path).toBe(cases[file.path]);
  });

  it('A4: prints file/line totals for all six destinations summing to the tracked inventory', () => {
    const result = totals(classify(tracked, map).files);
    expect(Object.keys(result).sort()).toEqual([...map.destinations].sort());
    expect(Object.values(result).reduce((sum, entry) => sum + entry.files, 0)).toBe(tracked.length);
    expect(Object.values(result).every(entry => Number.isInteger(entry.lines) && entry.lines >= 0)).toBe(true);
    console.log('Tracked ownership baseline:\n' + JSON.stringify(result, null, 2));
  });

  it('runs classify --json against git ls-files and includes totals and reclassifications', () => {
    const result = JSON.parse(execFileSync(process.execPath,
      ['scripts/lib/constellation-ownership.mjs', 'classify', '--json'],
      { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
    expect(result.files.map(file => file.path)).toEqual(tracked);
    expect(result.totals).toEqual(totals(result.files));
    expect(result.reclassified.length).toBeGreaterThan(0);
    expect(() => execFileSync(process.execPath,
      ['scripts/lib/constellation-ownership.mjs', 'invalid'],
      { cwd: root, stdio: 'pipe' })).toThrow();
  });

  it.each(['existing', 'missing'])('counts stored symlink text without following an %s target', targetState => {
    const scratch = mkdtempSync(join(tmpdir(), 'constellation-ownership-'));
    try {
      if (targetState === 'existing') writeFileSync(join(scratch, 'target.txt'), 'one\ntwo\nthree\n');
      const link = join(scratch, 'link.txt');
      symlinkSync('target.txt', link);
      expect(existingTrackedPaths([relative(root, link)])).toEqual([relative(root, link)]);
      // Use the default filesystem reader, not the injected buffer-counting seam.
      const result = totals([{ path: relative(root, link), destination: 'plateau' }]);
      expect(result.plateau).toEqual({ files: 1, lines: 1 });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it.each(['ENOENT', 'ENOTDIR', 'EACCES'])('handles working-tree inventory errors in the CLI (%s)', code => {
    // Select present paths so deleting a particular fixture cannot break the scanner itself.
    const deleted = code === 'ENOENT' ? tracked.find(path => path.startsWith('backlog/'))
      : classify(tracked, map).reclassified[0]?.path;
    expect(deleted).toBeDefined();
    const preload = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const lstat = fs.lstatSync;
      fs.lstatSync = (path, ...args) => {
        if (String(path) === ${JSON.stringify(resolve(root, deleted))}) {
          throw Object.assign(new Error('simulated unstaged deletion'), { code: ${JSON.stringify(code)} });
        }
        return lstat(path, ...args);
      };
      syncBuiltinESMExports();
    `;
    const child = spawnSync(process.execPath,
      ['--import', 'data:text/javascript,' + encodeURIComponent(preload),
        'scripts/lib/constellation-ownership.mjs', 'classify', '--json'],
      { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
    if (code === 'EACCES') {
      expect(child.status).toBe(1);
      expect(child.stderr).toBe('"simulated unstaged deletion"\n');
      expect(child.stdout).toBe('');
      return;
    }
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    const result = JSON.parse(child.stdout);
    const remaining = tracked.filter(path => path !== deleted);
    expect(result.files.map(file => file.path)).toEqual(remaining);
    expect(result.reclassified.some(file => file.path === deleted)).toBe(false);
    expect(result.totals).toEqual(totals(classify(remaining, map).files));
  });

  it('filters absent paths and missing or non-directory parents without dropping existing files', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'constellation-ownership-'));
    try {
      writeFileSync(join(scratch, 'present.txt'), 'one\n');
      const paths = ['missing.txt', 'missing/child.txt', 'present.txt/child.txt', 'present.txt']
        .map(path => relative(root, join(scratch, path)));
      expect(existingTrackedPaths(paths)).toEqual([relative(root, join(scratch, 'present.txt'))]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('counts one working-tree leaf for repeated unmerged index paths', () => {
    expect(existingTrackedPaths(['AGENTS.md', 'AGENTS.md', 'AGENTS.md'])).toEqual(['AGENTS.md']);
  });

  it('counts empty files, final unterminated lines and binary files deterministically', () => {
    const files = classify(['empty', 'terminated', 'unterminated', 'binary'], fixture([
      { glob: '*', destination: 'plateau' },
    ])).files;
    const contents = { empty: '', terminated: 'one\ntwo\n', unterminated: 'three', binary: '\0\n' };
    expect(totals(files, path => Buffer.from(contents[path])).plateau).toEqual({ files: 4, lines: 3 });
    expect(() => totals(files, () => { throw new Error('unreadable'); })).toThrow('unreadable');
  });

  it('fails closed on unclassified paths and undeclared cross-destination overlaps', () => {
    expect(() => classify(['unknown/file'], fixture([]))).toThrow(/unclassified/i);
    expect(() => classify(['scripts/run.mjs'], fixture([
      { glob: 'scripts/*.mjs', destination: 'plateau' },
      { glob: 'scripts/**', destination: 'longshore' },
    ]))).toThrow(/double-classified/i);
  });

  it.each([
    'unknown-root/file.ts',
    'unknown-root/check.ts',
    'unknown-root/types.d.ts',
    'unknown-root/nested/check.ts',
    'unknown-root/nested/types.d.ts',
    'capabilities-other/check.ts',
    'contracts-other/types.d.ts',
  ])('fails closed with the production map on unknown-root path %s', path => {
    expect(() => classify([path], map)).toThrow(`Unclassified path: ${path}; add an ownership rule before retrying`);
  });

  it('honors explicit earlier overrides and rejects hidden overlaps between later rules', () => {
    const rules = [
      { glob: 'scripts/special.mjs', destination: 'plateau', override: true },
      { glob: 'scripts/*.mjs', destination: 'longshore', override: true },
      { glob: 'scripts/**', destination: 'repo-local' },
    ];
    expect(classify(['scripts/special.mjs'], fixture(rules)).files[0].destination).toBe('plateau');
    expect(() => classify(['scripts/special.mjs'], fixture(rules.map((rule, i) =>
      i === 1 ? { ...rule, override: false } : rule)))).toThrow(/double-classified/i);
  });

  it('matches globstar across zero or many directories without matching sibling prefixes', () => {
    const rules = [{ glob: 'src/**/*.json', destination: 'standard-def' }];
    expect(classify(['src/a.json', 'src/nested/a.json'], fixture(rules)).files).toHaveLength(2);
    expect(() => classify(['src-other/a.json'], fixture(rules))).toThrow(/unclassified/i);
    expect(classify(['a'], fixture([
      { glob: '*', destination: 'plateau' }, { glob: '**', destination: 'plateau' },
    ])).files).toHaveLength(1);
  });

  it('? matches exactly one non-slash character', () => {
    const rules = [{ glob: 'src/file?.json', destination: 'standard-def' }];
    expect(classify(['src/filea.json', 'src/file1.json'], fixture(rules)).files).toHaveLength(2);
    for (const path of ['src/file.json', 'src/fileab.json', 'src/file/.json']) {
      expect(() => classify([path], fixture(rules))).toThrow(/unclassified/i);
    }
  });

  it('matches globs case-sensitively', () => {
    const rules = [{ glob: 'src/File.json', destination: 'standard-def' }];
    expect(classify(['src/File.json'], fixture(rules)).files).toHaveLength(1);
    for (const path of ['src/file.json', 'Src/File.json']) {
      expect(() => classify([path], fixture(rules))).toThrow(/unclassified/i);
    }
  });

  it.each([
    'src/{a,b}.json',
    'src/[ab].json',
    '!src/**',
    'src/../file.json',
    'src/./file.json',
    '/src/**',
    '\\src/**',
  ])('throws on invalid glob %s', glob => {
    expect(() => classify([], fixture([{ glob, destination: 'standard-def' }])))
      .toThrow('Invalid repository path glob');
  });

  it('refuses invalid maps, duplicate input paths and unsafe non-repository paths', () => {
    expect(() => classify([], { order: 'last-match', rules: [] })).toThrow(/order/i);
    expect(() => classify([], fixture([{ glob: '**', destination: 'unknown' }]))).toThrow(/destination/i);
    expect(() => classify([], fixture([{ glob: '**', destination: 'plateau', original: 'unknown' }]))).toThrow(/original/i);
    expect(() => classify(['a', 'a'], fixture([{ glob: '*', destination: 'plateau' }]))).toThrow(/duplicate/i);
    for (const path of ['../secret', '/secret', 'a/../secret', 'a\\secret']) {
      expect(() => classify([path], fixture([{ glob: '**', destination: 'plateau' }]))).toThrow(/path/i);
    }
  });
});
