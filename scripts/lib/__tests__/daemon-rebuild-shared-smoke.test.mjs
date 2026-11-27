// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { checkoutState, sharedRunEnv, sharedSmokeIdentity, readSharedPass, publishSharedPass,
  sharedSmoke, SHARED_SMOKE_ENV_DELETED, SHARED_SMOKE_ENV_PINNED, SHARED_SMOKE_ENV_LOCATION,
  SHARED_SMOKE_ENV_CREDENTIAL, SHARED_SMOKE_FS_EXCLUDED, SHARED_SMOKE_IGNORED_STATE,
} from '../daemon-rebuild/shared-smoke.mjs';

const sha = 'a'.repeat(40), tree = 'b'.repeat(40), harnessTree = 'c'.repeat(40);
const hash = value => createHash('sha256').update(value).digest('hex');
const pass = () => ({ verdict: 'pass', smoke: { results: [
  { name: 'reconcile-dry-run', ok: true }, { name: 'dispatch-dry-run', ok: true },
  { name: 'env', ok: true },
] } });
// S2 supplies the complete local-write predicate; this fixture's full table has three rows.
const canPublish = r => r?.verdict === 'pass' && !r.cached && !r.disabled
  && r.smoke.results.length === 3 && r.smoke.results.every(x => x.ok && !x.skipped && !x.skipReason);
const settings = Object.freeze({ enabled: true, passTtlMs: 7200000, followerMaxWaitMs: 1500000,
  followerPollMs: 5000, ownRunMinMs: 1200000, leaderHeartbeatMs: 30000, leaderStaleMs: 180000 });
let base, f;
const write = (p, bytes = 'fixture') => { fs.mkdirSync(dirname(p), { recursive: true }); fs.writeFileSync(p, bytes); return p; };
const denied = () => Object.assign(new Error('fixture EACCES'), { code: 'EACCES' });
function ioFault(method, predicate, error = denied()) {
  return { ...fs, [method]: (...args) => { if (predicate(...args)) throw error; return fs[method](...args); } };
}
function fixture() {
  const root = join(base, 'clone'), candidatePath = join(base, 'candidate'), runningRoot = join(base, 'harness');
  const bins = join(base, 'bin'), deps = join(root, 'node_modules'), operator = join(base, 'operator.json');
  const platform = join(base, 'platform.json'), executable = write(join(base, 'runtime'), 'native node bytes');
  const repos = new Map();
  for (const p of [root, candidatePath, runningRoot]) {
    fs.mkdirSync(join(p, '.git'), { recursive: true });
    fs.mkdirSync(join(p, 'scripts/settings'), { recursive: true });
    repos.set(p, { tree: p === runningRoot ? harnessTree : tree, diff: '', untracked: '', ignored: '', status: '' });
  }
  write(join(deps, 'package/a.js'), 'export const a = 1;');
  write(join(deps, 'package/b.js'), 'export const b = 2;');
  fs.symlinkSync(deps, join(candidatePath, 'node_modules'));
  for (const name of ['node', 'git', 'gh']) fs.chmodSync(write(join(bins, name), `native ${name}`), 0o755);
  let time = Date.parse('2026-11-27T12:00:00.000Z');
  const now = () => time, advance = n => { time += n; };
  const env = { PATH: bins, WE_DAEMON_MANAGED_CLONE: '1', WE_SMOKE_LIVE_CLONE: root,
    LANE_POOL_ROOT: join(base, 'pool'), WE_GITHUB_APP_ROLE: 'worker', SAMPLE_SECRET: 'fixture-private-secret-value' };
  fs.mkdirSync(env.LANE_POOL_ROOT);
  const git = vi.fn((args, opts) => {
    expect(opts?.env).toEqual(expect.objectContaining({ PATH: expect.any(String) }));
    const at = args[0] === '-C' ? args[1] : root, a = args[0] === '-C' ? args.slice(2) : args;
    const repo = repos.get(at);
    if (!repo) throw new Error(`unexpected fixture git root: ${at}`);
    let stdout;
    if (a[0] === 'rev-parse' && a.at(-1).endsWith('^{tree}')) stdout = repo.tree + '\n';
    else if (a[0] === 'diff') stdout = repo.diff;
    else if (a[0] === 'status') stdout = repo.status;
    else if (a[0] === 'ls-files') stdout = a.includes('--ignored') ? repo.ignored : repo.untracked;
    else if (a.join(' ') === '--version') stdout = 'git version fixture';
    else throw new Error(`unexpected fixture git argv: ${a.join(' ')}`);
    return { status: 0, stdout };
  });
  const alerts = [], logs = [];
  const alert = (name, detail) => alerts.push({ name, ...detail });
  const options = { git, sha, root, candidatePath, runningRoot, runEnv: sharedRunEnv(env), now,
    operatorOverrides: () => operator, operatorPreferences: () => platform, nodeVersion: 'v22.fixture', execPath: executable,
    findCheckout: p => [...repos.keys()].find(dir => p.startsWith(dir + '/')),
    log: line => logs.push(line) };
  const key = extra => sharedSmokeIdentity({ ...options, runEnv: sharedRunEnv(env), ...extra });
  const stateDir = join(base, 'state');
  const treeOf = value => { expect(value).toBe(sha); return tree; };
  const common = { stateDir, now, treeOf, alert, host: 'fixture-host', pid: 123, stateKey: 'fixture-daemon' };
  const store = extra => ({ ...common, identity: key(), reuseHours: 12, passTtlMs: settings.passTtlMs, ...extra });
  const run = vi.fn(async () => pass());
  const smoke = extra => sharedSmoke({ ...common, env, root, identity: () => key(), run, canPublish, settings,
    reuseEnabled: true, gateEnabled: true, changedFiles: null, reuseHours: 12,
    deadline: now() + 3000000, sleep: async ms => advance(ms), pidAlive: () => true,
    log: line => logs.push(line), ...extra });
  return { ...options, root, candidatePath, runningRoot, bins, deps, operator, platform, repos, env,
    key, stateDir, now, advance, alerts, logs, store, smoke, run, common };
}
beforeEach(() => { base = fs.mkdtempSync(join(tmpdir(), 'shared-smoke-')); f = fixture(); });
afterEach(() => { vi.useRealTimers(); fs.rmSync(base, { recursive: true, force: true }); });
function different(before, after) {
  expect(before?.key).toMatch(/^[a-f0-9]{64}$/);
  expect(after?.key).toMatch(/^[a-f0-9]{64}$/);
  expect(after.key).not.toBe(before.key);
}
function equal(before, after) {
  expect(before?.key).toMatch(/^[a-f0-9]{64}$/);
  expect(after?.key).toMatch(/^[a-f0-9]{64}$/);
  expect(after.key).toBe(before.key);
}
function snapshot() {
  const dir = join(base, '.snapshots/code', 'd'.repeat(40));
  write(join(dir, '.snapshot-complete'), 'time one');
  write(join(dir, 'scripts/settings/smoke.json'), '{}');
  write(join(dir, 'entry.mjs'), 'export const a = 1');
  fs.symlinkSync(f.deps, join(dir, 'node_modules'));
  f.runningRoot = dir;
  return dir;
}
function shim({ moduleRoot = f.runningRoot, missing, escaped = false } = {}) {
  const native = write(join(base, 'real-gh'), 'native gh implementation');
  const lines = ['#!/usr/bin/env node', '// AUTO-GENERATED by renderGhShimScript'];
  for (const [name, p] of Object.entries({ REAL_GH: native, GH_THROTTLE_CLI: join(moduleRoot, escaped ? 'space " quote.mjs' : 'one.mjs'),
    REAL_GH_THROTTLE_CLI: join(moduleRoot, 'two.mjs'), APP_REFRESH_CLI: join(moduleRoot, 'three.mjs'), CACHE_PATH: join(base, 'cache') })) {
    if (name === missing) continue;
    if (name.endsWith('_CLI')) write(p, `// ${name}`);
    lines.push(`const ${name} = ${JSON.stringify(p)};`);
  }
  fs.chmodSync(write(join(f.bins, 'gh'), lines.join('\n')), 0o755);
  return { native, lines };
}

