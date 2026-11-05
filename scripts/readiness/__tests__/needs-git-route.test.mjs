import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { sourceNeedsGit, testFilterArgs, routeNeedsGit, NEEDS_GIT_REASON } from '../needs-git-route.mjs';

// R90 / R559 fail-closed rule: a file stays remote only when a conservative linear token check finds NO
// git-related token anywhere. Every past red-team break (hidden by the old hand-rolled lexer) must be needs-git.
const CP = "import {execSync, execFileSync} from 'node:child_process';\n";
const BREAKS = {
  'R8 ASI after debugger hides regex': CP + "debugger\n/'/.test('x'); const u='http://x'; execSync('git rev-parse --is-inside-work-tree', {stdio:'pipe'});",
  'R8 repeated TS non-null assertion': CP + "const total: number | null = 4; const half = total!! / 2; execSync('git rev-parse HEAD'); const path = '/tmp';",
  'regex after if head': CP + "if (x) /'/.test(y); const u='http://x'; execSync('git status');",
  'regex literal with slashes': CP + "const re = /https?:\\/\\//; execFileSync('git', ['ls-files']);",
  'nested class expressions': CP + "const A = class { m = class { n() {} } }\n/'/.test(a); const u='http://x'; execSync('git status');",
  'quoted semicolon in shell arg': CP + "execSync('echo \";\" && git status');",
  'nested template holes': CP + "const a=`x${ `y${ '}' }` }z`; const u='http://x'; execSync('git status');",
  'object literal then division': CP + "const r = {valueOf: () => 10} / 2; execFileSync('git', ['rev-parse']); const p = '/tmp';",
  'string concatenation of git': CP + "execSync('gi' + 't status');",
  'array join of git': CP + "execSync(['g','i','t'].join('') + ' status');",
  'hex escape': CP + "execSync('\\x67it status');",
  'unicode escape': CP + "execSync('\\u0067it status');",
  'template hole fragment': CP + "execSync(`${'g'}it status`);",
  'comment inside token': CP + "execSync('g' /* x */ + 'it status');",
  'spawn without literal git': "import cp from 'node:child_process'; const b = process.env.B; cp.spawnSync(b, []);",
  'dynamic import of child_process': "const m = await import('node:child_' + 'process'); m.execSync(cmd);",
  'simple-git package': "import simpleGit from 'simple-git'; await simpleGit().status();",
  'fromCharCode build': "const n = String.fromCharCode(103,105,116); run(n);",
  'base64 build': "run(Buffer.from('Z2l0', 'base64').toString());",
  'eval': "eval(code)",
  'worker threads': "import { Worker } from 'node:worker_threads';",
  'fork': "import { fork } from 'node:child_process'; fork('x.js');",
  'audit: comment between split halves': "const cp = await import('node:child_' /* gap */ + 'process'); export default cp.execFileSync('g' + 'it', ['--version']);",
  'audit: line comment between split halves': "const cp = await import('node:child_' // gap\n + 'process'); cp.execFileSync('g' + 'it', []);",
  'audit: variable suffix import': "const tail = 'process'; const cp = await import('node:child_' + tail); cp.execFileSync(['g','i','t'].join(''), []);",
  'audit: computed require': "const cp = require('node:child_' + tail);",
  'audit2: commented computed import': "const a='node:child'; const b='_process'; const cp = await import/**/(a+b); cp.execFileSync('gi'+'t', []);",
  'audit2: commented computed require': "const cp = require/**/(a+b);",
  'audit2: interpolated template import': "const cp = await import(`${a}${b}`); cp.execFileSync('gi'+'t', []);",
  'audit2: getBuiltinModule': "const cp = process.getBuiltinModule(a + b);",
  'audit3: aliased require': "const a='node:chi'; const b='ld_process'; const load=require; const cp=load(a+b); cp.execFileSync('gi'+'t', []);",
  'audit4: computed module.require': "const tail='ld_process', head='node:chi'; const cp=module['requ'+'ire'](head+tail); cp.execFileSync('gi'+'t',[]);",
  'audit4: computed eval': "globalThis['ev'+'al'](code)",
  'audit4: this-computed eval': "this['ev'+'al'](code)",
  'audit5: whitespace global computed eval': "const code='im'+'port(x)'; global ['ev'+'al'](code);",
  'audit5: call-result computed access': "(function(){return this})()['ev'+'al'](code)",
  'audit5: variable-built property': "const k = a + b; process[k]('x');",
  'audit6: aliased global computed eval': "const g=global; await g['ev'+'al'](code);",
  'audit6: sloppy this global': "const g=(function(){ return this; })(); g['ev'+'al'](code);",
  'audit6: vm context': "import vm from 'node:vm'; vm.runInThisContext(code);",
  'audit7: whitespace constructor access': "const F = (() => {}). constructor; const load = F('return im' + 'port(\"' + b + a + '\")');",
  'audit7: quoted constructor': "const F = fn['constructor'];",
  'audit8: direct Function call': "const cp=await Function('s','return im'+'port(s)')(head+tail);",
  'audit9: computed destructuring': "const end='structor', start='con'; const {[start+end]: make}=()=>{}; make('s','return im'+'port(s)');",
  'audit9: computed destructuring variable key': "const k = a + b; const {[k]: make} = fn;",
  'audit9: concatenated bracket key on any object': "const o = fn; o[a + b]('x');",
  'audit11: optional-chain computed read': "const make = fn?.[key]; make('s', 'x');",
  'audit11: unicode identifier computed read': "const make = \u03C0[key]; make('s', 'x');",
  'audit11: variable-key constructor': "const key = a + b, fn = () => {}, make = fn[key];",
  'audit12: unquoted constructor destructuring': "const {constructor: make} = () => {}; make('s', 'x');",
  'audit13: descriptor-based Function recovery': "const make = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(()=>{}), 'con'.concat('structor')).value;",
  'audit13: proto walk': "const f = ({}).__proto__;",
  'audit14: native binding via Object.values': "const load = Object.values(process).find(f => f.name === 'binding'); load('s'.concat('pawn_sync'));",
  'unparseable binary-ish': '\u0000\u0001\u0002 �',
};

