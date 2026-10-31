import { expect, it } from 'vitest';
import { relative, resolve } from 'node:path';
import { computeClosureScope, isExcludable } from '../daemon-rebuild/closure-scope.mjs';
import { smokeSurfaceEntries } from '../daemon-rebuild/skip-unrelated.mjs';

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
