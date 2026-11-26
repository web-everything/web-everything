/** S1.1 identity contract. @repo-scanning-test scope=files */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as pushLint from '../push-gate-lint.mjs';
import {
  RUNNING_ROOT, SUITE_ENTRIES, SUITE_JSON_RUNTIME_NAMES, COMPUTED_LOADS, K6_AUDITED_READS,
  PER_LAUNCH_ENV, smokeIdentityComponents, suiteManifest, smokeSuiteHash,
  effectiveEnvEntries, effectiveEnvHash, preSlotOwnershipOk, confirmCandidateOwnership,
  codeEnvNames, sharedSmokeIdentity, sharedDerivedKey,
} from '../daemon-rebuild/shared-smoke-key.mjs';
import { SMOKE_CHECKS, SMOKE_BUDGET_ENV } from '../daemon-live-smoke.mjs';
import { REBUILD_SMOKE_BUDGET_ENV } from '../daemon-rebuild/smoke.mjs';
import { REPO_SCAN_TESTS, selectScanTests, scanRoot, scanScope } from '../repo-scan-tests.mjs';

const auditGitPorts = vi.hoisted(() => new Map());
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, spawnSync(command, args, options) {
    if (command === 'git' && args[0] === '-C' && auditGitPorts.has(args[1])) {
      return auditGitPorts.get(args[1])(args[1], args.slice(2));
    }
    return actual.spawnSync(command, args, options);
  } };
});