describe('K1: every included input is sensitive', () => {
  it('uses the defined versioned tuple and digest-only components', () => {
    const id = f.key();
    expect(id?.key).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(id.components)).toEqual(['tree', 'harness', 'nodeModules', 'env', 'files', 'runtime']);
    for (const v of Object.values(id.components)) expect(v).toMatch(/^[a-f0-9]{64}$/);
    expect(id.key).toBe(hash(JSON.stringify(['smoke-shared/1', id.tree, ...Object.values(id.components).slice(1)])));
  });
  it.each(['candidate tree', 'harness tree', 'dependency byte', 'dependency link', 'exec mode', 'dirty diff',
    'untracked file', 'untracked mode', 'candidate settings', 'harness settings', 'non-JSON setting', 'override create', 'override change',
    'platform', 'node version', 'exec bytes', 'git version', 'node binary', 'git binary', 'gh binary', 'first gh', 'env file contents',
    'shim checkout diff', 'shim untracked file', 'shim dependency', 'shim bytes', 'native shim target'])('%s changes a non-null key', kind => {
    let extra = {}, mutate;
    if (kind.startsWith('shim') || kind === 'native shim target') {
      const other = join(base, 'shim-checkout');
      fs.mkdirSync(join(other, '.git'), { recursive: true });
      f.repos.set(other, { tree: harnessTree, diff: '', untracked: '', ignored: '', status: '' });
      const s = shim({ moduleRoot: other });
      mutate = kind === 'shim checkout diff' ? () => { f.repos.get(other).diff = 'changed imported module'; }
        : kind === 'shim untracked file' ? () => { write(join(other, 'new.mjs'), 'new'); f.repos.get(other).untracked = 'new.mjs\0'; }
        : kind === 'shim dependency' ? () => write(join(other, 'node_modules/x.js'), 'changed')
        : kind === 'shim bytes' ? () => fs.appendFileSync(join(f.bins, 'gh'), '\n// changed') : () => write(s.native, 'new native gh');
    } else if (kind === 'candidate tree') mutate = () => { f.repos.get(f.root).tree = f.repos.get(f.candidatePath).tree = 'e'.repeat(40); };
    else if (kind === 'harness tree') mutate = () => { f.repos.get(f.runningRoot).tree = 'e'.repeat(40); };
    else if (kind === 'dependency byte') mutate = () => write(join(f.deps, 'package/a.js'), 'changed');
    else if (kind === 'dependency link') {
      fs.symlinkSync('package/a.js', join(f.deps, 'link'));
      mutate = () => { fs.unlinkSync(join(f.deps, 'link')); fs.symlinkSync('package/b.js', join(f.deps, 'link')); };
    } else if (kind === 'exec mode') mutate = () => fs.chmodSync(join(f.deps, 'package/a.js'), 0o755);
    else if (kind === 'dirty diff') mutate = () => { f.repos.get(f.runningRoot).diff = 'binary diff fixture'; };
    else if (kind.startsWith('untracked')) {
      write(join(f.runningRoot, 'untracked.mjs'), 'untracked');
      if (kind === 'untracked mode') f.repos.get(f.runningRoot).untracked = 'untracked.mjs\0';
      mutate = kind === 'untracked mode' ? () => fs.chmodSync(join(f.runningRoot, 'untracked.mjs'), 0o755)
        : () => { f.repos.get(f.runningRoot).untracked = 'untracked.mjs\0'; };
    } else if (kind.endsWith('setting') || kind.endsWith('settings')) mutate = () => write(join(
      kind === 'candidate settings' ? f.candidatePath : f.runningRoot, 'scripts/settings', kind === 'non-JSON setting' ? 'other.txt' : 'smoke.json'), 'changed');
    else if (kind.startsWith('override')) {
      if (kind === 'override change') write(f.operator, 'before');
      mutate = () => write(f.operator, 'after');
    } else if (kind === 'platform') mutate = () => write(f.platform, '{}');
    else if (kind === 'node version') mutate = () => { extra = { nodeVersion: 'v23.fixture' }; };
    else if (kind === 'exec bytes') mutate = () => write(f.execPath, 'other executable');
    else if (kind === 'git version') mutate = () => f.git.mockImplementation((args, opts) => args.at(-1) === '--version'
      ? { status: 0, stdout: 'git other version' } : originalGit(args, opts));
    else if (kind.endsWith('binary')) mutate = () => write(join(f.bins, kind.split(' ')[0]), 'changed binary');
    else if (kind === 'first gh') mutate = () => {
      const bin = join(base, 'first'); fs.chmodSync(write(join(bin, 'gh'), 'different gh'), 0o755); f.env.PATH = bin + ':' + f.bins;
    };
    else if (kind === 'env file contents') { f.env.KEY_FILE = write(join(base, 'key.pem'), 'secret one'); mutate = () => write(f.env.KEY_FILE, 'secret two'); }
    const originalGit = f.git.getMockImplementation();
    const before = f.key(); mutate(); different(before, f.key(extra));
  });
  it.each(['TMPDIR', 'XDG_CONFIG_HOME', 'WE_GH_AUTH_INSTALLATION', 'GH_ENTERPRISE_TOKEN', 'WE_GITHUB_APP_ROLE', 'ARBITRARY',
    'GH_TOKEN', 'GITHUB_TOKEN'])('add/change/remove %s binds the full value', name => {
    delete f.env[name]; const absent = f.key(); f.env[name] = 'value-one'; const one = f.key();
    f.env[name] = 'value-two'; const two = f.key(); delete f.env[name];
    different(absent, one); different(one, two); equal(absent, f.key());
  });
});