describe('sourceNeedsGit (fail-closed)', () => {
  for (const [name, src] of Object.entries(BREAKS)) {
    it(`break "${name}" needs git`, () => { expect(sourceNeedsGit(src)).toBe(true); });
  }
  it('R8 helper-import string continuation (the quadratic input) is fast and needs git via the helper token', () => {
    const src = 'const fixture = "import \'' + 'a.mjs?'.repeat(32000) + '\\\n";';
    const t0 = Date.now();
    expect(sourceNeedsGit(src, { helpers: ['a.mjs'] })).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it('declared helpers are tokens too', () => {
    expect(sourceNeedsGit("import { x } from '../tracked-helper.mjs';", { helpers: ['tracked-helper.mjs'] })).toBe(true);
    expect(sourceNeedsGit("import '../x.mjs'", { helpers: [null, '', undefined, 7] })).toBe(false);
  });
  it('audit: helpers with no ASCII letters, a split helper import, and an oversized helper list', () => {
    expect(sourceNeedsGit("const run = require('./\u5DE5\u5177'); run();", { helpers: ['\u5DE5\u5177'] })).toBe(true);
    expect(sourceNeedsGit("const run = require('./---'); run();", { helpers: ['---'] })).toBe(true);
    expect(sourceNeedsGit("await import('./run' /* gap */ + 'ner.mjs')", { helpers: ['runner.mjs'] })).toBe(true);
    expect(sourceNeedsGit('a'.repeat(1000), { helpers: Array(5000).fill('b') })).toBe(true);
  });
  it('audit2: helper that only matches once block comments are removed', () => {
    expect(sourceNeedsGit("import ''; /*x*/ ''", { helpers: ["';   '"] })).toBe(true);
  });
  it('audit3: many import keywords inside one long comment stay linear', () => {
    const src = '/* ' + 'import/* '.repeat(40000) + ' */\nconst x=1;';
    const t0 = Date.now();
    sourceNeedsGit(src);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it('audit4: an unterminated // + import/* run stays linear', () => {
    const src = '// ' + 'import/* '.repeat(40000);
    const t0 = Date.now();
    sourceNeedsGit(src);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it('audit11: a megabyte of [ stays linear', () => {
    const t0 = Date.now();
    sourceNeedsGit('['.repeat(1024 * 1024));
    sourceNeedsGit('a['.repeat(500000));
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  it('a block comment opener inside a string cannot hide later code', () => {
    expect(sourceNeedsGit("const g = 'src/**/*.js'; /* x */ import('node:child_process');")).toBe(true);
    expect(sourceNeedsGit("const u = 'http://x'; import('node:child_process');")).toBe(true);
  });
  it('non-string input and oversize input are ambiguous: needs git', () => {
    expect(sourceNeedsGit(undefined)).toBe(true);
    expect(sourceNeedsGit(null)).toBe(true);
    expect(sourceNeedsGit('a'.repeat(1024 * 1024 + 1))).toBe(true);
  });
  it('a plain token-free test stays remote', () => {
    expect(sourceNeedsGit("import { it, expect } from 'vitest';\nit('adds', () => { expect(1 + 1).toBe(2); });")).toBe(false);
    expect(sourceNeedsGit('')).toBe(false);
  });
  it('stays linear on adversarial 1MB inputs', () => {
    const inputs = ['(/['.repeat(300000), 'import' + ' '.repeat(900000) + 'x', 'a.mjs?'.repeat(160000) + '\\\n', '${'.repeat(500000), '`${'.repeat(300000), "'" + ' /'.repeat(450000) + "'", 'function(){}'.repeat(80000), 'gi'.repeat(500000)];
    const t0 = Date.now();
    for (const s of inputs) sourceNeedsGit(s.slice(0, 1024 * 1024), { helpers: ['a.mjs'] });
    expect(Date.now() - t0).toBeLessThan(15000);
  }, 30000);
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
  it('stays remote when no selected file needs git, and for non-test commands', () => {
    expect(routeNeedsGit({ argv: ['vitest', 'run', 'b.test.mjs'], readFile })).toEqual({ local: false });
    expect(routeNeedsGit({ argv: ['npm', 'run', 'check:standards'], readFile })).toEqual({ local: false });
  });
  it('an unreadable test-file filter is ambiguous: local (fail-closed)', () => {
    expect(routeNeedsGit({ argv: ['vitest', 'run', 'missing.test.mjs'], readFile }))
      .toEqual({ local: true, reason: 'needs-git', files: ['missing.test.mjs'] });
  });
  it('honours a declared list', () => {
    expect(routeNeedsGit({ argv: ['vitest', 'run', 'b.test.mjs'], readFile, declared: ['b.test.mjs'] }))
      .toEqual({ local: true, reason: 'needs-git', files: ['b.test.mjs'] });
  });
  it('default reader: outside-root test file is local, directories/globs stay unjudged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ngr-'));
    try {
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'in.test.mjs'), "import 'node:child_process'; spawnSync('git', [])");
      writeFileSync(join(dir, 'ok.test.mjs'), "expect(1).toBe(1)");
      expect(routeNeedsGit({ argv: ['vitest', 'run', 'in.test.mjs'], cwd: dir }).local).toBe(true);
      expect(routeNeedsGit({ argv: ['vitest', 'run', 'ok.test.mjs'], cwd: dir })).toEqual({ local: false });
      expect(routeNeedsGit({ argv: ['vitest', 'run', '../escape.test.mjs'], cwd: dir }).local).toBe(true);
      expect(routeNeedsGit({ argv: ['vitest', 'run', 'sub', 'src/**'], cwd: dir })).toEqual({ local: false });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