const dirs = [];
const hash = value => createHash('sha256').update(value).digest('hex');
const checks = [{ name: 'code', kind: 'code', mayBeTransient: false, codeEntries: ['entry.mjs'] }];
function temp() { const p = mkdtempSync(join(tmpdir(), 'shared-smoke-key-')); dirs.push(p); return p; }
function put(root, file, text = '') {
  const path = join(root, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); return path;
}
function git(root, args) {
  return spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir(), GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  });
}
function ok(root, args) { const r = git(root, args); if (r.status !== 0) throw new Error(r.stderr || r.error?.message); return r.stdout.trim(); }
function fixture() {
  const base = temp(); const root = join(base, 'clone'); mkdirSync(root);
  ok(root, ['init', '-q']); ok(root, ['remote', 'add', 'origin', 'https://example.test/we.git']);
  for (const path of SUITE_ENTRIES) put(root, path, 'export const stub = 1;');
  put(root, 'entry.mjs', 'export const code = 1;'); put(root, 'package-lock.json', '{}');
  put(root, 'scripts/settings/gh-throttle.json', '{}');
  const pool = join(base, 'pool'); const state = join(base, 'state'); mkdirSync(pool); mkdirSync(state);
  const env = { PATH: process.env.PATH, HOME: base, TMPDIR: base, LANE_POOL_ROOT: pool,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    WE_PLATFORM_PREFERENCES_FILE: join(base, 'operator.json'), WE_DAEMON_SMOKE_STATE_DIR: state, WE_DAEMON_STATE_DIR: state,
    WE_DISPATCH_CWD_ROOT: join(base, 'dispatch') };
  ok(root, ['add', '.']); ok(root, ['commit', '-qm', 'fixture']);
  const predictedCandidatePath = join(state, 'clone.candidate-first');
  return { root, base, env, predictedCandidatePath, sha: ok(root, ['rev-parse', 'HEAD']),
    suite: { root, env, checks }, git: args => git(root, args) };
}
function harnessFixture() {
  const f = fixture();
  // Model the harness graph in a private tracked tree. Keep the CLI module byte-for-byte
  // intact, and load its real runtime helpers as package dependencies, outside this graph.
  // This isolates closure tests from unrelated imports added to the installed harness.
  put(f.root, '.gitignore', 'node_modules\n');
  mkdirSync(join(f.root, 'node_modules'));
  symlinkSync(RUNNING_ROOT, join(f.root, 'node_modules/fixture-implementation'), 'dir');
  const require = createRequire(import.meta.url);
  symlinkSync(dirname(require.resolve('typescript/package.json')), join(f.root, 'node_modules/typescript'), 'dir');
  const runtime = (file, names) => put(f.root, file.replace(/^scripts\//, 'runtime/'),
    `export { ${names} } from 'fixture-implementation/${file}';`);
  // The executable has the same depth as the installed module, so RUNNING_ROOT is
  // the fixture root. Its suite entries remain independent inputs to the test.
  const keyFile = 'runtime/lib/daemon-rebuild/shared-smoke-key.mjs';
  put(f.root, keyFile, readFileSync(join(RUNNING_ROOT, 'scripts/lib/daemon-rebuild/shared-smoke-key.mjs')));
  runtime('scripts/lib/daemon-rebuild/candidate.mjs', 'candidateSmokeEnv, candidateWorktreePath');
  runtime('scripts/lib/lane-pool-paths.mjs', 'defaultPoolRoot');
  runtime('scripts/lib/lane-git-hardening.mjs', 'scrubGitRepoEnv');
  runtime('scripts/lib/policy-cascade.mjs', 'operatorPreferencesPath');
  runtime('scripts/lib/daemon-live-smoke.mjs', 'SMOKE_CHECKS, SMOKE_BUDGET_ENV');
  put(f.root, 'scripts/lib/daemon-live-smoke.mjs',
    "import './github-app-auth-env.mjs'; import './resource-admission.mjs';");
  for (const check of SMOKE_CHECKS) for (const entry of check.codeEntries ?? []) put(f.root, entry, 'export {};');
  put(f.root, 'scripts/lane-pool.mjs', "import './lib/gh-throttle.mjs'; const liveClone = process.env.WE_SMOKE_LIVE_CLONE;");
  put(f.root, 'scripts/conveyor/reconcile-pass.mjs', "import './pr-snapshot.mjs'; import '../lib/under-test.mjs';");
  for (const file of ['github-app-auth-env.mjs', 'resource-admission.mjs', 'gh-throttle.mjs']) put(f.root, `scripts/lib/${file}`, 'export {};');
  put(f.root, 'scripts/conveyor/pr-snapshot.mjs', 'export {};');
  put(f.root, 'scripts/lib/under-test.mjs', "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); require('./under-test.cjs');");
  put(f.root, 'scripts/lib/under-test.cjs', 'module.exports = {};');
  ok(f.root, ['add', '.']); ok(f.root, ['commit', '-qm', 'harness fixture']);
  f.sha = ok(f.root, ['rev-parse', 'HEAD']);
  return { ...f, cli: join(f.root, keyFile) };
}
function identity(f, extra = {}) {
  return sharedSmokeIdentity({ root: f.root, sha: f.sha, env: f.env,
    predictedCandidatePath: f.predictedCandidatePath, suiteRoot: f.root, checks, ...extra });
}
// This is an explicitly refused production edge, not an exception authorizing sharing.
// Audit the remaining graph too, so an earlier refusal cannot hide a later regression.
const PRODUCTION_REFUSED_LOADS = [
  ['scripts/capability-search.mjs', "requireCjs(join(ROOT, 'src/_data/backlog.js'))"],
  ['scripts/operations/suggest-next-io.mjs', "require(join(root, 'src/_data/backlog.js'))"],
  ['scripts/readiness/remote-client-import.cjs', 'import(specifier)'],
];
const PRODUCTION_PRESENCE_READS = [
  ['scripts/lib/pr-snapshot.mjs', '  if (!env.WE_SMOKE_LIVE_CLONE || !smokeChild) return env;'],
  ['scripts/lib/pr-snapshot.mjs', 'export function sampleContextDeclared(env = process.env) { return sampleDeclared(env) || Boolean(env?.WE_SMOKE_LIVE_CLONE); }'],
];
function productionAudit(root) {
  root = realpathSync(root);
  const inventory = spawnSync('git', ['-c', 'core.fsmonitor=false', 'ls-files', '-z', '--', '*.mjs', '*.cjs', '*.js', '*.json'], {
    cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: tmpdir(), TMPDIR: tmpdir(), GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
  if (inventory.error || inventory.status !== 0 || !inventory.stdout?.endsWith('\0')) throw new Error('production-inventory-unreadable');
  const tracked = new Set(inventory.stdout.split('\0').filter(Boolean));
  const pending = [...SUITE_ENTRIES, ...SMOKE_CHECKS.flatMap(check => check.codeEntries ?? [])];
  const sources = new Map(); const unsupported = []; const readers = []; const presenceReaders = [];
  for (const entry of pending) if (!tracked.has(entry)) throw new Error(`production-entry-untracked:${entry}`);
  const inside = path => { const p = relative(root, path); return p !== '..' && !p.startsWith(`..${sep}`) && !isAbsolute(p); };
  while (pending.length) {
    const file = pending.pop(); if (sources.has(file)) continue;
    const path = join(root, file);
    if (sources.size >= 10000 || statSync(path).size > 1024 * 1024) throw new Error('production-input-bound');
    if (!inside(realpathSync(path))) throw new Error(`production-load-out-of-root:${file}`);
    const text = readFileSync(path, 'utf8');
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('production-input-bound');
    sources.set(file, text);
    if (file.endsWith('.json')) { JSON.parse(text); continue; }
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (ast.parseDiagnostics.length) throw new Error(`production-source-malformed:${file}`);
    const creators = new Set(['createRequire']); const requires = new Set(['require']);
    function bindings(node) {
      if (ts.isImportSpecifier(node) && (node.propertyName?.text ?? node.name.text) === 'createRequire') creators.add(node.name.text);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)
        && creators.has(node.initializer.expression.getText(ast))) requires.add(node.name.text);
      ts.forEachChild(node, bindings);
    }
    bindings(ast);
    function load(spec) {
      if (spec.startsWith('node:')) return;
      if (!spec.startsWith('.')) {
        if (isAbsolute(spec) || !/^[@a-z\d_-][^\s]*$/i.test(spec)) throw new Error(`production-load-invalid:${file}:${spec}`);
        if (!tracked.has('package-lock.json')) throw new Error('production-lock-untracked');
        pending.push('package-lock.json'); return;
      }
      const base = resolve(dirname(path), spec);
      if (!inside(base)) throw new Error(`production-load-out-of-root:${file}:${spec}`);
      const target = ['', '.mjs', '.js', '.cjs', '.json', '/index.mjs', '/index.js', '/index.cjs']
        .map(suffix => relative(root, base + suffix)).find(candidate => tracked.has(candidate));
      if (!target) throw new Error(`production-load-unresolved:${file}:${spec}`);
      pending.push(target);
    }
    const envObject = node => node && (node.getText(ast) === 'process.env' || node.getText(ast) === 'env' || node.getText(ast).endsWith('.env'));
    function recordReader(node) {
      const line = text.split('\n')[ast.getLineAndCharacterOfPosition(node.getStart(ast)).line];
      const pin = PRODUCTION_PRESENCE_READS.find(([path, exactLine]) => path === file && exactLine === line);
      if (pin) presenceReaders.push(pin); else readers.push(file);
    }
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) load(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || requires.has(node.expression.getText(ast))
        || (ts.isCallExpression(node.expression) && creators.has(node.expression.expression.getText(ast))))) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) load(arg.text);
        else {
          const pin = COMPUTED_LOADS.find(pin => pin.file === file && pin.exactText === node.getText(ast));
          if (pin) { if (!tracked.has(pin.target)) throw new Error(`production-load-untracked:${pin.target}`); pending.push(pin.target); }
          else unsupported.push([file, node.getText(ast)]);
        }
      }
      if ((ts.isPropertyAccessExpression(node) && envObject(node.expression) && node.name.text === 'WE_SMOKE_LIVE_CLONE')
        || (ts.isElementAccessExpression(node) && envObject(node.expression) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'WE_SMOKE_LIVE_CLONE')) recordReader(node);
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && envObject(node.initializer)) {
        for (const binding of node.name.elements) if ((binding.propertyName ?? binding.name).text === 'WE_SMOKE_LIVE_CLONE') recordReader(binding);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  return { sources, unsupported: unsupported.sort(), readers: readers.sort(), presenceReaders: presenceReaders.sort() };
}
function assertProductionAudit(audit, scope = null) {
  const selected = file => !scope || scope.has(file);
  if (JSON.stringify(audit.unsupported.filter(([file]) => selected(file))) !== JSON.stringify(PRODUCTION_REFUSED_LOADS.filter(([file]) => selected(file)))) {
    throw new Error(`production-dynamic-load-drift:${JSON.stringify(audit.unsupported)}`);
  }
  if (JSON.stringify(audit.readers.filter(selected)) !== JSON.stringify(['scripts/lane-pool.mjs'].filter(selected))) {
    throw new Error(`production-reader-drift:${JSON.stringify(audit.readers)}`);
  }
  if (JSON.stringify(audit.presenceReaders.filter(([file]) => selected(file))) !== JSON.stringify(PRODUCTION_PRESENCE_READS.filter(([file]) => selected(file)))) {
    throw new Error(`production-presence-reader-drift:${JSON.stringify(audit.presenceReaders)}`);
  }
}
afterEach(() => { auditGitPorts.clear(); for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true }); });