describe('K2: exclusions are enforced on the child', () => {
  it('exports exact deeply frozen constants and builds a fresh child env', () => {
    expect(SHARED_SMOKE_ENV_DELETED).toEqual(['WE_DAEMON_CLONE_LOCK_IGNORE_OWNERS', 'WE_DAEMON_REBUILD_READER']);
    expect(SHARED_SMOKE_ENV_PINNED).toEqual({ WE_GH_DAEMON_CALLER: 'rebuild-smoke', XPC_SERVICE_NAME: 'com.we.rebuild-smoke' });
    expect(SHARED_SMOKE_ENV_LOCATION).toEqual(['WE_SMOKE_LIVE_CLONE']);
    expect(SHARED_SMOKE_ENV_CREDENTIAL).toEqual(['GH_TOKEN']);
    expect(SHARED_SMOKE_FS_EXCLUDED).toEqual(['.vite']);
    expect(SHARED_SMOKE_IGNORED_STATE).toEqual(['.conveyor', '.operations', 'node_modules']);
    for (const c of [SHARED_SMOKE_ENV_DELETED, SHARED_SMOKE_ENV_PINNED, SHARED_SMOKE_ENV_LOCATION,
      SHARED_SMOKE_ENV_CREDENTIAL, SHARED_SMOKE_FS_EXCLUDED, SHARED_SMOKE_IGNORED_STATE]) expect(Object.isFrozen(c)).toBe(true);
    const source = { ...f.env, WE_DAEMON_CLONE_LOCK_IGNORE_OWNERS: 'owners', WE_DAEMON_REBUILD_READER: 'reader' };
    const child = sharedRunEnv(source);
    expect(child).not.toBe(source); expect(source.WE_DAEMON_REBUILD_READER).toBe('reader');
    expect(child).not.toHaveProperty('WE_DAEMON_REBUILD_READER'); expect(child).not.toHaveProperty('WE_DAEMON_CLONE_LOCK_IGNORE_OWNERS');
    expect(child).toMatchObject({ ...SHARED_SMOKE_ENV_PINNED, WE_SMOKE_LIVE_CLONE: f.root });
  });
  it.each(['WE_DAEMON_CLONE_LOCK_IGNORE_OWNERS', 'WE_DAEMON_REBUILD_READER', 'WE_GH_DAEMON_CALLER', 'XPC_SERVICE_NAME'])('%s is transformed before hashing', name => {
    const before = f.key(); f.env[name] = 'different-per-launch-value'; equal(before, f.key());
  });
  it('rejects a child live-clone reference to a different checkout even with the same tree', () => {
    expect(f.key()?.key).toMatch(/^[a-f0-9]{64}$/);
    f.env.WE_SMOKE_LIVE_CLONE = f.candidatePath;
    expect(f.key()).toBeNull();
    expect(f.logs.at(-1)).toContain('live-clone-mismatch: run full smoke; use the verified root');
  });
  it.each(['missing', 'relative', 'unreadable'])('rejects a %s child live-clone reference', kind => {
    if (kind === 'missing') delete f.env.WE_SMOKE_LIVE_CLONE;
    else f.env.WE_SMOKE_LIVE_CLONE = kind === 'relative' ? 'clone' : join(base, 'absent');
    expect(f.key()).toBeNull();
    expect(f.logs.at(-1)).toContain('smoke-shared-off');
  });
  it('omits the child live-clone location only after resolving it to the verified root', () => {
    const before = f.key(), alias = join(base, 'clone-alias');
    fs.symlinkSync(f.root, alias);
    f.env.WE_SMOKE_LIVE_CLONE = alias;
    equal(before, f.key());
  });
  it('excludes only top-level dependency .vite, retaining .cache and nested .vite', () => {
    const before = f.key(); write(join(f.deps, '.vite/vitest/results.json'), 'cache'); equal(before, f.key());
    write(join(f.deps, '.cache/a'), 'cache'); const after = f.key(); different(before, after);
    write(join(f.deps, 'package/.vite/a'), 'nested'); different(after, f.key());
  });
  it('binds a second dependency root while de-duplicating identical realpaths', () => {
    fs.symlinkSync(f.deps, join(f.runningRoot, 'node_modules')); const before = f.key();
    fs.unlinkSync(join(f.runningRoot, 'node_modules')); write(join(f.runningRoot, 'node_modules/a'), 'other');
    different(before, f.key());
  });
  it('hashes absent dependencies and verifies the candidate ignored symlink', () => {
    f.repos.get(f.candidatePath).status = '!! node_modules\0'; expect(f.key()?.key).toMatch(/^[a-f0-9]{64}$/);
    fs.unlinkSync(join(f.candidatePath, 'node_modules')); fs.rmSync(f.deps, { recursive: true });
    f.repos.get(f.candidatePath).status = ''; expect(f.key()?.key).toMatch(/^[a-f0-9]{64}$/);
  });
  it('ignores a later gh binary and preserves byte ordering independent of env insertion order', () => {
    const before = f.key(), later = join(base, 'later'); fs.chmodSync(write(join(later, 'gh'), 'later'), 0o755);
    f.env.PATH += ':' + later; const withPath = f.key(); write(join(later, 'gh'), 'later changed'); equal(withPath, f.key());
    f.env.PATH = f.bins; equal(before, f.key({ runEnv: Object.fromEntries(Object.entries(sharedRunEnv(f.env)).reverse()) }));
  });
});

