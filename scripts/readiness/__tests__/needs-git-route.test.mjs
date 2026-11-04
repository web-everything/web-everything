import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { sourceNeedsGit, testFilterArgs, routeNeedsGit, NEEDS_GIT_REASON } from '../needs-git-route.mjs';

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
  it('keeps code after a regex literal containing slashes (not a line comment)', () => {
    const cp = "import { execFileSync } from 'node:child_process';\n";
    expect(sourceNeedsGit(cp + "const re = /https?:\\/\\//; execFileSync('git', ['ls-files']);")).toBe(true);
    expect(sourceNeedsGit(cp + "const re = /[/]x\\/\\//g; execFileSync('git', []);")).toBe(true);
    expect(sourceNeedsGit(cp + "if (/^\\/\\//.test(s)) execFileSync('git', []);")).toBe(true);
    expect(sourceNeedsGit(cp + "const a = [/\\/\\//, 1]; return /\\/\\//.test(x), execFileSync('git', []);")).toBe(true);
    expect(sourceNeedsGit(cp + "const q = (a / b) / c; execFileSync('git', []);")).toBe(true);
    // a regex literal is not code: a quoted git inside it must not count as a spawn
    expect(sourceNeedsGit(cp + "const re = /'git'/; run('node')")).toBe(false);
    // a real comment after a regex is still a comment
    expect(sourceNeedsGit(cp + "const re = /a\\//; // execFileSync('git', [])")).toBe(false);
  });
  it('honours declared helpers imported dynamically, by side-effect, or via require', () => {
    const o = { helpers: ['git-helper.mjs'] };
    expect(sourceNeedsGit("const { tracked } = await import('../git-helper.mjs'); tracked();", o)).toBe(true);
    expect(sourceNeedsGit("await import(`../git-helper.mjs`)", o)).toBe(true);
    expect(sourceNeedsGit("import '../git-helper.mjs';", o)).toBe(true);
    expect(sourceNeedsGit('import "../git-helper.mjs"', o)).toBe(true);
    expect(sourceNeedsGit("const h = require('../git-helper.mjs')", o)).toBe(true);
    expect(sourceNeedsGit("export * from '../git-helper.mjs'", o)).toBe(true);
    expect(sourceNeedsGit("// import '../git-helper.mjs'\n// await import('../git-helper.mjs')", o)).toBe(false);
    expect(sourceNeedsGit("const s = 'git-helper.mjs'; other('../git-helper.mjs')", o)).toBe(false);
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
  const readFile = (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; };
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
  it('default reader refuses outside-root, traversal and non-files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ngr-'));
    try {
      mkdirSync(join(dir, 'sub'));
      const body = "import 'node:child_process'; spawnSync('git', [])";
      writeFileSync(join(dir, 'in.test.mjs'), body);
      writeFileSync(join(dir, '..', `out-${process.pid}.test.mjs`), body);
      expect(routeNeedsGit({ argv: ['vitest', 'run', 'in.test.mjs'], cwd: dir }).local).toBe(true);
      expect(routeNeedsGit({ argv: ['vitest', 'run', `../out-${process.pid}.test.mjs`], cwd: dir })).toEqual({ local: false });
      expect(routeNeedsGit({ argv: ['vitest', 'run', 'sub', 'src/**'], cwd: dir })).toEqual({ local: false });
    } finally { rmSync(join(dir, '..', `out-${process.pid}.test.mjs`), { force: true }); rmSync(dir, { recursive: true, force: true }); }
  });
});
