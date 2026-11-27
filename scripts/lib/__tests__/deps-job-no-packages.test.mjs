import { afterEach, describe, it, expect, vi } from 'vitest';
import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { parseSupersedes } from '../../conveyor/supersede-rule.mjs';
import { inspectDepsImports } from '../daemon-rebuild/deps-job.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

// Exercise the production inspector with the installed parser, without adding it to the job's imports.
function inspectImports(entry, options) {
  return inspectDepsImports(entry, { ...options, syntax: ts });
}

// The two existing entry probes use bounded local IO; fixture tests supply their own root/read/clock.
function packageImports(entry, read, options = {}) {
  const repoRoot = options.root ?? root;
  const boundedRead = (path, remaining) => {
    const fd = openSync(resolve(repoRoot, path), 'r');
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error('not a regular module file');
      if (stat.size > remaining) throw new Error('byte-budget');
      const data = Buffer.alloc(stat.size + 1);
      const length = readSync(fd, data, 0, data.length, 0);
      if (length !== stat.size) throw new Error('module changed or read was incomplete; retry');
      return data.subarray(0, length).toString('utf8');
    } finally { closeSync(fd); }
  };
  return inspectImports(entry, { root: repoRoot, now: () => performance.now(), ...options, read: read ?? boundedRead }).packages;
}

describe('deps job without installed packages', () => {
  it('has only Node builtins throughout its static import closure', () => {
    expect(packageImports('scripts/lib/daemon-rebuild/deps-job.mjs')).toEqual([]);
  });

  it('can statically import the supersede rule before packages are installed', () => {
    expect(packageImports('scripts/conveyor/supersede-rule.mjs')).toEqual([]);
  });

  it('walks multiline imports, re-exports and bare imports, including cycles, and names the package chain', () => {
    const files = {
      'entry.mjs': "import {\n x\n} from './child.mjs'; export * from './export.mjs'; import './bare.mjs';",
      'child.mjs': "import './entry.mjs'; import 'node:fs'; import 'fs';",
      'export.mjs': "export { x } from 'external';",
      'bare.mjs': "import 'another-package';",
    };
    expect(packageImports('entry.mjs', (path) => files[path])).toEqual([
      'entry.mjs -> export.mjs -> external', 'entry.mjs -> bare.mjs -> another-package',
    ]);
  });

  it.each([
    "const x = require('external');",
    "const x = await import('external');",
    "(() => { require('external'); })();",
  ])('rejects startup package loading: %s', (source) => {
    expect(packageImports('entry.mjs', () => source)).toEqual(['entry.mjs -> external']);
  });

  it('refuses an unreadable relative dependency instead of accepting an incomplete closure', () => {
    expect(() => packageImports('entry.mjs', (path) => {
      if (path === 'entry.mjs') return "import './missing.mjs';";
      throw new Error(`Cannot read ${path}`);
    })).toThrow('Cannot read missing.mjs');
  });

  it('still parses Supersedes markers while ignoring fenced examples', () => {
    expect(parseSupersedes('```md\nSupersedes: #99\n```\n### **Supersedes:** #12, #13 and #14')).toEqual([12, 13, 14]);
  });
});