describe('K1b: immutable job snapshot shape with content-bound stores', () => {
  it.each(['file', 'store byte'])('%s changes a snapshot identity', kind => {
    const dir = snapshot(), before = f.key({ runningRoot: dir });
    write(kind === 'file' ? join(dir, 'entry.mjs') : join(f.deps, 'package/a.js'), 'changed');
    different(before, f.key({ runningRoot: dir }));
  });
  it('omits marker contents and store location', () => {
    const dir = snapshot(), before = f.key({ runningRoot: dir }); write(join(dir, '.snapshot-complete'), 'different timestamp');
    equal(before, f.key({ runningRoot: dir }));
    const store = join(base, 'another-store'); fs.cpSync(f.deps, store, { recursive: true });
    fs.unlinkSync(join(dir, 'node_modules')); fs.symlinkSync(store, join(dir, 'node_modules'));
    equal(before, f.key({ runningRoot: dir }));
  });
  it.each(['marker missing', 'unknown shape'])('refuses %s', kind => {
    const dir = snapshot(); if (kind === 'marker missing') fs.unlinkSync(join(dir, '.snapshot-complete'));
    else fs.renameSync(dir, join(base, 'unknown'));
    expect(f.key({ runningRoot: kind === 'unknown shape' ? join(base, 'unknown') : dir })).toBeNull();
    expect(f.logs.join('\n')).toContain('harness-unknown');
  });
  it('binds a shim-referenced snapshot including its imported siblings', () => {
    const dir = snapshot(); shim({ moduleRoot: dir }); const before = f.key();
    write(join(dir, 'sibling.mjs'), 'new import'); different(before, f.key());
  });
});