// Audit regressions use only private files and an injected Git port. No host,
// checkout, installed dependency, process inspection or remote is consulted.
function auditFixture() {
  const base = temp(); const root = join(base, 'repo'); const pool = join(base, 'pool');
  mkdirSync(root); mkdirSync(pool); mkdirSync(join(root, '.git')); mkdirSync(join(base, 'state'));
  for (const file of SUITE_ENTRIES) put(root, file, 'export {};');
  put(root, 'entry.mjs', 'export {};'); put(root, 'package-lock.json', '{}');
  put(root, 'scripts/settings/base.json', '{}');
  const env = { PATH: '/fixture/bin', HOME: base, TMPDIR: base, LANE_POOL_ROOT: pool,
    LANE_POOL_CANONICAL_ORIGIN: 'https://example.test/we.git', WE_DISPATCH_CWD_ROOT: join(base, 'dispatch'),
    WE_PLATFORM_PREFERENCES_FILE: put(base, 'preferences.json', '{}') };
  const git = (cwd, args) => {
    if (realpathSync(cwd) !== realpathSync(root)) throw new Error('unexpected-fixture-cwd');
    let stdout;
    if (args[0] === 'ls-files') stdout = 'scripts/settings/base.json\0';
    else if (args[0] === 'rev-parse' && args[1] === '--verify') stdout = 'a'.repeat(40);
    else if (args[0] === 'rev-parse') stdout = args[1] === '--show-toplevel' ? root : join(root, '.git');
    else if (args[0] === 'show') stdout = '{}';
    else if (args.join(' ') === 'remote get-url origin') stdout = env.LANE_POOL_CANONICAL_ORIGIN;
    else throw new Error(`unexpected-fixture-git:${args.join(' ')}`);
    return { status: 0, stdout, stderr: '' };
  };
  const overridesFile = put(base, 'operator-overrides.json', '{}');
  auditGitPorts.set(root, git);
  auditGitPorts.set(realpathSync(root), git);
  const log = { error() {} };
  const suite = { root, env, checks, git, overridesFile, log };
  const key = extra => sharedSmokeIdentity({ root, sha: 'fixture-head', predictedCandidatePath: join(base, 'state', 'candidate'),
    suiteRoot: root, env, checks, git, overridesFile, host: 'fixture-host', nodeVersion: 'v24.fixture', log, ...extra });
  return { root, base, env, git, suite, key, overridesFile };
}

