import { expect, it } from 'vitest';
import { join, relative, resolve } from 'node:path';
import { computeClosureScope, isExcludable } from '../daemon-rebuild/closure-scope.mjs';
import { smokeSurfaceEntries } from '../daemon-rebuild/skip-unrelated.mjs';
import { readyBuildVerified } from '../daemon-rebuild/adopt.mjs';
import { collectImportClosure } from '../import-closure.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

function compute(source, files = {}, options = {}) {
  const root = resolve('virtual-failclosed');
  const contents = new Map(Object.entries({
    ...Object.fromEntries(smokeSurfaceEntries({}).map(path => [path, 'export {};'])),
    'entry.mjs': "import './runtime.mjs';", 'runtime.mjs': source, ...files,
  }));
  const key = path => relative(root, resolve(root, path));
  const reader = { root, listFiles: () => [...contents.keys()], exists: path => contents.has(key(path)),
    readFile(path) {
      if (!contents.has(key(path))) throw new Error('missing fixture file');
      return contents.get(key(path));
    } };
  return computeClosureScope({ reader, entries: ['entry.mjs'], env: {}, ...options });
}

function protectedPaths(result, paths) {
  for (const path of paths) {
    expect(isExcludable(path, result.scope), path).toBe(false);
    if (result.ok) expect(result.scope.has(path), path).toBe(true);
    else expect(result.reason).toMatch(/closure-|unreadable/);
  }
}

const constructorAliases = [
  'const compile = (() => {}).constructor;',
  'const compile = (function () {}).constructor;',
  'const compile = (async () => {}).constructor;',
  'const compile = (function* () {}).constructor;',
  'const compile = (async function* () {}).constructor;',
  "const compile = (() => {})['constructor'];",
  'const compile = (() => {})[`constructor`];',
  'const compile = (() => {}).constr\\u0075ctor;',
  "const compile = (() => {})['constr\\u0075ctor'];",
  'const { constructor: compile } = () => {};',
  "const { ['con' + 'structor']: compile } = () => {};",
  "const compile = (() => {})['con' + 'structor'];",
  "const key = ['con', 'structor'].join(''); const compile = (() => {})[key];",
  'const compile = Reflect.get(() => {}, process.argv[3]);',
  'const compile = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(() => {}), process.argv[3]).value;',
];

it.each(constructorAliases)('constructor aliases cannot authorize runtime exclusions: %s', alias => {
  const result = compute(`${alias} await compile(process.argv[2])();`, { 'unmentioned.mjs': '' });
  expect(result).toMatchObject({ ok: false, reason: 'closure-incomplete' });
  expect(isExcludable('unmentioned.mjs', result.scope)).toBe(false);
});

it('keeps literal numeric indexing eligible for strict closure proof', () => {
  const result = compute('export const argument = process.argv[2];', { 'unmentioned.mjs': '' });
  expect(result.ok).toBe(true);
  expect(isExcludable('unmentioned.mjs', result.scope)).toBe(true);
});

it('preserves non-strict and legacy import walks for constructor references', () => {
  const root = resolve('virtual-legacy-constructor');
  for (const options of [{ strict: false }, { strict: true, strictExtensions: false }]) {
    const closure = collectImportClosure({ root, entries: ['entry.mjs'],
      exists: path => path === resolve(root, 'entry.mjs'),
      readFile: () => 'const compile = (() => {}).constructor;', ...options });
    expect(closure.complete).toBe(true);
    expect(closure.files).toEqual(new Set(['entry.mjs']));
  }
});