describe('K3/K6: unknown evidence never forms an identity', () => {
  it.each(['ignored dist', 'outside link', 'dangling link', 'excluded target', 'candidate dirty', 'candidate settings dirty',
    'candidate tree mismatch', 'candidate deps missing', 'candidate deps directory', 'candidate deps other store', 'unreadable dependency',
    'oversized env file', 'unreadable env file', 'unreadable overrides', 'unreadable platform', 'git failure', 'git timeout',
    'malformed git tree', 'malformed git list', 'unreadable ignored list', 'unbound module', 'missing shim target', 'unknown fs type', 'key timeout'])('refuses %s', kind => {
    let extra = {};
    if (kind === 'ignored dist') f.repos.get(f.runningRoot).ignored = 'dist/\0';
    else if (kind.endsWith('link') || kind === 'excluded target') {
      const target = kind === 'outside link' ? write(join(base, 'outside'), 'outside') : kind === 'dangling link' ? 'missing'
        : write(join(f.deps, '.vite/y'), 'cache'); fs.symlinkSync(target, join(f.deps, 'x'));
    } else if (kind.startsWith('candidate') && kind.endsWith('dirty')) f.repos.get(f.candidatePath).status =
      `?? ${kind.includes('settings') ? 'scripts/settings/new.json' : 'new-file'}\0`;
    else if (kind === 'candidate tree mismatch') f.repos.get(f.candidatePath).tree = 'e'.repeat(40);
    else if (kind.startsWith('candidate deps')) {
      fs.unlinkSync(join(f.candidatePath, 'node_modules'));
      if (kind.endsWith('directory')) fs.mkdirSync(join(f.candidatePath, 'node_modules'));
      if (kind.endsWith('store')) { const dir = join(base, 'wrong'); fs.mkdirSync(dir); fs.symlinkSync(dir, join(f.candidatePath, 'node_modules')); }
    } else if (kind === 'unreadable dependency') extra.fs = ioFault('readFileSync', p => p === join(f.deps, 'package/a.js'));
    else if (kind.includes('env file')) {
      f.env.FILE = write(join(base, 'large'), kind.startsWith('oversized') ? Buffer.alloc(4 * 1024 * 1024 + 1) : 'bytes');
      if (kind.startsWith('unreadable')) extra.fs = ioFault('readFileSync', p => p === f.env.FILE);
    } else if (kind === 'unreadable overrides' || kind === 'unreadable platform') extra.fs = ioFault('readFileSync', p => p === (kind.endsWith('overrides') ? f.operator : f.platform));
    else if (kind === 'git failure' || kind === 'git timeout') extra.git = () => ({ status: kind.endsWith('timeout') ? null : 1, stdout: tree, error: new Error('fixture') });
    else if (kind === 'malformed git tree') f.repos.get(f.runningRoot).tree = 'not-a-tree';
    else if (kind === 'malformed git list') f.repos.get(f.runningRoot).untracked = '../escape\0';
    else if (kind === 'unreadable ignored list') {
      const original = f.git.getMockImplementation(); extra.git = (args, opts) => args.includes('--ignored') ? { status: 1, stdout: '' } : original(args, opts);
    } else if (kind === 'unbound module') shim({ moduleRoot: join(base, 'deployment') });
    else if (kind === 'missing shim target') { shim(); fs.unlinkSync(join(f.runningRoot, 'one.mjs')); }
    else if (kind === 'unknown fs type') extra.fs = { ...fs, lstatSync: p => p === join(f.deps, 'package/a.js')
      ? { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false } : fs.lstatSync(p) };
    else if (kind === 'key timeout') extra.now = (() => { let n = 0; return () => f.now() + n++ * 120001; })();
    expect(f.key(extra)).toBeNull(); expect(f.logs.length).toBeGreaterThan(0);
  });
  it.each(['node', 'git', 'gh'])('rejects arbitrary shebang script for %s', name => {
    write(join(f.bins, name), '#!/bin/sh\nexit 0'); expect(f.key()).toBeNull(); expect(f.logs.join('\n')).toContain('runtime-script');
  });
  it.each(['', 'relative'])('rejects %j PATH entry', part => { f.env.PATH = part + ':' + f.bins; expect(f.key()).toBeNull(); });
  it('skips a non-executable match', () => {
    const first = join(base, 'nonexec'); write(join(first, 'gh'), '#!/bin/sh\nexit 0'); f.env.PATH = first + ':' + f.bins;
    expect(f.key()?.key).toMatch(/^[a-f0-9]{64}$/);
  });
  it('parses JSON-escaped shim paths', () => { shim({ escaped: true }); expect(f.key()?.key).toMatch(/^[a-f0-9]{64}$/); });
  it.each(['GH_THROTTLE_CLI', 'REAL_GH_THROTTLE_CLI', 'APP_REFRESH_CLI'])('requires shim constant %s', missing => {
    shim({ missing }); expect(f.key()).toBeNull(); expect(f.logs.join('\n')).toContain('runtime-shim-layout');
  });
  it('refuses malformed JSON shim literal', () => {
    const { lines } = shim(); write(join(f.bins, 'gh'), lines.join('\n').replace('one.mjs', 'one\\q.mjs'));
    expect(f.key()).toBeNull(); expect(f.logs.join('\n')).toContain('runtime-shim-layout');
  });
  it('binds checkoutState path only when requested', () => {
    const opts = { git: f.git, fs, runEnv: f.runEnv };
    const a = checkoutState(f.runningRoot, opts), b = checkoutState(f.runningRoot, { ...opts, withPath: true });
    expect(a).toBeTruthy(); expect(b).not.toEqual(a); expect(JSON.stringify(a)).not.toContain(f.runningRoot);
    expect(JSON.stringify(b)).toContain(f.runningRoot);
  });
});

