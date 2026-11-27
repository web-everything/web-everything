import { afterEach, describe, it, expect, vi } from 'vitest';
import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { parseSupersedes } from '../../conveyor/supersede-rule.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const SYNTAX_LIMITS = Object.freeze({ maxFiles: 128, maxBytes: 4 * 1024 * 1024, maxMs: 10_000 });
const NON_CLAIMS = Object.freeze([
  'invoked-function loads', 'eval', 'aliased createRequire', 'computed specifiers',
  'local require/import calls are classified but not followed',
]);

/**
 * Bounded syntax evidence, never a proof of the runtime import closure. Follow import/re-export
 * declarations; additionally flag literal require/import calls on non-indented lines. Parse calls
 * as syntax so quoted eval text is not mistaken for a load. No source is executed.
 * All IO, paths and time are supplied by the caller; incomplete evidence throws, never returns [].
 */
function inspectImports(entry, { root: repoRoot, read, now, ...limits }) {
  const { maxFiles, maxBytes, maxMs } = { ...SYNTAX_LIMITS, ...limits };
  const refuse = (reason) => {
    throw new Error(`Incomplete dependency syntax evidence: ${reason}; repair the input or inspection budget and retry; runtime assurance requires a separate isolated import trace.`.replace(/[\x00-\x1f\x7f-\x9f]/g, ' '));
  };
  if (typeof repoRoot !== 'string' || !isAbsolute(repoRoot) || typeof read !== 'function' || typeof now !== 'function') refuse('required-input-missing');
  if (![maxFiles, maxBytes, maxMs].every((n) => Number.isSafeInteger(n) && n > 0)) refuse('invalid-budget');
  const started = now();
  let last = started;
  const checkTime = () => {
    const tick = now();
    if (!Number.isFinite(started) || !Number.isFinite(tick) || tick < last) refuse('invalid-clock');
    last = tick;
    if (tick - started >= maxMs) refuse('time-budget');
  };
  const localPath = (absolute) => {
    const path = relative(repoRoot, absolute);
    if (!path || path === '..' || path.startsWith('../') || isAbsolute(path)) refuse(`outside-root: ${absolute}`);
    return path;
  };
  const classify = (name, path) => {
    if (isBuiltin(name)) return { builtin: true };
    if (name.startsWith('./') || name.startsWith('../')) return { local: localPath(resolve(repoRoot, dirname(path), name)) };
    if (isAbsolute(name)) return { local: localPath(name) };
    if (name.startsWith('file:')) {
      let absolute;
      try { absolute = fileURLToPath(name); } catch (error) { refuse(`invalid-file-url: ${error.message}`); }
      return { local: localPath(absolute) };
    }
    if (!name || /^[a-zA-Z][\w+.-]*:/.test(name)) refuse(`unsupported-specifier: ${name}`);
    return { package: name };
  };
  const seen = new Set();
  const packages = [];
  let bytes = 0;
  function walk(path, chain) {
    checkTime();
    if (seen.has(path)) return;
    if (seen.size >= maxFiles) refuse('file-budget');
    seen.add(path);
    let text;
    try { text = read(path, maxBytes - bytes); } catch (error) { refuse(`read-failed: ${path}: ${error.message}`); }
    checkTime();
    if (typeof text !== 'string') refuse(`read-failed: ${path}: missing source text`);
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > maxBytes) refuse('byte-budget');
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (source.parseDiagnostics.length) refuse(`malformed-module: ${path}`);
    const lines = text.split('\n');
    const calls = [source];
    while (calls.length) {
      checkTime();
      const node = calls.pop();
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        const line = lines[source.getLineAndCharacterOfPosition(node.getStart(source)).line];
        const argument = node.arguments[0];
        if (/^\S/.test(line) && argument && ts.isStringLiteral(argument)) {
          const target = classify(argument.text, path);
          if (target.package) packages.push([...chain, path, target.package].join(' -> '));
        }
      }
      ts.forEachChild(node, (child) => { calls.push(child); });
    }
    for (const statement of source.statements) {
      checkTime();
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier) continue;
      if (!ts.isStringLiteral(specifier)) refuse(`unreadable-import: ${path}`);
      const target = classify(specifier.text, path);
      if (target.local) walk(target.local, [...chain, path]);
      else if (target.package) packages.push([...chain, path, target.package].join(' -> '));
    }
  }
  walk(localPath(resolve(repoRoot, entry)), []);
  checkTime();
  return { packages, visited: [...seen], nonClaims: NON_CLAIMS, assurance: 'bounded syntax only; runtime import closure unproven' };
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
    ['invoked-function loads', "function load() {\n  return import('external');\n}\nload();"],
    ['eval', 'eval("import(\'external\')");'],
    ['aliased createRequire', "import { createRequire as makeRequire } from 'node:module';\nconst load = makeRequire(import.meta.url);\nload('external');"],
  ])('explicitly excludes %s from its proof, even when the fixture invokes the load', (nonClaim, source) => {
    const f = syntaxFixture({ 'entry.mjs': source });
    const evidence = inspectImports('entry.mjs', f);
    expect(evidence.packages).toEqual([]);
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