describe('fix-round audit regressions (hermetic)', () => {
  it('finding 1: pins each admitted call and refuses a push-bearing replacement with the same count', () => {
    const file = 'scripts/lib/daemon-rebuild/shared-smoke-key.mjs';
    const source = "spawnSync('git', ['-C', root, ...args], { timeout: 5000 });";
    const replacement = "spawnSync('git', ['-C', root, 'push', ...args], { timeout: 5000 });";
    expect(pushLint.findRawPushes(source)).toHaveLength(1);
    expect(pushLint.findRawPushes(replacement)).toHaveLength(1);
    const entry = { status: 'pending-migration', reason: 'bounded fixture read', sites: 1,
      callSites: [{ text: source.slice(0, -1), reason: 'read-only injected fixture port' }] };
    expect(() => pushLint.admitRawPushSites(source, file, entry)).not.toThrow();
    expect(() => pushLint.admitRawPushSites(replacement, file, entry)).toThrow(/site.*drift/);
    expect(() => pushLint.admitRawPushSites(source, file, { ...entry, callSites: [] })).toThrow(/site.*drift/);
  });
  it('finding 2: refuses require aliases and namespace createRequire even outside changed files', () => {
    const f = auditFixture();
    expect(suiteManifest(f.suite)).not.toBeNull();
    for (const source of [
      'const r = require; r(target);',
      "import * as mod from 'node:module'; const r = mod.createRequire(import.meta.url); r(target);",
      "import * as mod from 'node:module'; mod['createRequire'](import.meta.url)(target);",
      'const { createRequire: make } = require("node:module"); const r = make(import.meta.url); r(target);',
    ]) {
      put(f.root, 'entry.mjs', source);
      expect(suiteManifest(f.suite), source).toBeNull();
      expect(codeEnvNames(f.root, { ...f.suite, entries: ['entry.mjs'] }), source).toBeNull();
    }
  });
  it('finding 3: refuses bare imports without verified installed version and file evidence', () => {
    const f = auditFixture(); expect(suiteManifest(f.suite)).not.toBeNull();
    put(f.root, 'entry.mjs', "import 'not-installed';");
    expect(suiteManifest(f.suite)).toBeNull();
    put(f.root, 'node_modules/not-installed/package.json', '{"name":"not-installed","version":"1.0.0","main":"index.js"}');
    put(f.root, 'node_modules/not-installed/index.js', 'module.exports = 1;');
    const before = smokeSuiteHash(f.suite);
    put(f.root, 'node_modules/not-installed/index.js', 'module.exports = 2;');
    const after = smokeSuiteHash(f.suite);
    expect(before === null || (after !== null && before !== after)).toBe(true);
  });
  it('finding 4: refuses computed, aliased, rest and spread environment reads', () => {
    const f = auditFixture();
    expect(codeEnvNames(f.root, { ...f.suite, entries: ['entry.mjs'] })).not.toBeNull();
    for (const source of ['process.env[name];', 'env?.[name];', 'const e = process.env; e.WE_CONTROL;',
      'const e = env; e.WE_CONTROL;', 'const { env: e } = process; e.WE_CONTROL;',
      'const { ...rest } = process.env;', 'const copy = { ...process.env };',
      "process['env'][name];"]) {
      put(f.root, 'entry.mjs', source);
      expect(codeEnvNames(f.root, { ...f.suite, entries: ['entry.mjs'] }), source).toBeNull();
      expect(f.key(), source).toBeNull();
    }
  });
  it('finding 5: includes untracked settings JSON and refuses unreadable or malformed policy', () => {
    const f = auditFixture(); const before = smokeSuiteHash(f.suite);
    expect(before).toMatch(/^[a-f0-9]{64}$/);
    const path = put(f.root, 'scripts/settings/untracked.json', '{"capacity":1}');
    expect(smokeSuiteHash(f.suite)).not.toBe(before);
    expect(suiteManifest(f.suite).map(([file]) => file)).toContain('scripts/settings/untracked.json');
    expect(suiteManifest({ ...f.suite, readFile: file => {
      if (file === path) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return readFileSync(file);
    } })).toBeNull();
    writeFileSync(path, '{broken'); expect(suiteManifest(f.suite)).toBeNull();
  });
  it('finding 6: binds operator-overrides content and refuses unreadable or malformed store state', () => {
    const f = auditFixture(); const before = smokeSuiteHash(f.suite);
    writeFileSync(f.overridesFile, '{"lanes.maxConcurrent":1}');
    expect(smokeSuiteHash(f.suite)).not.toBe(before);
    expect(suiteManifest({ ...f.suite, readFile: file => {
      if (file === f.overridesFile) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return readFileSync(file);
    } })).toBeNull();
    writeFileSync(f.overridesFile, '{broken'); expect(suiteManifest(f.suite)).toBeNull();
  });
  it('finding 7: hashes inherited and closure-discovered env names automatically', () => {
    const f = auditFixture(); put(f.root, 'entry.mjs', 'process.env.CUSTOM_AUTH_CONFIG;');
    const before = f.key(); expect(before).not.toBeNull();
    for (const name of ['XDG_CONFIG_HOME', 'TMPDIR', 'CUSTOM_AUTH_CONFIG', 'CI']) {
      const changed = f.key({ env: { ...f.env, [name]: 'different' } });
      expect(changed).not.toBeNull(); expect(changed.key, name).not.toBe(before.key);
    }
    expect(f.key({ env: { ...f.env, CUSTOM_AUTH_CONFIG: '' } }).key).not.toBe(before.key);
  });
  it('finding 8: caller envIgnore cannot remove any safety control', () => {
    const f = auditFixture();
    const options = { root: f.root, ownershipOk: true, envIgnore: ['WE_CONTROL'], log: f.suite.log };
    const a = effectiveEnvHash({ ...options, env: { ...f.env, WE_CONTROL: '0' } });
    const b = effectiveEnvHash({ ...options, env: { ...f.env, WE_CONTROL: '1' } });
    expect(a === null || a !== b).toBe(true);
  });
  it('finding 9: hashes credential values and authentication metadata rather than presence', () => {
    const f = auditFixture();
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'WE_GH_AUTH_INSTALLATION', 'CUSTOM_PASSWORD']) {
      const options = { root: f.root, ownershipOk: true, env: { ...f.env, [name]: 'secret-one' } };
      const entries = effectiveEnvEntries(options);
      expect(entries).toContainEqual([name, hash('secret-one')]);
      expect(JSON.stringify(entries)).not.toContain('secret-one');
      expect(effectiveEnvHash(options)).not.toBe(effectiveEnvHash({ ...options, env: { ...options.env, [name]: 'secret-two' } }));
    }
  });
  it('finding 10: scoped auditing refuses an unsupported load in an unchanged reachable dependency', () => {
    const audit = { unsupported: [...PRODUCTION_REFUSED_LOADS, ['unchanged-dependency.mjs', 'import(target)']].sort(),
      readers: ['scripts/lane-pool.mjs'], presenceReaders: PRODUCTION_PRESENCE_READS };
    expect(() => assertProductionAudit(audit, new Set(['changed-importer.mjs']))).toThrow(/production-dynamic-load-drift/);
  });
});

