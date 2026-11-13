import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { sourceNeedsGit, testFilterArgs, routeNeedsGit, selectionUnproven, NEEDS_GIT_REASON } from '../needs-git-route.mjs';

describe('sourceNeedsGit', () => {
  it('detects direct git spawns', () => {
    const cp = "import * as cp from 'node:child_process';\n";
    expect(sourceNeedsGit(cp + "cp.execFileSync('git', ['ls-files', '-z'])")).toBe(true);
    expect(sourceNeedsGit(cp + 'spawnSync("git", args)')).toBe(true);
    expect(sourceNeedsGit(cp + "execSync('git status')")).toBe(true);
    expect(sourceNeedsGit(cp + 'execSync(`git -C ${dir} log`)')).toBe(true);
    expect(sourceNeedsGit(cp + "const bin = 'git'; run(bin, [])")).toBe(true);
    expect(sourceNeedsGit("import { execFileSync as run } from 'child_process'; run('/usr/bin/git', [])")).toBe(true);
  });
  it('detects declared git helper imports', () => {
    expect(sourceNeedsGit("import { x } from '../git-helper.mjs';", { helpers: ['git-helper.mjs'] })).toBe(true);
  });
  it('does not flag prose or non-spawn mentions', () => {
    expect(sourceNeedsGit("const msg = 'run git later'; execFileSync('node', ['x'])")).toBe(false);
    expect(sourceNeedsGit("execFileSync('gitleaks', [])")).toBe(false);
    expect(sourceNeedsGit('')).toBe(false);
    expect(sourceNeedsGit("import { spawn } from 'node:child_process';\n// spawn('git', [])\n/* execSync('git x') */")).toBe(false);
    expect(sourceNeedsGit("import { spawnSync } from 'node:child_process'; const g = '**/*'; /* c */ spawnSync('git', []); // end")).toBe(true);
    expect(sourceNeedsGit("vi.mock('x'); spawnSync('git', [])")).toBe(false);
    expect(sourceNeedsGit("import a from '../my-git-helper.mjs'", { helpers: ['git-helper.mjs'] })).toBe(true);
    expect(sourceNeedsGit("// from '../git-helper.mjs'", { helpers: ['git-helper.mjs'] })).toBe(false);
  });
});

describe('testFilterArgs', () => {
  it('extracts filters from vitest argv', () => {
    expect(testFilterArgs(['npm', 'run', 'test:unit', '--', 'a.test.mjs', '--silent', 'b.test.mjs'])).toEqual(['a.test.mjs', 'b.test.mjs']);
    expect(testFilterArgs(['vitest', 'run', 'a.test.mjs'])).toEqual(['a.test.mjs']);
  });
  it('returns [] for non-test commands', () => {
    expect(testFilterArgs(['npm', 'run', 'check:standards'])).toEqual([]);
  });
  it('skips values of valued flags', () => {
    expect(testFilterArgs(['vitest', 'run', '--config', 'vitest.x.ts', 'a.test.mjs'])).toEqual(['a.test.mjs']);
  });
});

