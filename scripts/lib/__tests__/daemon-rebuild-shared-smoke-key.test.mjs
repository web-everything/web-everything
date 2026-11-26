/** S1.1 identity contract. @repo-scanning-test scope=files */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  RUNNING_ROOT, SUITE_ENTRIES, SUITE_JSON_RUNTIME_NAMES, COMPUTED_LOADS, K6_AUDITED_READS,
  PER_LAUNCH_ENV, smokeIdentityComponents, suiteManifest, smokeSuiteHash,
  effectiveEnvEntries, effectiveEnvHash, preSlotOwnershipOk, confirmCandidateOwnership,
  codeEnvNames, sharedSmokeIdentity, sharedDerivedKey,
} from '../daemon-rebuild/shared-smoke-key.mjs';
import { SMOKE_CHECKS, SMOKE_BUDGET_ENV } from '../daemon-live-smoke.mjs';
import { REBUILD_SMOKE_BUDGET_ENV } from '../daemon-rebuild/smoke.mjs';
import { scanScope, scanRoot } from '../repo-scan-tests.mjs';

const dirs = [];
const hash = value => createHash('sha256').update(value).digest('hex');
const checks = [{ name: 'code', kind: 'code', mayBeTransient: false, codeEntries: ['entry.mjs'] }];
function temp() { const p = mkdtempSync(join(tmpdir(), 'shared-smoke-key-')); dirs.push(p); return p; }
function put(root, file, text = '') {
  const path = join(root, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); return path;
}
function git(root, args) {
  return spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', ...args], {
    cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
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
  const env = { PATH: process.env.PATH, HOME: base, LANE_POOL_ROOT: pool,
    WE_PLATFORM_PREFERENCES_FILE: join(base, 'operator.json'), WE_DAEMON_SMOKE_STATE_DIR: state, WE_DAEMON_STATE_DIR: state,
    WE_DISPATCH_CWD_ROOT: join(base, 'dispatch') };
  ok(root, ['add', '.']); ok(root, ['commit', '-qm', 'fixture']);
  const predictedCandidatePath = join(state, 'clone.candidate-first');
  return { root, base, env, predictedCandidatePath, sha: ok(root, ['rev-parse', 'HEAD']),
    suite: { root, env, checks }, git: args => git(root, args) };
}
function identity(f, extra = {}) {
  return sharedSmokeIdentity({ root: f.root, sha: f.sha, env: f.env,
    predictedCandidatePath: f.predictedCandidatePath, suiteRoot: f.root, checks, ...extra });
}
afterEach(() => { for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true }); });

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
  it('K2a: locates the running root and covers the real harness closure', () => {
    expect(RUNNING_ROOT).toBe(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
    const f = fixture(); const root = scanRoot(RUNNING_ROOT); const scope = scanScope();
    // Changed-file runs still validate the closure, but only assert inventory members in their scope.
    const manifest = suiteManifest({ root, env: f.env }); expect(manifest).not.toBeNull();
    const paths = manifest.map(([p]) => p);
    const entries = [...SUITE_ENTRIES, ...SMOKE_CHECKS.flatMap(check => check.codeEntries ?? [])];
    const tracked = spawnSync('git', ['ls-files', '-z', '--', ...entries], {
      cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
    });
    expect(tracked.error, 'smoke entry inventory must be readable').toBeUndefined();
    expect(tracked.status, tracked.stderr).toBe(0);
    const trackedEntries = new Set(tracked.stdout.split('\0').filter(Boolean));
    for (const entry of entries.filter(path => !scope || scope.has(path))) {
      expect(trackedEntries.has(entry), `${entry} must be tracked`).toBe(true);
      expect(paths, `${entry} must be hashed`).toContain(entry);
    }
    for (const path of ['scripts/lib/github-app-auth-env.mjs', 'scripts/lib/resource-admission.mjs',
      'scripts/conveyor/pr-snapshot.mjs', 'scripts/lib/gh-throttle.mjs', 'scripts/lib/under-test.mjs', 'scripts/lib/under-test.cjs']) {
      if (!scope || scope.has(path)) expect(paths).toContain(path);
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
    const f = fixture(); const root = scanRoot(RUNNING_ROOT); const scope = scanScope();
    if (scope && !scope.has('scripts/lane-pool.mjs')) return;
    const result = codeEnvNames(root, { entries: ['scripts/lane-pool.mjs'], env: f.env }); expect(result).not.toBeNull();
    expect(result.reads.filter(r => r.name === 'WE_SMOKE_LIVE_CLONE').map(r => r.file)).toEqual(['scripts/lane-pool.mjs']);
  });
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
    const f = fixture(); const cli = join(RUNNING_ROOT, 'scripts/lib/daemon-rebuild/shared-smoke-key.mjs');
    const run = args => spawnSync(process.execPath, [cli, '--print-key', `--clone=${f.root}`, `--sha=${f.sha}`, '--env-json=-', '--json', ...args], {
      env: process.env, input: JSON.stringify(f.env), encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    const a = run([]); expect(a.status, a.stderr).toBe(0); expect(JSON.parse(a.stdout).key).toMatch(/^[a-f0-9]{64}$/);
    ok(f.root, ['worktree', 'add', '--detach', f.predictedCandidatePath, f.sha]);
    const b = run([`--confirm-candidate=${f.predictedCandidatePath}`]); expect(b.status, b.stderr).toBe(0); expect(JSON.parse(b.stdout).key).toBe(JSON.parse(a.stdout).key);
    const bad = spawnSync(process.execPath, [cli, '--print-key', `--clone=${f.root}`, '--env-json=-'], {
      input: '[invalid', encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    }); expect(bad.status).not.toBe(0); expect(bad.stderr).toMatch(/smoke-shared-key/);
  });
});