describe('K1, K7, K8: canonical identities', () => {
  it('binds tree, lockfile, Node, suite checks, origin and host with fixed-order serialization', () => {
    const f = fixture(); const a = identity(f);
    expect(a).not.toBeNull(); expect(identity(f)).toEqual(a);
    expect(a.key).toBe(hash(JSON.stringify([1, a.tree, a.lockHash, a.nodeVersion, a.suiteHash, a.envHash, hostname(), a.liveOrigin])));
    for (const extra of [{ nodeVersion: 'v999' }, { host: 'other-host' }, { checks: [{ ...checks[0], mayBeTransient: true }] }]) {
      expect(identity(f, extra).key).not.toBe(a.key);
    }
    ok(f.root, ['remote', 'set-url', 'origin', 'ssh://example.test/other.git']); expect(identity(f).key).not.toBe(a.key);
    put(f.root, 'package-lock.json', '{"changed":true}'); ok(f.root, ['add', '.']); ok(f.root, ['commit', '-qm', 'lock']);
    const b = identity(f, { sha: ok(f.root, ['rev-parse', 'HEAD']) }); expect(b.tree).not.toBe(a.tree); expect(b.lockHash).not.toBe(a.lockHash);
    expect(sharedDerivedKey(a.key, 'local')).toBe(`shared-${hash(`${a.key}:local`)}`);
  });
  it('distinguishes an absent lock from an unreadable lock and refuses invalid or timed-out git evidence', () => {
    const f = fixture(); const a = smokeIdentityComponents(f.git, f.sha);
    expect(a).toEqual({ tree: ok(f.root, ['rev-parse', 'HEAD^{tree}']), lockHash: hash('{}'), nodeVersion: process.version });
    ok(f.root, ['rm', 'package-lock.json']); ok(f.root, ['commit', '-qm', 'no lock']);
    expect(smokeIdentityComponents(f.git, 'HEAD').lockHash).toBe('');
    expect(smokeIdentityComponents(args => args[0] === 'show' ? { status: 1 } : f.git(args), f.sha)).toBeNull();
    for (const r of [{ status: 1 }, { status: null, error: new Error('timeout') }, { status: 0, stdout: 'ambiguous\nlines' }]) {
      expect(smokeIdentityComponents(() => r, f.sha)).toBeNull();
    }
  });
});