const fixtureRoots = [];
afterEach(() => {
  for (const dir of fixtureRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function syntaxFixture(files) {
  const root = mkdtempSync(resolve(tmpdir(), 'deps-syntax-'));
  fixtureRoots.push(root);
  for (const [path, source] of Object.entries(files)) {
    const target = resolve(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  return { root, read: vi.fn((path) => readFileSync(resolve(root, path), 'utf8')), now: () => 0 };
}

describe('bounded dependency syntax evidence (hermetic fixtures)', () => {
  it('bare .package is classified as a package while ./package and ../package are relative', () => {
    const f = syntaxFixture({
      'nested/entry.mjs': "import '.package'; import './package'; import '../package';",
      'nested/.package': '', // The old startsWith('.') classifier incorrectly visits this decoy.
      'nested/package': '',
      package: '',
    });
    expect(packageImports('nested/entry.mjs', f.read, f)).toEqual(['nested/entry.mjs -> .package']);
    expect(f.read.mock.calls.map(([path]) => path)).toEqual(['nested/entry.mjs', 'nested/package', 'package']);
  });

  it.each(['require', 'import'])('rejects a bare .package in the %s line heuristic', (load) => {
    const f = syntaxFixture({ 'entry.mjs': `const value = ${load}('.package');` });
    expect(packageImports('entry.mjs', f.read, f)).toEqual(['entry.mjs -> .package']);
  });

  it.each([
    'eval("import(\'external\')");',
    'eval("require(\'external\')");',
    'new Function("return import(\'external\')")();',
    'const source = "import(\'external\')";',
  ])('retains the previous heuristic refusal for quoted package loads: %s', (source) => {
    const f = syntaxFixture({ 'entry.mjs': source });
    expect(packageImports('entry.mjs', f.read, f)).toEqual(['entry.mjs -> external']);
  });

  it.each([
    "loader.require('external');",
    "loader?.require('external');",
    "loader['require']('external');",
  ])('rejects member-call require package loads: %s', (source) => {
    const f = syntaxFixture({ 'entry.mjs': source });
    expect(packageImports('entry.mjs', f.read, f)).toEqual(['entry.mjs -> external']);
  });

  it.each(['require', 'import'])('reports an absolute node_modules startup load through %s as a package', (load) => {
    const f = syntaxFixture({ 'entry.mjs': '', 'node_modules/external/index.mjs': '' });
    const specifier = resolve(f.root, 'node_modules/external/index.mjs');
    writeFileSync(resolve(f.root, 'entry.mjs'), `${load}(${JSON.stringify(specifier)});`);
    expect(inspectImports('entry.mjs', f).packages).toEqual([`entry.mjs -> ${specifier}`]);
    expect(f.read).toHaveBeenCalledTimes(1);
  });

  it.each(['require', 'import'])('reports a file URL node_modules startup load through %s as a package', (load) => {
    const f = syntaxFixture({ 'entry.mjs': '', 'node_modules/external/index.mjs': '' });
    const specifier = pathToFileURL(resolve(f.root, 'node_modules/external/index.mjs')).href;
    writeFileSync(resolve(f.root, 'entry.mjs'), `${load}(${JSON.stringify(specifier)});`);
    expect(inspectImports('entry.mjs', f).packages).toEqual([`entry.mjs -> ${specifier}`]);
    expect(f.read).toHaveBeenCalledTimes(1);
  });

  it.each(['absolute path', 'file URL'])('reports a non-local startup package loaded by %s without reading outside the root', (form) => {
    const f = syntaxFixture({ 'repo/entry.mjs': '', 'packages/external/index.mjs': '' });
    const target = resolve(f.root, 'packages/external/index.mjs');
    const specifier = form === 'file URL' ? pathToFileURL(target).href : target;
    const repoRoot = resolve(f.root, 'repo');
    writeFileSync(resolve(repoRoot, 'entry.mjs'), `require(${JSON.stringify(specifier)}); import(${JSON.stringify(specifier)});`);
    const read = vi.fn((path) => readFileSync(resolve(repoRoot, path), 'utf8'));
    expect(inspectImports('entry.mjs', { ...f, root: repoRoot, read }).packages).toEqual([`entry.mjs -> ${specifier}`]);
    expect(read.mock.calls).toEqual([['entry.mjs', 4 * 1024 * 1024]]);
  });

  it.each([
    "import('external' + '');",
    'import(packageName);',
    'import(`external`);',
    'import(`external/${name}`);',
    'import(getSpecifier());',
    "import('node:' + 'fs');",
    "require('external' + '');",
    'require(packageName);',
    'require();',
    'loader.require(packageName);',
    "loader['require']('external' + '');",
  ])('refuses UNKNOWN nonliteral specifiers without following another path: %s', (source) => {
    const f = syntaxFixture({ 'entry.mjs': `${source}\nimport './unread.mjs';` });
    expect(() => inspectImports('entry.mjs', f)).toThrow(/incomplete.*unknown-specifier.*repair.*retry/i);
    expect(f.read).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['invoked-function loads', "function load() {\n  return import('external');\n}\nload();"],
    ['eval', 'eval("import(\'external\')");'],
    ['aliased createRequire', "import { createRequire as makeRequire } from 'node:module';\nconst load = makeRequire(import.meta.url);\nload('external');"],
  ])('states the %s runtime non-claim without exempting heuristic refusals', (nonClaim, source) => {
    const f = syntaxFixture({ 'entry.mjs': source });
    const evidence = inspectImports('entry.mjs', f);
    expect(evidence.packages).toEqual(nonClaim === 'eval' ? ['entry.mjs -> external'] : []);
    expect(evidence.visited).toEqual(['entry.mjs']);
    expect(evidence.nonClaims).toContain(nonClaim);
    expect(evidence.assurance).toBe('bounded syntax only; runtime import closure unproven');
  });

  it('handles builtins, absolute paths, file URLs and cycles as explicit local syntax', () => {
    const f = syntaxFixture({
      'entry.mjs': '',
      'absolute.mjs': "import './entry.mjs'; import 'node:fs'; import 'fs';",
      'file.mjs': "export * from './absolute.mjs';",
    });
    writeFileSync(resolve(f.root, 'entry.mjs'), `import ${JSON.stringify(resolve(f.root, 'absolute.mjs'))};\nexport * from ${JSON.stringify(pathToFileURL(resolve(f.root, 'file.mjs')).href)};`);
    expect(inspectImports('entry.mjs', f)).toMatchObject({
      packages: [], visited: ['entry.mjs', 'absolute.mjs', 'file.mjs'],
    });
  });

  it.each([
    ['required-evidence-missing', undefined, /read-failed/],
    ['read-throws', new Error('fixture read denied'), /read-failed.*fixture read denied/],
    ['malformed-module', 'import {', /malformed-module/],
  ])('refuses %s with a concrete repair and retry action', (_name, source, reason) => {
    const f = syntaxFixture({});
    f.read.mockImplementation(() => {
      if (source instanceof Error) throw source;
      return source;
    });
    expect(() => inspectImports('entry.mjs', f)).toThrow(reason);
    expect(() => inspectImports('entry.mjs', f)).toThrow(/incomplete.*repair.*retry/i);
  });

  it.each([
    ['file-budget', { maxFiles: 1 }, { 'entry.mjs': "import './child.mjs';", 'child.mjs': '' }],
    ['byte-budget', { maxBytes: 1 }, { 'entry.mjs': '/* oversized */' }],
    ['time-budget', { maxMs: 10, now: (() => { let tick = 0; return () => tick++ * 11; })() }, { 'entry.mjs': '' }],
  ])('refuses %s rather than reporting partial evidence as success', (reason, options, files) => {
    const f = syntaxFixture(files);
    expect(() => inspectImports('entry.mjs', { ...f, ...options })).toThrow(new RegExp(`incomplete.*${reason}.*repair.*retry`, 'i'));
    if (reason === 'file-budget') expect(f.read).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['untrusted-input-path', "import '../outside.mjs';", /outside-root/],
    ['unsupported-specifier', "import 'https://example.invalid/module.mjs';", /unsupported-specifier/],
    ['malformed-file-url', "import 'file://%';", /invalid-file-url/],
  ])('refuses %s without reading an alternative path', (_name, source, reason) => {
    const f = syntaxFixture({ 'entry.mjs': source });
    expect(() => inspectImports('entry.mjs', f)).toThrow(reason);
    expect(f.read).toHaveBeenCalledTimes(1);
  });
});