it('executes the reported constructor alias importing a module absent from static imports', () => {
  const root = mkdtempSync(join(tmpdir(), 'constructor-alias-'));
  try {
    const source = 'const compile = (() => {}).constructor; await compile(process.argv[2])();';
    writeFileSync(join(root, 'entry.mjs'), source);
    writeFileSync(join(root, 'payload.mjs'), "console.log('runtime-import-reached');");
    const body = `return import(${JSON.stringify(pathToFileURL(join(root, 'payload.mjs')).href)})`;
    const run = spawnSync(process.execPath, [join(root, 'entry.mjs'), body], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe('runtime-import-reached');
    expect(compute(source, { 'payload.mjs': '' })).toMatchObject({ ok: false, reason: 'closure-incomplete' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Model Git object reads and merge reconstruction without writing a repository/index.
function savedCandidateGit(source) {
  const sha = digit => digit.repeat(40);
  const main = sha('1'), overlay = sha('2'), final = sha('3'), tree = sha('4');
  const files = Object.entries({
    ...Object.fromEntries(smokeSurfaceEntries({}).map(path => [path, 'export {};'])),
    'entry.mjs': source, 'unmentioned.mjs': '',
  }).map(([path, body], i) => ({ path, body, oid: (i + 16).toString(16).padStart(40, '0') }));
  const git = (args, options = {}) => {
    const ok = stdout => ({ status: 0, stdout });
    switch (args[0]) {
      case 'ls-tree': return ok(files.map(f => `100644 blob ${f.oid}\t${f.path}\0`).join(''));
      case 'cat-file': return ok(Buffer.concat(options.input.trim().split('\n').map(oid => {
        const file = files.find(f => f.oid === oid);
        return Buffer.from(`${oid} blob ${Buffer.byteLength(file.body)}\n${file.body}\n`);
      })));
      case 'merge-base': return ok(main);
      case 'rev-list': return ok(`${final} ${main} ${overlay}`);
      case 'rev-parse': return ok(args.at(-1).endsWith('^{tree}') ? tree
        : args.at(-1).startsWith('refs/') ? overlay : main);
      case 'merge-tree': return args.includes('--name-only')
        ? { status: 1, stdout: `${tree}\0unmentioned.mjs\0` } : ok(tree);
      case '--literal-pathspecs': return ok('');
      case 'read-tree': case 'update-index': return ok('');
      case 'write-tree': case 'commit-tree': return ok(tree);
      case 'log': return ok('1700000000');
      default: throw new Error(`Unexpected fixture Git command: ${args.join(' ')}`);
    }
  };
  return { git, mainTip: main, prevHead: main, entries: ['entry.mjs'], env: {},
    adopt: { mainSha: main, finalSha: final, applied: [{ ref: 'lane/alias', sha: overlay,
      resolvedVia: 'closure-scope', excluded: ['unmentioned.mjs'] }] } };
}

it.each(['off', 'shadow', 'on'])('saved candidates reject constructor exclusions in %s mode', closureScopeMode => {
  expect(readyBuildVerified({ ...savedCandidateGit('export {};'), closureScopeMode })).toBe(true);
  for (const alias of constructorAliases) {
    expect(readyBuildVerified({ ...savedCandidateGit(`${alias} await compile(process.argv[2])();`),
      closureScopeMode }), alias).toBe(false);
  }
});

it.each(["import(/* selected at runtime */ './payload.mjs');",
  "import('./payload.mjs' /* trailing */);", "require(// selected\n'./payload.mjs');"])(
  'R230 protects commented loaders and retains every file on opaque specifier evidence: %s', source => {
  const result = compute(source, {
    'payload.mjs': '', 'unmentioned.js': '', 'tests/unmentioned.test.ts': '',
  });
  protectedPaths(result, ['payload.mjs', 'unmentioned.js', 'tests/unmentioned.test.ts']);
  expect(result.reason).toBe('closure-opaque');
});

it('R230 protects CommonJS extensionless require targets', () => {
  protectedPaths(compute("require('./payload');", { 'payload.cjs': '' }), ['payload.cjs']);
});

it('R230 protects all code on a computed require path', () => {
  protectedPaths(compute('require(process.env.TARGET);', { 'unmentioned.js': '' }), ['unmentioned.js']);
});

it('R230 protects spawned scripts named by literal paths in a closure file', () => {
  protectedPaths(compute("spawn('node', ['./scripts/payload.mjs']);", { 'scripts/payload.mjs': '' }),
    ['scripts/payload.mjs']);
});

it('R230 protects spawned scripts named by basename in a closure file', () => {
  protectedPaths(compute("spawn('node', ['payload.mjs']);", { 'payload.mjs': '' }), ['payload.mjs']);
});

it.each(['scripts/payload', 'payload', 'prefix-payload-suffix', 'scripts/payload.mjs', 'pay\\u006coad'])(
  'R230 protects a file mentioned only by a string or substring: %s', mention => {
    protectedPaths(compute(`const note = '${mention}';`, { 'scripts/payload.mjs': '' }), ['scripts/payload.mjs']);
  });

it.each(['createRequire(import.meta.url)(process.env.TARGET);', 'eval(process.env.SOURCE);',
  'new Function(process.env.SOURCE)();', "import(process.env.TARGET);", "spawn('node', [target]);",
  'export const broken = ('])('R230 retains every code file for opaque or unparseable evidence: %s', source => {
  protectedPaths(compute(source, { 'unmentioned.js': '', 'tests/hidden.test.ts': '' }),
    ['unmentioned.js', 'tests/hidden.test.ts']);
});

it('R230 protects unknown paths and scopes with no exclusion proof', () => {
  const result = compute('export {};');
  expect(result.ok).toBe(true);
  expect(isExcludable('unknown.js', result.scope)).toBe(false);
  expect(isExcludable('unknown.js', new Set())).toBe(false);
  expect(isExcludable('unknown.js', new Set(result.scope))).toBe(false);
});

it('R230 still excludes proven unreferenced code and tests without opaque loaders', () => {
  const result = compute('export const value = 1;', { 'unused.js': '', 'tests/unused.test.mjs': '' });
  expect(result.ok).toBe(true);
  for (const path of ['unused.js', 'tests/unused.test.mjs']) {
    expect(result.scope.has(path), path).toBe(false);
    expect(isExcludable(path, result.scope), path).toBe(true);
  }
});

it('R230 does not treat comment-like literal data as opaque loader syntax', () => {
  const result = compute("const note = '/* description */'; import('./payload.mjs');", {
    'payload.mjs': '', 'unused.js': '',
  });
  expect(result.ok).toBe(true);
  expect(isExcludable('unused.js', result.scope)).toBe(true);
  expect(isExcludable('payload.mjs', result.scope)).toBe(false);
});

it('R230 uses overlay and additional-entry source when proving exclusions', () => {
  const result = compute('export {};', { 'second.mjs': "const note = 'payload';", 'scripts/payload.ts': '' }, {
    entries: ['entry.mjs', 'second.mjs'],
    overlayChangedFiles: new Map([['runtime.mjs', "const note = 'overlay-only';"], ['overlay-only.js', '']]),
  });
  protectedPaths(result, ['scripts/payload.ts', 'overlay-only.js']);
});