describe('K2: strict suite manifest', () => {
  it('K2a: locates the running root and covers the fixture harness closure', () => {
    expect(RUNNING_ROOT).toBe(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
    const f = harnessFixture(); const root = f.root;
    const manifest = suiteManifest({ root, env: f.env }); expect(manifest).not.toBeNull();
    const paths = manifest.map(([p]) => p);
    const entries = [...SUITE_ENTRIES, ...SMOKE_CHECKS.flatMap(check => check.codeEntries ?? [])];
    const tracked = git(root, ['ls-files', '-z', '--', ...entries]);
    expect(tracked.error, 'smoke entry inventory must be readable').toBeUndefined();
    expect(tracked.status, tracked.stderr).toBe(0);
    const trackedEntries = new Set(tracked.stdout.split('\0').filter(Boolean));
    for (const entry of entries) {
      expect(trackedEntries.has(entry), `${entry} must be tracked`).toBe(true);
      expect(paths, `${entry} must be hashed`).toContain(entry);
    }
    for (const path of ['scripts/lib/github-app-auth-env.mjs', 'scripts/lib/resource-admission.mjs',
      'scripts/conveyor/pr-snapshot.mjs', 'scripts/lib/gh-throttle.mjs', 'scripts/lib/under-test.mjs', 'scripts/lib/under-test.cjs']) {
      expect(paths).toContain(path);
    }
    expect(smokeSuiteHash({ root, env: f.env })).toMatch(/^[a-f0-9]{64}$/);
  });
  it('K2b: missing entries, deleted imports, unreadable inputs and escaped targets refuse sharing', () => {
    const f = fixture(); expect(suiteManifest(f.suite)).not.toBeNull();
    for (const source of ["import './missing.mjs'", "import '../outside.mjs'"]) {
      put(f.root, 'entry.mjs', source); expect(suiteManifest(f.suite)).toBeNull();
    }
    put(f.root, 'entry.mjs', "import './escape.mjs'"); put(f.base, 'outside.mjs', 'export {}');
    symlinkSync(join(f.base, 'outside.mjs'), join(f.root, 'escape.mjs')); expect(suiteManifest(f.suite)).toBeNull();
    put(f.root, 'entry.mjs', 'export {}');
    expect(suiteManifest({ ...f.suite, readFile: () => { throw new Error('unreadable'); } })).toBeNull();
    rmSync(join(f.root, SUITE_ENTRIES[0])); expect(suiteManifest(f.suite)).toBeNull();
  });
  it('K2c/K2d: runtime names are explicit; basename matches include every tracked duplicate', () => {
    const f = fixture(); put(f.root, 'a/config.json', '{}'); put(f.root, 'b/config.json', '{"b":1}'); ok(f.root, ['add', '.']);
    put(f.root, 'entry.mjs', "const x = 'config.json';");
    expect(suiteManifest(f.suite).map(([p]) => p)).toEqual(expect.arrayContaining(['a/config.json', 'b/config.json']));
    for (const name of SUITE_JSON_RUNTIME_NAMES) {
      put(f.root, 'entry.mjs', `const runtime = ${JSON.stringify(name)};`); expect(suiteManifest(f.suite), name).not.toBeNull();
    }
    put(f.root, 'entry.mjs', "const typo = 'unlisted-runtime.json';"); expect(suiteManifest(f.suite)).toBeNull();
    put(f.root, 'entry.mjs', "const direct = './a/config.json'; const rooted = 'b/config.json';"); expect(suiteManifest(f.suite)).not.toBeNull();
  });
  it('K2e: includes settings, packages and the operator file (only ENOENT means absent)', () => {
    const f = fixture(); const a = smokeSuiteHash(f.suite);
    put(f.root, 'scripts/settings/gh-throttle.json', '{"x":1}'); expect(smokeSuiteHash(f.suite)).not.toBe(a);
    const b = smokeSuiteHash(f.suite); writeFileSync(f.env.WE_PLATFORM_PREFERENCES_FILE, '{}'); expect(smokeSuiteHash(f.suite)).not.toBe(b);
    const manifest = suiteManifest(f.suite); expect(manifest).toEqual([...manifest].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    expect(suiteManifest({ ...f.suite, readFile: path => {
      if (path === f.env.WE_PLATFORM_PREFERENCES_FILE) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return readFileSync(path);
    } })).toBeNull();
    put(f.root, 'entry.mjs', "import 'a-package'"); expect(suiteManifest(f.suite).map(([p]) => p)).toContain('package-lock.json');
    rmSync(join(f.root, 'package-lock.json')); expect(suiteManifest(f.suite)).toBeNull();
  });
  it.each(["import(target)", "require(target)", "createRequire(import.meta.url)(target)",
    "const r = createRequire(import.meta.url); r(target)"] )('K2f: rejects non-literal load %s', source => {
    const f = fixture(); put(f.root, 'entry.mjs', source); expect(suiteManifest(f.suite)).toBeNull();
  });
  it('K2g: follows ESM, CommonJS, immediate and bound createRequire, including extension/index resolution', () => {
    const f = fixture(); put(f.root, 'entry.mjs', "import './a'; export * from './b'; import('./c'); require('./d'); createRequire(import.meta.url)('./e'); const r = createRequire(import.meta.url); r('./f');");
    for (const p of ['a.mjs', 'b.js', 'c.cjs', 'd/index.mjs', 'e/index.js', 'f/index.cjs']) put(f.root, p, '/* leaf */');
    expect(suiteManifest(f.suite).map(([p]) => p)).toEqual(expect.arrayContaining(['a.mjs', 'b.js', 'c.cjs', 'd/index.mjs', 'e/index.js', 'f/index.cjs']));
    put(f.root, 'f/index.cjs', "require('./gone')"); expect(suiteManifest(f.suite)).toBeNull();
  });
  it('K2h: follows only the exact audited computed-load text; one-byte drift refuses', () => {
    const f = fixture(); const pin = COMPUTED_LOADS[0];
    put(f.root, 'entry.mjs', `import './${pin.file}'`); put(f.root, pin.file, pin.exactText); put(f.root, pin.target, 'module.exports = {};');
    expect(suiteManifest(f.suite).map(([p]) => p)).toContain(pin.target);
    put(f.root, pin.file, pin.exactText.replace('root,', 'root ,')); expect(suiteManifest(f.suite)).toBeNull();
  });
  it('bounds oversized inputs and reports the refusal and operator fallback', () => {
    const f = fixture(); const reasons = []; put(f.root, 'entry.mjs', ' '.repeat(1024 * 1024 + 1));
    expect(suiteManifest({ ...f.suite, log: { error: s => reasons.push(s) } })).toBeNull();
    expect(reasons.join('\n')).toMatch(/smoke-shared-key.*input-too-large.*per-clone/);
  });
});

describe('K3: pre-slot and candidate ownership', () => {
  it('K3b/K3f: equal same-origin clones need no materialized candidate; confirm never changes the key', () => {
    const f = fixture(); const other = join(f.base, 'other'); ok(f.base, ['clone', '-q', f.root, other]);
    ok(other, ['remote', 'set-url', 'origin', 'https://example.test/we.git']);
    const a = identity(f); expect(a).not.toBeNull();
    expect(preSlotOwnershipOk(f.root, f.predictedCandidatePath, f.env)).toBe(true);
    expect(identity(f, { root: other }).key).toBe(a.key);
    ok(f.root, ['worktree', 'add', '--detach', f.predictedCandidatePath, f.sha]);
    expect(confirmCandidateOwnership(f.predictedCandidatePath, f.root, f.env)).toBe(true);
    expect(identity(f)).toEqual(a); expect(confirmCandidateOwnership(other, f.root, f.env)).toBe(false);
  });
  it('K3a: workspace, PATH, HOME and fixture/test modes separate effective keys', () => {
    const f = fixture(); const a = identity(f).key;
    for (const env of [{ ...f.env, PATH: `${f.env.PATH}:/other` }, { ...f.env, HOME: 'other' }, { ...f.env, VITEST: 'true' },
      { ...f.env, FAKE_GH_FIXTURE: 'fixture' }, { ...f.env, VITEST_POOL_ID: '1' },
      { ...f.env, WE_DISPATCH_CWD_ROOT: join(f.base, 'other-workspace', 'dispatch') }]) {
      expect(identity(f, { env }).key).not.toBe(a);
    }
  });
  it('K3b/K3c: pool paths, lane components, failed probes and non-URL origins refuse', () => {
    const f = fixture();
    for (const predictedCandidatePath of [join(f.env.LANE_POOL_ROOT, 'candidate'), join(f.base, 'lane-7', 'candidate')]) {
      expect(identity(f, { predictedCandidatePath })).toBeNull();
    }
    const lane = join(f.base, 'lane-7'); ok(f.base, ['clone', '-q', f.root, lane]);
    const candidate = join(f.base, 'candidate'); ok(lane, ['worktree', 'add', '--detach', candidate, f.sha]);
    expect(confirmCandidateOwnership(candidate, f.root, f.env)).toBe(false);
    expect(preSlotOwnershipOk(join(f.base, 'missing'), f.predictedCandidatePath, f.env)).toBe(false);
    ok(f.root, ['remote', 'set-url', 'origin', '../local']); expect(identity(f)).toBeNull();
  });
  it('K3c: a separate git dir under the pool and a symlink into the pool refuse', () => {
    const f = fixture(); const separate = join(f.base, 'separate'); mkdirSync(separate);
    ok(separate, ['init', '-q', `--separate-git-dir=${join(f.env.LANE_POOL_ROOT, 'gitdir')}`]);
    expect(preSlotOwnershipOk(separate, f.predictedCandidatePath, f.env)).toBe(false);
    const alias = join(f.base, 'alias'); symlinkSync(f.env.LANE_POOL_ROOT, alias);
    expect(preSlotOwnershipOk(f.root, join(alias, 'candidate'), f.env)).toBe(false);
  });
  it('K3e: the presence-only live-clone name has exactly the lane-pool reader', () => {
    const f = harnessFixture(); const root = f.root;
    const result = codeEnvNames(root, { entries: ['scripts/lane-pool.mjs'], env: f.env }); expect(result).not.toBeNull();
    expect(result.reads.filter(r => r.name === 'WE_SMOKE_LIVE_CLONE').map(r => r.file)).toEqual(['scripts/lane-pool.mjs']);
  });
});

describe('production harness coverage', () => {
  it('keeps production closure and reader checks registered for changed source files', () => {
    const test = 'scripts/lib/__tests__/daemon-rebuild-shared-smoke-key.test.mjs';
    const registration = REPO_SCAN_TESTS.find(entry => entry.test === test);
    expect(registration?.scope).toBe('files');
    for (const file of ['scripts/lib/daemon-rebuild/candidate.mjs', 'scripts/readiness/remote-client-import.cjs',
      'skills-src/conveyor/review-daemon.mjs', 'src/_data/backlog.js']) {
      expect(selectScanTests({ changedFiles: [file] }).scoped).toContain(registration);
    }
    expect(selectScanTests({ changedFiles: [test] }).widened).toContain(registration);
  });
  it('K2a production: inventories installed entries and audits the actual closure, including its current refusal', () => {
    const f = fixture(); const root = scanRoot(RUNNING_ROOT); const scope = scanScope();
    const audit = productionAudit(root); assertProductionAudit(audit, scope);
    for (const path of [...SUITE_ENTRIES, ...SMOKE_CHECKS.flatMap(check => check.codeEntries ?? []),
      'scripts/lib/github-app-auth-env.mjs', 'scripts/lib/resource-admission.mjs',
      'scripts/lib/pr-snapshot.mjs', 'scripts/lib/gh-throttle.mjs', 'scripts/lib/under-test.mjs', 'scripts/lib/under-test.cjs']) {
      if (!scope || scope.has(path)) expect(audit.sources.has(path), path).toBe(true);
    }
    const refusals = [];
    expect(suiteManifest({ root, env: f.env, log: { error: reason => refusals.push(reason) } })).toBeNull();
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('suite:nonliteral-load:scripts/readiness/remote-client-import.cjs:');
  }, 30_000);
  it('K3e production: checks the real source reader rather than the fabricated fixture reader', () => {
    const audit = productionAudit(scanRoot(RUNNING_ROOT));
    assertProductionAudit(audit, scanScope());
    expect(audit.sources.get('scripts/lane-pool.mjs')).toEqual(readFileSync(join(scanRoot(RUNNING_ROOT), 'scripts/lane-pool.mjs'), 'utf8'));
    expect(audit.readers).toEqual(['scripts/lane-pool.mjs']);
    expect(audit.presenceReaders).toEqual(PRODUCTION_PRESENCE_READS);
  }, 30_000);
  it.each(['deleted entry', 'unresolved import', 'unsupported import', 'additional reader', 'changed presence reader'])('rejects a %s in a snapshot of the installed production closure', mutation => {
    const audit = productionAudit(RUNNING_ROOT); const f = fixture();
    for (const [path, source] of audit.sources) put(f.root, path, source);
    ok(f.root, ['add', '.']);
    assertProductionAudit(productionAudit(f.root));
    const target = mutation === 'changed presence reader' ? 'scripts/lib/pr-snapshot.mjs' : 'scripts/lib/daemon-rebuild/candidate.mjs';
    if (mutation === 'deleted entry') rmSync(join(f.root, SUITE_ENTRIES[0]));
    else if (mutation === 'changed presence reader') put(f.root, target,
      audit.sources.get(target).replace('Boolean(env?.WE_SMOKE_LIVE_CLONE)', 'String(env?.WE_SMOKE_LIVE_CLONE)'));
    else put(f.root, target, audit.sources.get(target) + (mutation === 'unresolved import'
      ? "\nimport './missing-production-dependency.mjs';" : mutation === 'unsupported import'
        ? '\nimport(unreviewedProductionTarget);' : '\nprocess.env.WE_SMOKE_LIVE_CLONE;'));
    const reason = mutation === 'deleted entry' ? /ENOENT/ : mutation === 'unresolved import'
      ? /production-load-unresolved/ : mutation === 'unsupported import' ? /production-dynamic-load-drift/ : /production-reader-drift/;
    expect(() => assertProductionAudit(productionAudit(f.root))).toThrow(reason);
  }, 30_000);
});

describe('K4: effective env and pinned read collection', () => {
  it('sorts canonically, distinguishes absence/empty, omits budgets and per-launch/ignored names, redacts secrets', () => {
    const f = fixture(); const base = effectiveEnvHash({ root: f.root, env: f.env, ownershipOk: true });
    const ignored = Object.fromEntries([...PER_LAUNCH_ENV, ...Object.values(SMOKE_BUDGET_ENV), ...Object.values(REBUILD_SMOKE_BUDGET_ENV)].map(n => [n, 'changed']));
    expect(effectiveEnvHash({ root: f.root, env: { ...f.env, ...ignored }, ownershipOk: true })).toBe(base);
    const opts = { root: f.root, ownershipOk: true, envIgnore: ['WE_IGNORED'], env: { ...f.env, WE_IGNORED: 'x', GH_TOKEN: 'sensitive', WE_EMPTY: '' } };
    const entries = effectiveEnvEntries(opts);
    expect(entries).toContainEqual(['GH_TOKEN', '<present>']); expect(entries).toContainEqual(['WE_EMPTY', '']);
    expect(entries).toContainEqual(['WE_SMOKE_LIVE_CLONE', '<present>']); expect(JSON.stringify(entries)).not.toContain('sensitive');
    expect(effectiveEnvHash(opts)).toBe(effectiveEnvHash({ ...opts, env: Object.fromEntries(Object.entries({ ...opts.env, GH_TOKEN: 'other' }).reverse()) }));
    expect(effectiveEnvHash({ ...opts, env: { ...opts.env, GH_TOKEN: '' } })).not.toBe(effectiveEnvHash(opts));
    expect(effectiveEnvHash({ ...opts, env: { ...opts.env, WE_EMPTY: undefined } })).not.toBe(effectiveEnvHash(opts));
    expect(effectiveEnvEntries({ ...opts, ownershipOk: false })).toBeNull();
    expect(effectiveEnvEntries({ ...opts, envIgnore: 'malformed' })).toBeNull();
    expect(JSON.stringify(identity(f))).not.toContain(f.env.PATH);
  });
  it('collects dot, optional, bracket and destructured literal env reads; audited text must match exactly', () => {
    const f = fixture(); const pin = K6_AUDITED_READS[0];
    put(f.root, 'entry.mjs', "process.env.CI; env?.WE_CUSTOM; process.env['GH_OTHER']; const { HOME: home } = process.env;");
    expect(codeEnvNames(f.root, { entries: ['entry.mjs'], env: f.env }).names).toEqual(['CI', 'GH_OTHER', 'HOME', 'WE_CUSTOM']);
    put(f.root, pin.file, `call(\n${pin.exactLineText}\n);`);
    const audited = codeEnvNames(f.root, { entries: [pin.file], env: f.env }); expect(audited.auditedReads).toEqual([pin]);
    expect(audited.names).not.toContain(pin.name);
    put(f.root, pin.file, `call(\n ${pin.exactLineText}\n);`);
    expect(codeEnvNames(f.root, { entries: [pin.file], env: f.env }).names).toContain(pin.name);
  });
  function cliWithOpenStdin(input) {
    const cli = join(RUNNING_ROOT, 'scripts/lib/daemon-rebuild/shared-smoke-key.mjs');
    return new Promise((resolveResult, reject) => {
      let stdinError;
      const child = execFile(process.execPath, [cli, '--print-key', '--env-json=-', '--json'], {
        env: process.env, encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024,
      }, (error, stdout, stderr) => resolveResult({
        error, stdout, stderr, stdinError, stdinEnded: child.stdin.writableEnded, signal: child.signalCode,
      }));
      child.once('error', reject);
      child.stdin.once('error', error => { stdinError = error; });
      // Deliberately leave the pipe open: neither guard may depend on EOF.
      child.stdin.write(input);
    });
  }
  function expectStdinRefusal(result, reason) {
    expect(result.error?.code, result.stderr).toBe(1);
    expect(result.error?.killed).toBe(false);
    expect(result.signal).toBeNull();
    expect(result.stdinEnded).toBe(false);
    expect(result.stdinError?.code === undefined || result.stdinError.code === 'EPIPE').toBe(true);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`smoke-shared-key: cli:${reason}; sharing off, use per-clone smoke`);
  }
  it('the CLI rejects stdin above 1 MiB before EOF', async () => {
    const input = JSON.stringify({ WE_INPUT: 'x'.repeat(1024 * 1024) });
    expect(Buffer.byteLength(input)).toBeGreaterThan(1024 * 1024);
    expectStdinRefusal(await cliWithOpenStdin(input), 'env-json-input-too-large');
  }, 20_000);
  it('the CLI terminates at its stdin deadline while the input pipe remains open', async () => {
    expectStdinRefusal(await cliWithOpenStdin('{}'), 'env-json-timeout');
  }, 20_000);
  it('the read-only CLI prints a non-null key and confirms an existing worktree, refusing malformed env JSON', () => {
    const f = harnessFixture(); const cli = f.cli;
    const run = args => spawnSync(process.execPath, [cli, '--print-key', `--clone=${f.root}`, `--sha=${f.sha}`, '--env-json=-', '--json', ...args], {
      cwd: f.base, env: f.env, input: JSON.stringify(f.env), encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    const a = run([]); expect(a.status, a.stderr).toBe(0); expect(JSON.parse(a.stdout).key).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(a.stdout)).toEqual(identity(f, { checks: SMOKE_CHECKS }));
    expect(existsSync(f.predictedCandidatePath)).toBe(false);
    ok(f.root, ['worktree', 'add', '--detach', f.predictedCandidatePath, f.sha]);
    const b = run([`--confirm-candidate=${f.predictedCandidatePath}`]); expect(b.status, b.stderr).toBe(0); expect(JSON.parse(b.stdout).key).toBe(JSON.parse(a.stdout).key);
    expect(ok(f.root, ['status', '--porcelain'])).toBe('');
    expect(ok(f.predictedCandidatePath, ['rev-parse', 'HEAD'])).toBe(f.sha);
    const bad = spawnSync(process.execPath, [cli, '--print-key', `--clone=${f.root}`, '--env-json=-'], {
      cwd: f.base, env: f.env, input: '[invalid', encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    }); expect(bad.status).not.toBe(0); expect(bad.stderr).toMatch(/smoke-shared-key/);
  });
});