describe('K4: role eligibility precedes identity and store IO', () => {
  it.each(['kill switch', 'disabled', 'reuse disabled', 'gate disabled', 'comparison', 'unproven changed files', 'unmanaged',
    'pool root', 'lane component', 'cross-field settings', 'missing settings', 'missing managed root'])('off: %s', async kind => {
    let extra = {};
    if (kind === 'kill switch') f.env.WE_REBUILD_SMOKE_SHARED = '0';
    if (kind === 'disabled') extra.settings = { ...settings, enabled: false };
    if (kind === 'reuse disabled') extra.reuseEnabled = false;
    if (kind === 'gate disabled') extra.gateEnabled = false;
    if (kind === 'comparison') extra.label = 'freshComparison';
    if (kind === 'unproven changed files') extra.changedFiles = [];
    if (kind === 'unmanaged') delete f.env.WE_DAEMON_MANAGED_CLONE;
    if (kind === 'pool root') extra.root = write(join(f.env.LANE_POOL_ROOT, 'managed/.keep')) && dirname(join(f.env.LANE_POOL_ROOT, 'managed/.keep'));
    if (kind === 'lane component') { extra.root = join(base, 'lane-3/managed'); fs.mkdirSync(extra.root, { recursive: true }); }
    if (kind === 'cross-field settings') extra.settings = { ...settings, leaderHeartbeatMs: 100000, leaderStaleMs: 180000 };
    if (kind === 'missing settings') extra.settings = undefined;
    if (kind === 'missing managed root') extra.root = join(base, 'missing');
    const identity = vi.fn(() => { throw new Error('must not compute identity'); });
    const outcome = await f.smoke({ ...extra, identity });
    expect(outcome.role).toBe('off'); expect(outcome.reason).toEqual(expect.any(String)); expect(identity).not.toHaveBeenCalled();
    expect(fs.existsSync(f.stateDir)).toBe(false); expect(f.alerts.some(x => x.name === 'smoke-shared-off')).toBe(true);
  });
  // Cascade fallback itself belongs to S2. S1 refuses unresolved invalid leaves, never guessing a value.
  it.each([['passTtlMs', -1], ['passTtlMs', 86400001], ['followerMaxWaitMs', -1], ['followerMaxWaitMs', 86400001],
    ['followerPollMs', 999], ['followerPollMs', 60001], ['ownRunMinMs', -1], ['ownRunMinMs', 3000001],
    ['leaderHeartbeatMs', 999], ['leaderHeartbeatMs', 300001], ['leaderStaleMs', 9999], ['leaderStaleMs', 3600001],
    ['enabled', 'true'], ['followerPollMs', 1000.5]])('invalid %s=%j disables sharing', async (key, value) => {
    const result = await f.smoke({ settings: { ...settings, [key]: value } }); expect(result).toMatchObject({ role: 'off', reason: 'settings-invalid' });
  });
});

