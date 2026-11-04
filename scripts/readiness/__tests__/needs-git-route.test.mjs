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
  it('does not lose the scan position after a regex/division/template misjudgment', () => {
    const G = "import {execSync} from 'node:child_process';\n";
    const spawn = " execSync('git status');";
    expect(sourceNeedsGit(G + "if (x) /'/.test(y); const u='http://x';" + spawn)).toBe(true);
    expect(sourceNeedsGit(G + "while (m=next()) /x'/.exec(m); const u='http://x';" + spawn)).toBe(true);
    expect(sourceNeedsGit(G + "function f(){}\n/'/.test(a); const u='http://x';" + spawn)).toBe(true);
    expect(sourceNeedsGit(G + 'let r = i++ / 2;' + spawn + ' // see /x')).toBe(true);
    expect(sourceNeedsGit(G + 'let r = f(i) / 2;' + spawn + ' // see /x')).toBe(true);
    expect(sourceNeedsGit(G + "const a=`${ '`' }`; const u='http://x';" + spawn)).toBe(true);
    expect(sourceNeedsGit(G + "const a=`x${ `y${ '}' }` }z`; const u='http://x';" + spawn)).toBe(true);
    // `}` closing an object literal / expression is an operand: the next `/` divides. `}` closing a block is not.
    const tail = " execFileSync('git', ['rev-parse']); const path = '/tmp';";
    const E = "import {execFileSync} from 'node:child_process'; ";
    expect(sourceNeedsGit(E + 'const ratio = {valueOf: () => 10} / 2;' + tail)).toBe(true);
    expect(sourceNeedsGit(E + 'const r = ({a: 1}).a / 2;' + tail)).toBe(true);
    expect(sourceNeedsGit(E + 'const r = [{}, {a: {}}] / 2;' + tail)).toBe(true);
    expect(sourceNeedsGit(E + 'const r = f({a: 1} / 2);' + tail)).toBe(true);
    expect(sourceNeedsGit(E + 'x = cond ? {} / 2 : {} / 3;' + tail)).toBe(true);
    expect(sourceNeedsGit(E + 'function g() { return {a: 1} / 2; }' + tail)).toBe(true);
    expect(sourceNeedsGit(E + 'const s = `${ {valueOf: () => 1} / 2 }`;' + tail)).toBe(true);
    expect(sourceNeedsGit(E + "if (x) {}\n/'/.test(a); const u = 'http://x';" + tail)).toBe(true);
    expect(sourceNeedsGit(E + "const f = () => {}\n/'/.test(a); const u = 'http://x';" + tail)).toBe(true);
    expect(sourceNeedsGit(E + "class A { m() {} }\n/'/.test(a); const u = 'http://x';" + tail)).toBe(true);
    expect(sourceNeedsGit(E + "else {}\n/'/.test(a); const u = 'http://x';" + tail)).toBe(true);
    // TypeScript non-null `x!`, keyword-named properties and keyword-named methods are operands, not keywords
    const one = " execFileSync('git', ['status']); expect(half / 2).toBe(1);";
    expect(sourceNeedsGit(E + 'const half = total! / 2;' + one)).toBe(true);
    expect(sourceNeedsGit(E + 'const half = f(a)! / 2;' + one)).toBe(true);
    expect(sourceNeedsGit(E + 'const half = a[0]! / 2;' + one)).toBe(true);
    expect(sourceNeedsGit(E + 'const half = stats.in / 2;' + one)).toBe(true);
    expect(sourceNeedsGit(E + 'const half = a?.of / 2;' + one)).toBe(true);
    expect(sourceNeedsGit(E + 'const half = d.with({day: 1}) / 2;' + one)).toBe(true);
    expect(sourceNeedsGit(E + 'const half = x.for(1) / 2;' + one)).toBe(true);
    // ... while a real regex after `!` / `return` / a real control head still reads as a regex
    expect(sourceNeedsGit(E + "const ok = !/'/.test(s); const u = 'http://x';" + tail)).toBe(true);
    expect(sourceNeedsGit(E + "function f(s) { return !/'/.test(s); } const u = 'http://x';" + tail)).toBe(true);
    expect(sourceNeedsGit(E + "if (a) /'/.test(s); const u = 'http://x';" + tail)).toBe(true);
    // a quote/backtick/brace inside a regex literal in a `${ }` hole does not end the hole early
    expect(sourceNeedsGit(G + "function f() {\n  const a = `${ s.replace(/\"/g, '\\\\\"') }`;\n}\nconst b = `**/*.js`;" + spawn)).toBe(true);
    expect(sourceNeedsGit(G + "it('a', () => { const c = `${s.replace(/`/g, '')}`; const g = `**/*.js`;" + spawn + ' });')).toBe(true);
    expect(sourceNeedsGit(G + "function f() { const a = `${ s.replace(/'/g, '') }`; const b = `http://x`;" + spawn + ' }')).toBe(true);
    expect(sourceNeedsGit(G + "function f() { const a = `${ s.replace(/}/g, '') }`; const b = `http://x`;" + spawn + ' }')).toBe(true);
    expect(sourceNeedsGit(G + 'const a = `${ x / 2 } ${ y / 3 }`; const b = `http://x`;' + spawn)).toBe(true);
    // a comment ends at CR, U+2028 and U+2029 as well as LF
    for (const nl of ['\r', ' ', ' ']) expect(sourceNeedsGit(G + '// c' + nl + spawn)).toBe(true);
    // ... but text inside one comment stays a comment
    expect(sourceNeedsGit(G + "// execSync('git status')")).toBe(false);
  });
  it('stays linear on adversarial 300k inputs (no quadratic rescans)', () => {
    const o = { helpers: ['a.mjs'] };
    const inputs = ['(/['.repeat(100000), 'import' + ' '.repeat(300000) + 'x', 'a'.repeat(300000), "('".repeat(150000), '${'.repeat(100000), '`${'.repeat(100000), '`${' + '(/['.repeat(100000), '`${' + '(/'.repeat(150000)];
    const t0 = Date.now();
    for (const s of inputs) expect(sourceNeedsGit(s, o)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2500);
    // oversize input is not judged (same as an unreadable file): stays remote
    expect(sourceNeedsGit("import 'node:child_process'; run('git', [])" + ' '.repeat(1024 * 1024))).toBe(false);
  });
  it('ignores non-string and empty helper entries', () => {
    expect(sourceNeedsGit("import '../x.mjs'", { helpers: [null, '', undefined, 7] })).toBe(false);
    expect(sourceNeedsGit("import '../x.mjs'", { helpers: 'x.mjs' })).toBe(false);
  });
  it('honours declared helpers imported dynamically, by side-effect, or via require', () => {
    const o = { helpers: ['git-helper.mjs'] };
    expect(sourceNeedsGit("const { tracked } = await import('../git-helper.mjs'); tracked();", o)).toBe(true);
    expect(sourceNeedsGit("await import(`../git-helper.mjs`)", o)).toBe(true);
    expect(sourceNeedsGit("import '../git-helper.mjs';", o)).toBe(true);
    expect(sourceNeedsGit('import "../git-helper.mjs"', o)).toBe(true);
    expect(sourceNeedsGit("const h = require('../git-helper.mjs')", o)).toBe(true);
    expect(sourceNeedsGit("export * from '../git-helper.mjs'", o)).toBe(true);
    expect(sourceNeedsGit("import\n  '../git-helper.mjs'", o)).toBe(true);
    expect(sourceNeedsGit("await import(\n  '../git-helper.mjs?raw')", o)).toBe(true);
    expect(sourceNeedsGit("require.resolve('../git-helper.mjs')", o)).toBe(true);
    expect(sourceNeedsGit("await vi.importActual('../git-helper.mjs')", o)).toBe(true);
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