describe('routeNeedsGit', () => {
  const files = { 'a.test.mjs': "import { execFileSync } from 'node:child_process'; execFileSync('git', ['ls-files'])", 'b.test.mjs': 'expect(1).toBe(1)' };
  const readFile = (p) => { if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files[p]; };
  it('routes local with reason needs-git and lists the files', () => {
    const r = routeNeedsGit({ argv: ['vitest', 'run', 'a.test.mjs', 'b.test.mjs'], readFile });
    expect(r).toEqual({ local: true, reason: NEEDS_GIT_REASON, files: ['a.test.mjs'] });
    expect(NEEDS_GIT_REASON).toBe('needs-git');
  });
  it('stays remote when no selected file needs git', () => {
    expect(routeNeedsGit({ argv: ['vitest', 'run', 'b.test.mjs'], readFile })).toEqual({ local: false });
  });
  it('stays remote for unreadable files and non-test commands (no over-routing)', () => {
    expect(routeNeedsGit({ argv: ['vitest', 'run', 'missing.test.mjs'], readFile })).toEqual({ local: false });
    expect(routeNeedsGit({ argv: ['npm', 'run', 'check:standards'], readFile })).toEqual({ local: false });
  });
  it('honours a declared list', () => {
    expect(routeNeedsGit({ argv: ['vitest', 'run', 'b.test.mjs'], readFile, declared: ['b.test.mjs'] }))
      .toEqual({ local: true, reason: 'needs-git', files: ['b.test.mjs'] });
  });
  it('default reader refuses outside-root, traversal and non-files (R807: and routes them local)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ngr-'));
    try {
      mkdirSync(join(dir, 'sub'));
      const body = "import 'node:child_process'; spawnSync('git', [])";
      writeFileSync(join(dir, 'in.test.mjs'), body);
      writeFileSync(join(dir, '..', `out-${process.pid}.test.mjs`), body);
      expect(routeNeedsGit({ argv: ['vitest', 'run', 'in.test.mjs'], cwd: dir }).local).toBe(true);
      expect(routeNeedsGit({ argv: ['vitest', 'run', `../out-${process.pid}.test.mjs`], cwd: dir })).toMatchObject({ local: true, reason: 'needs-git' }); // R807: fail closed
      expect(routeNeedsGit({ argv: ['vitest', 'run', 'sub'], cwd: dir })).toMatchObject({ local: true, reason: 'needs-git' });
      expect(routeNeedsGit({ argv: ['vitest', 'run', 'src/**'], cwd: dir })).toMatchObject({ local: true, reason: 'needs-git' });
    } finally { rmSync(join(dir, '..', `out-${process.pid}.test.mjs`), { force: true }); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('related + unproven selections (bundle transport)', () => {
  const read = (p) => { if (p === 'pure.test.mjs') return 'export {}'; if (p === 'git.test.mjs') return "import 'node:child_process'; run('git', [])"; throw Object.assign(new Error('x'), { code: 'ENOENT' }); };
  it('reads filters after vitest related', () => {
    expect(testFilterArgs(['npx', 'vitest', 'related', 'a.mjs'])).toEqual(['a.mjs']);
    expect(routeNeedsGit({ argv: ['npx', 'vitest', 'related', 'git.test.mjs'], readFile: read }).local).toBe(true);
  });
  it('plans a bundle for a selection it cannot prove git-free, not for a proven one', () => {
    expect(selectionUnproven({ argv: ['npx', 'vitest', 'run', 'pure.test.mjs'], readFile: read })).toBe(false);
    expect(selectionUnproven({ argv: ['npx', 'vitest', 'run', 'dir/*'], readFile: read })).toBe(true);
    expect(selectionUnproven({ argv: ['npx', 'vitest', 'run'], readFile: read })).toBe(true);
    expect(selectionUnproven({ argv: ['npx', 'vitest', 'run', 'git.test.mjs'], readFile: read })).toBe(true);
    expect(selectionUnproven({ argv: ['npx', 'vitest', 'related', 'pure.test.mjs'], readFile: read })).toBe(true);
    expect(selectionUnproven({ argv: ['node', 'x.mjs'], readFile: read })).toBe(false);
  });
  // Review finding 1: an absent plain name is a vitest substring filter; it may select a git-using test, so it stays unproven.
  it('treats an absent plain name (substring filter) as unproven', () => {
    expect(selectionUnproven({ argv: ['npx', 'vitest', 'run', 'constellation-ownership.test.mjs'], readFile: read })).toBe(true);
    expect(selectionUnproven({ argv: ['npm', 'run', 'test:unit', '--', 'ownership'], readFile: read })).toBe(true);
    expect(selectionUnproven({ argv: ['npx', 'vitest', 'run', 'pure.test.mjs', 'absent-name'], readFile: read })).toBe(true);
  });
  // Review finding 2: the value of a test-name option is not a file filter.
  it('consumes the value of test-name and other valued options', () => {
    for (const flag of ['-t', '--testNamePattern', '--test-name-pattern', '--exclude', '--shard', '--pool', '--environment', '--outputFile']) {
      expect(testFilterArgs(['npm', 'run', 'test:unit', '--', flag, 'package.json'])).toEqual([]);
      expect(testFilterArgs(['npx', 'vitest', 'run', flag, 'package.json', 'a.test.mjs'])).toEqual(['a.test.mjs']);
    }
  });
  it('plans a bundle when only a test-name option value is given', () => {
    const readAny = () => 'export {}'; // package.json exists and is git-free, yet no file filter was named
    expect(selectionUnproven({ argv: ['npm', 'run', 'test:unit', '--', '-t', 'package.json'], readFile: readAny })).toBe(true);
    expect(selectionUnproven({ argv: ['npx', 'vitest', 'run', '--testNamePattern', 'package.json'], readFile: readAny })).toBe(true);
    expect(selectionUnproven({ argv: ['npx', 'vitest', 'run', '--testNamePattern=package.json'], readFile: readAny })).toBe(true);
  });
  it('does not read the value of --workspace/--runner as a file filter, and bundles --changed selections', () => {
    const readAny = () => 'export {}';
    expect(selectionUnproven({ argv: ['npx', 'vitest', 'run', '--workspace', 'package.json'], readFile: readAny })).toBe(true);
    expect(selectionUnproven({ argv: ['npx', 'vitest', 'run', '--runner', 'package.json'], readFile: readAny })).toBe(true);
    expect(selectionUnproven({ argv: ['npx', 'vitest', 'run', '--changed', 'a.test.mjs'], readFile: readAny })).toBe(true);
    expect(selectionUnproven({ argv: ['npx', 'vitest', 'run', '--changed=HEAD~1', 'a.test.mjs'], readFile: readAny })).toBe(true);
  });
  // Round 2: a readable filter is a substring filter, so it also selects every other file whose path contains it.
  describe('a readable filter that also selects other files', () => {
    const GIT = "import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['rev-parse', 'HEAD']);\n";
    const mk = (files) => {
      const dir = mkdtempSync(join(tmpdir(), 'ngr-'));
      for (const [p, body] of Object.entries(files)) { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), body); }
      return dir;
    };
    const unproven = (dir, ...args) => selectionUnproven({ argv: ['npx', 'vitest', 'run', ...args], cwd: dir });
    it('is unproven when a sibling path containing the filter spawns git', () => {
      const dir = mk({ 'pure.test.mjs': 'export {};\n', 'nested/prefix-pure.test.mjs': GIT });
      try { expect(unproven(dir, 'pure.test.mjs')).toBe(true); } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    it('matches case-insensitively like vitest', () => {
      const dir = mk({ 'pure.test.mjs': 'export {};\n', 'nested/Prefix-PURE.test.mjs': GIT });
      try { expect(unproven(dir, 'pure.test.mjs')).toBe(true); } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    it('is proven when every path containing the filter is git-free, and ignores node_modules and non-code files', () => {
      const dir = mk({ 'pure.test.mjs': 'export {};\n', 'nested/prefix-pure.test.mjs': 'export {};\n', 'node_modules/x/pure.test.mjs': GIT, 'notes/pure.test.mjs.md': GIT });
      try { expect(unproven(dir, 'pure.test.mjs')).toBe(false); } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    it('is unproven when a matching sibling cannot be read', () => {
      const listed = selectionUnproven({ argv: ['npx', 'vitest', 'run', 'pure.test.mjs'], readFile: (p) => { if (p === 'pure.test.mjs') return 'export {};'; throw new Error('EACCES'); }, listFiles: () => ['a/pure.test.mjs'] });
      expect(listed).toBe(true);
    });
    it('is unproven when the file listing fails', () => {
      const boom = () => { throw new Error('walk-too-large'); };
      expect(selectionUnproven({ argv: ['npx', 'vitest', 'run', 'pure.test.mjs'], readFile: () => 'export {};', listFiles: boom })).toBe(true);
    });
    it('is unproven when two filters are given and only the second also selects a git-using sibling', () => {
      const dir = mk({ 'a.test.mjs': 'export {};\n', 'b.test.mjs': 'export {};\n', 'x/prefix-b.test.mjs': GIT });
      try { expect(unproven(dir, 'a.test.mjs', 'b.test.mjs')).toBe(true); } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  });
  it('still proves a named git-free file alongside a test-name option', () => {
    expect(selectionUnproven({ argv: ['npx', 'vitest', 'run', '-t', 'x', 'pure.test.mjs'], readFile: read })).toBe(false);
  });
});