describe('F1: durable pass-only store', () => {
  const publish = extra => publishSharedPass({ ...f.store(), result: pass(), canPublish, ...extra });
  const file = () => join(f.stateDir, 'smoke-shared', `${f.key().key}.pass.json`);
  it('round trips a digest-only record and uses the stricter TTL', () => {
    expect(publish()).toBe(true); const r = readSharedPass(f.store()); expect(r?.key).toBe(f.key().key);
    expect(Object.keys(r)).toEqual(['schema', 'key', 'sha', 'tree', 'passedAt', 'components', 'leader', 'timings']);
    const bytes = fs.readFileSync(file(), 'utf8');
    for (const value of [base, f.env.SAMPLE_SECRET, 'worker', 'native node bytes', 'export const a = 1;']) expect(bytes).not.toContain(value);
    f.advance(3600000); expect(readSharedPass(f.store({ reuseHours: 1 }))).toBeNull();
  });
  it.each(['json', 'schema', 'filename key', 'computed key', 'sha', 'tree', 'future', 'expired', 'invalid date', 'missing component', 'tmp only', 'git failure'])('misses %s', kind => {
    publish(); const path = file(), r = JSON.parse(fs.readFileSync(path, 'utf8')); let extra = {};
    if (kind === 'json') fs.writeFileSync(path, '{');
    else if (kind === 'tmp only') fs.renameSync(path, path + '.tmp');
    else {
      if (kind === 'schema') r.schema = 2;
      if (kind === 'filename key') r.key = 'f'.repeat(64);
      if (kind === 'computed key') extra.identity = { ...f.key(), key: 'e'.repeat(64) };
      if (kind === 'sha') r.sha = 'not sha';
      if (kind === 'tree') r.tree = 'f'.repeat(40);
      if (kind === 'future') r.passedAt = new Date(f.now() + 1).toISOString();
      if (kind === 'expired') r.passedAt = new Date(f.now() - settings.passTtlMs).toISOString();
      if (kind === 'invalid date') r.passedAt = 'invalid';
      if (kind === 'missing component') delete r.components.env;
      if (kind === 'git failure') extra.treeOf = () => { throw new Error('git failed'); };
      fs.writeFileSync(path, JSON.stringify(r));
    }
    expect(readSharedPass(f.store(extra))).toBeNull();
  });
  it.each(['failed', 'cached', 'disabled', 'skipped', 'incomplete', 'unauthorized'])('does not publish %s', kind => {
    const result = pass();
    if (kind === 'failed') result.verdict = 'code';
    if (kind === 'cached') result.cached = true;
    if (kind === 'disabled') result.disabled = true;
    if (kind === 'skipped') result.smoke.results[0].skipped = true;
    if (kind === 'incomplete') result.smoke.results.pop();
    expect(publish({ result, canPublish: kind === 'unauthorized' ? undefined : canPublish })).toBe(false);
    expect(fs.existsSync(file())).toBe(false);
  });
  it.each(['mkdirSync', 'renameSync', 'fsyncSync'])('reports %s failure, never exposing an incomplete file', method => {
    expect(publish({ fs: ioFault(method, () => true) })).toBe(false);
    expect(readSharedPass(f.store())).toBeNull(); expect(f.alerts.some(x => x.name === 'smoke-shared-store-error')).toBe(true);
  });
  it('fsyncs file before rename and directory after, pruning only aged recognized entries', () => {
    const order = [], spyFs = { ...fs, fsyncSync: fd => { order.push('sync'); fs.fsyncSync(fd); },
      renameSync: (...args) => { order.push('rename'); fs.renameSync(...args); } };
    expect(publish({ fs: spyFs })).toBe(true); expect(order).toEqual(['sync', 'rename', 'sync']);
    const dir = dirname(file()), oldPass = write(join(dir, 'e'.repeat(64) + '.pass.json'), '{}'), oldTmp = write(join(dir, '.old.tmp'), 'partial');
    const oldLock = join(dir, 'f'.repeat(64) + '.lock.stale-12345678'); fs.mkdirSync(oldLock);
    const keep = write(join(dir, 'operator.txt'), 'keep'), fresh = write(join(dir, '.fresh.tmp'), 'fresh');
    for (const p of [oldPass, oldTmp, oldLock, keep]) fs.utimesSync(p, 0, new Date(f.now() - 86400001));
    fs.utimesSync(fresh, 0, new Date(f.now())); publish();
    for (const p of [oldPass, oldTmp, oldLock]) expect(fs.existsSync(p)).toBe(false);
    expect(fs.existsSync(keep)).toBe(true); expect(fs.existsSync(fresh)).toBe(true);
  });
  it('preserves the previous pass bytes and mtime on a failed run', () => {
    publish(); const before = fs.readFileSync(file()), mtime = fs.statSync(file()).mtimeMs;
    expect(publish({ result: { verdict: 'code' } })).toBe(false);
    expect(fs.readFileSync(file())).toEqual(before); expect(fs.statSync(file()).mtimeMs).toBe(mtime);
  });
});

describe('F2: bounded single-flight with token ownership', () => {
  const lockPath = () => join(f.stateDir, 'smoke-shared', `${f.key().key}.lock`);
  function owner({ heartbeatAt = f.now(), host = 'fixture-host', pid = 456, token = 'other', ...rest } = {}) {
    write(join(lockPath(), 'owner.json'), JSON.stringify({ token, host, pid, stateKey: 'other-daemon', startedAt: f.now(), heartbeatAt, ...rest }));
  }
  it.each([true, false])('concurrent deferred leader pass=%s', async succeeds => {
    let finish, started;
    const began = new Promise(r => { started = r; }), result = new Promise(r => { finish = r; });
    const run = vi.fn(async () => { started(); return result; });
    const leader = f.smoke({ run }); await began;
    const follower = f.smoke({ run: f.run, sleep: async ms => { finish(succeeds ? pass() : { verdict: 'code' }); await leader; f.advance(ms); } });
    const [a, b] = await Promise.all([leader, follower]);
    expect(a.role).toBe('leader'); expect(b.role).toBe(succeeds ? 'follower' : 'leader');
    expect(b.hit).toBe(succeeds); expect(run.mock.calls.length + f.run.mock.calls.length).toBe(succeeds ? 1 : 2);
  });
  it.each(['dead pid', 'stale heartbeat', 'ownerless expired'])('reclaims %s', async kind => {
    if (kind === 'ownerless expired') { fs.mkdirSync(lockPath(), { recursive: true }); fs.utimesSync(lockPath(), 0, new Date(f.now() - 60000)); }
    else owner({ heartbeatAt: kind === 'stale heartbeat' ? f.now() - settings.leaderStaleMs : f.now() });
    const result = await f.smoke({ pidAlive: () => kind !== 'dead pid' });
    expect(result.role).toBe('leader'); expect(f.run).toHaveBeenCalledTimes(1); expect(fs.existsSync(lockPath())).toBe(false);
  });
  it.each(['live', 'ownerless young', 'malformed owner', 'unreadable owner', 'unknown pid'])('holds %s and runs own at bound', async kind => {
    if (kind === 'ownerless young') { fs.mkdirSync(lockPath(), { recursive: true }); fs.utimesSync(lockPath(), 0, new Date(f.now())); }
    else owner();
    if (kind === 'malformed owner') fs.writeFileSync(join(lockPath(), 'owner.json'), '{');
    const extra = kind === 'unreadable owner' ? { fs: ioFault('readFileSync', p => p === join(lockPath(), 'owner.json')) }
      : kind === 'unknown pid' ? { pidAlive: () => { throw denied(); } } : {};
    const result = await f.smoke({ ...extra, settings: { ...settings, followerMaxWaitMs: 10000 } });
    expect(result).toMatchObject({ role: 'own', waitedMs: 10000 }); expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.alerts.some(x => x.name === 'smoke-shared-wait-timeout')).toBe(true);
  });
  it('never renames prepared ownership over an existing empty lock', async () => {
    fs.mkdirSync(lockPath(), { recursive: true }); fs.utimesSync(lockPath(), 0, new Date(f.now())); const renamed = [];
    await f.smoke({ deadline: f.now() + settings.ownRunMinMs, fs: { ...fs,
      existsSync: p => p === lockPath() ? true : fs.existsSync(p), renameSync: (a, b) => { renamed.push(b); fs.renameSync(a, b); } } });
    expect(renamed).not.toContain(lockPath());
  });
  it('zero wait budget goes own without sleeping', async () => {
    owner(); const sleep = vi.fn(); const result = await f.smoke({ deadline: f.now() + settings.ownRunMinMs, sleep });
    expect(result).toMatchObject({ role: 'own', waitedMs: 0 }); expect(sleep).not.toHaveBeenCalled();
  });
  it('recomputes the whole identity at hit use after a wait', async () => {
    owner(); let slept = false;
    const result = await f.smoke({ sleep: async ms => {
      expect(slept).toBe(false); slept = true;
      publishSharedPass({ ...f.store(), result: pass(), canPublish });
      write(join(f.runningRoot, 'scripts/settings/changed.json'), '{}'); fs.rmSync(lockPath(), { recursive: true }); f.advance(ms);
    } });
    expect(result.hit).toBe(false); expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('never publishes post-run drift or failed identity', async () => {
    const run = async () => { write(join(f.deps, 'package/a.js'), 'drift'); return pass(); };
    const result = await f.smoke({ run }); expect(result.published).toBe(false);
    expect(f.alerts.some(x => x.name === 'smoke-shared-inputs-changed')).toBe(true);
    expect(readSharedPass(f.store())).toBeNull();
  });
  it('does not publish when recomputation becomes unreadable', async () => {
    await f.smoke({ run: async () => { f.repos.get(f.candidatePath).status = '?? surprise\0'; return pass(); } });
    expect(f.alerts.some(x => x.name === 'smoke-shared-inputs-changed')).toBe(true);
    expect(fs.readdirSync(join(f.stateDir, 'smoke-shared')).filter(x => x.endsWith('.pass.json'))).toEqual([]);
  });
  it('two own passes on one key leave one valid record', async () => {
    owner(); const options = { deadline: f.now() + settings.ownRunMinMs };
    const results = await Promise.all([f.smoke(options), f.smoke(options)]);
    expect(results.map(r => r.role)).toEqual(['own', 'own']); expect(readSharedPass(f.store())).not.toBeNull();
    expect(fs.readdirSync(join(f.stateDir, 'smoke-shared')).filter(x => x.endsWith('.pass.json'))).toHaveLength(1);
  });
  it('run throws release the lock without publishing', async () => {
    await expect(f.smoke({ run: async () => { throw new Error('smoke failed'); } })).rejects.toThrow('smoke failed');
    expect(fs.existsSync(lockPath())).toBe(false); expect(readSharedPass(f.store())).toBeNull();
  });
  it('heartbeats only while its token matches and release cannot delete a replacement owner', async () => {
    vi.useFakeTimers();
    await f.smoke({ run: async () => {
      const path = join(lockPath(), 'owner.json'), initial = JSON.parse(fs.readFileSync(path));
      f.advance(30000); await vi.advanceTimersByTimeAsync(30000);
      expect(JSON.parse(fs.readFileSync(path)).heartbeatAt).toBe(f.now());
      owner({ token: 'replacement' }); const bytes = fs.readFileSync(path);
      await vi.advanceTimersByTimeAsync(30000); expect(fs.readFileSync(path)).toEqual(bytes);
      expect(initial.token).not.toBe('replacement'); return pass();
    } });
    expect(JSON.parse(fs.readFileSync(join(lockPath(), 'owner.json'))).token).toBe('replacement');
    expect(readSharedPass(f.store())).not.toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });
  it('a replacement-owner reclaim race loses no complete result', async () => {
    owner({ heartbeatAt: f.now() - settings.leaderStaleMs }); let replaced = false;
    const injected = { ...fs, renameSync: (a, b) => {
      if (a === lockPath() && b.includes('.stale-')) { owner({ token: 'B' }); replaced = true; }
      fs.renameSync(a, b);
    } };
    const result = await f.smoke({ fs: injected }); expect(replaced).toBe(true); expect(result.role).toBe('leader');
    expect(publishSharedPass({ ...f.store(), result: pass(), canPublish })).toBe(true);
    expect(readSharedPass(f.store())).not.toBeNull();
  });
  it('store failure preserves the smoke result and emits an actionable reason', async () => {
    const result = await f.smoke({ fs: ioFault('mkdirSync', p => p.includes('smoke-shared')) });
    expect(result.result).toEqual(pass()); expect(result.published).toBe(false);
    expect(f.alerts.some(x => x.name === 'smoke-shared-store-error')).toBe(true);
  });
});
