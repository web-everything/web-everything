/**
 * @file scripts/lib/__tests__/daemon-deps-job.test.mjs
 * @description x0m7a8x (card 5691) — a daemon clone's `npm ci` runs as a detached install job and the new
 *   `node_modules` is swapped in at a pass boundary; the loop side never installs. Real temp dirs and a real job
 *   store; the runtime's reattach pass and the installer are injected (no npm, no detached child).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import {
  nativeBuilt, refreshDepsAsJob, resolveDepsAsJob, installStep, swapNodeModules, depsStore, runDepsJob,
  DEPS_JOB_KIND, DEPS_JOB_KINDS, DEPS_AS_JOB_ENV, DEPS_JOB_NPM_ARGS, depsJobInstaller,
  pnpmAwareInstaller, DEPS_MARKER_FILE,
} from '../daemon-rebuild/deps-job.mjs';
import {
  lockHash, markerMatches, ensureStoreGeneration, readStoreGeneration,
} from '../lane-deps-installer.mjs';
import {
  createJobStore, enqueueJob, JOB_ID_ENV, JOB_ATTEMPT_ENV,
} from '../daemon-jobs-runtime.mjs';
import { defineJobKind, markFailed, markLaunching } from '../daemon-jobs.mjs';
import { lockfileKey, ensureNodeModulesStore, storeStillValid } from '../daemon-job-snapshots.mjs';

const tmp = [];
const mk = (p) => { const d = mkdtempSync(join(tmpdir(), p)); tmp.push(d); return d; };
afterEach(() => { vi.unstubAllEnvs(); while (tmp.length) rmSync(tmp.pop(), { recursive: true, force: true }); });

const SHA = 'a'.repeat(40);
function fixture({ lock = '{"lockfileVersion":3,"v":2}' } = {}) {
  const root = mk('deps-root-');
  writeFileSync(join(root, 'package-lock.json'), lock);
  writeFileSync(join(root, 'package.json'), '{"name":"x"}');
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'old.txt'), 'old');
  const jobs = mk('deps-jobs-');
  let installedKey = lockfileKey('{"lockfileVersion":3,"v":1}');
  const installed = { read: () => installedKey, write: vi.fn((k) => { installedKey = k; }) };
  const store = createJobStore(jobs);
  return { root, jobs, store, installed, key: lockfileKey(lock), lock };
}
const noReattach = vi.fn(async () => ({ actions: [] }));

describe('pnpmAwareInstaller — snapshot dependency backend', () => {
  function setup(initialised = true) {
    const sourceRoot = mk('deps-pnpm-source-');
    const into = mk('deps-pnpm-snapshot-');
    const storeDir = join(mk('deps-pnpm-store-'), 'store');
    if (initialised) ensureStoreGeneration(storeDir);
    for (const dir of [sourceRoot, into]) {
      writeFileSync(join(dir, 'package.json'), '{"name":"snapshot","version":"1.0.0"}');
      writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3}');
    }
    writeFileSync(join(sourceRoot, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');
    writeFileSync(join(sourceRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
    const legacy = vi.fn();
    const log = vi.fn();
    const which = vi.fn(() => 'pnpm');
    const parity = vi.fn(() => true);
    const exec = vi.fn((cmd, args, opts) => {
      if (args[0] === '--version') return '12.1.0';
      expect(cmd).toBe('pnpm');
      expect(opts.cwd).toBe(into);
      expect(readStoreGeneration(storeDir)).not.toBeNull();
      mkdirSync(join(into, 'node_modules'), { recursive: true });
    });
    return { sourceRoot, into, storeDir, env: {}, legacy, log, which, parity, exec };
  }
  const installs = (f) => f.exec.mock.calls.filter(([, args]) => args[0] === 'install');
  const logged = (f, message) => f.log.mock.calls.some(([line]) => String(line).includes(message));
  function expectMarker(f, backend) {
    expect(DEPS_MARKER_FILE).toBe('.we-deps-marker');
    const marker = readFileSync(join(f.into, '.we-deps-marker'), 'utf8').trim();
    const hash = lockHash(f.into, backend, f.storeDir);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(marker).toBe(`${backend}:${hash}`);
    expect(markerMatches(marker, hash, backend)).toBe(true);
  }

  it('chooses usable pnpm, copies its inputs, and reads the lane-initialised store generation', () => {
    const f = setup();
    pnpmAwareInstaller(f)(f.into);
    expect(installs(f)).toEqual([['pnpm', ['install', '--frozen-lockfile', `--store-dir=${f.storeDir}`, '--ignore-scripts', '--ignore-pnpmfile'], expect.objectContaining({ cwd: f.into })]]);
    expect(f.which).toHaveBeenCalledWith('pnpm');
    expect(f.parity).toHaveBeenCalledTimes(1);
    expect(f.legacy).not.toHaveBeenCalled();
    for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      expect(readFileSync(join(f.into, name), 'utf8')).toBe(readFileSync(join(f.sourceRoot, name), 'utf8'));
    }
    expect(logged(f, 'backend=pnpm')).toBe(true);
    expectMarker(f, 'pnpm');
  });

  it.each(['no pnpm', 'parity false', 'version 11', 'no pnpm-lock', 'different npm lock'])('uses legacy once with backend=npm: %s', (reason) => {
    const f = setup();
    if (reason === 'no pnpm') f.which.mockReturnValue(null);
    if (reason === 'parity false') f.parity.mockReturnValue(false);
    if (reason === 'version 11') f.exec.mockReturnValue('11.9.0');
    if (reason === 'no pnpm-lock') rmSync(join(f.sourceRoot, 'pnpm-lock.yaml'));
    if (reason === 'different npm lock') writeFileSync(join(f.into, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}');
    pnpmAwareInstaller(f)(f.into);
    expect(f.legacy).toHaveBeenCalledTimes(1);
    expect(f.legacy).toHaveBeenCalledWith(f.into);
    expect(installs(f)).toEqual([]);
    expect(logged(f, 'backend=npm')).toBe(true);
    expectMarker(f, 'npm');
  });

  it.each([undefined, false])('always disables pnpm install scripts and pnpmfile hooks even with ignoreScripts=%s', (ignoreScripts) => {
    const f = setup();
    f.ignoreScripts = ignoreScripts;
    f.env = { npm_config_ignore_scripts: 'false', PNPM_CONFIG_IGNORE_SCRIPTS: 'false', npm_config_ignore_pnpmfile: 'false' };
    depsJobInstaller(f)(f.into);
    expect(installs(f)).toHaveLength(1);
    for (const [, args] of installs(f)) {
      expect(args).toEqual(['install', '--frozen-lockfile', `--store-dir=${f.storeDir}`, '--ignore-scripts', '--ignore-pnpmfile']);
    }
  });

  it('the pnpm argv carries --ignore-pnpmfile even when the copied workspace config names a pnpmfile', () => {
    const f = setup();
    // The copied workspace config names a pnpmfile by absolute path, as in the demonstrated break.
    const payload = join(f.sourceRoot, 'payload.cjs');
    writeFileSync(payload, 'throw new Error("pnpmfile executed")');
    writeFileSync(join(f.sourceRoot, 'pnpm-workspace.yaml'), `pnpmfile: ${payload}\n`);
    depsJobInstaller(f)(f.into);
    expect(readFileSync(join(f.into, 'pnpm-workspace.yaml'), 'utf8')).toContain('pnpmfile:');
    const [[, args]] = installs(f);
    expect(args).toContain('--ignore-pnpmfile');
  });

  it.each([false, true])('checks all installed allowBuilds packages after pnpm; native built=%s', (built) => {
    const f = setup();
    const policy = 'allowBuilds:\n  esbuild: true\n  "@parcel/watcher": true\n  sharp: true\n  blocked: false\n';
    writeFileSync(join(f.sourceRoot, 'pnpm-workspace.yaml'), policy);
    f.exec.mockImplementation((cmd, args) => {
      if (args[0] === '--version') return '12.1.0';
      for (const name of ['esbuild', '@parcel/watcher', 'blocked', 'ordinary']) {
        mkdirSync(join(f.into, 'node_modules', name), { recursive: true });
      }
      writeFileSync(join(f.into, 'node_modules', 'partial'), 'pnpm output');
    });
    f.nativeBuilt = vi.fn((into, names) => {
      expect(into).toBe(f.into);
      expect([...names].sort()).toEqual(['@parcel/watcher', 'esbuild']);
      expect(existsSync(join(into, 'node_modules', 'partial'))).toBe(true);
      return built;
    });
    f.legacy.mockImplementation((into) => {
      expect(existsSync(join(into, 'node_modules'))).toBe(false);
      mkdirSync(join(into, 'node_modules'));
      writeFileSync(join(into, 'node_modules', 'copied'), 'legacy output');
    });
    pnpmAwareInstaller(f)(f.into);
    expect(installs(f)).toHaveLength(1);
    expect(f.nativeBuilt).toHaveBeenCalledTimes(1);
    if (built) {
      expect(f.legacy).not.toHaveBeenCalled();
      expect(existsSync(join(f.into, 'node_modules', 'partial'))).toBe(true);
      expectMarker(f, 'pnpm');
    } else {
      expect(f.legacy).toHaveBeenCalledTimes(1);
      expect(f.legacy).toHaveBeenCalledWith(f.into);
      expect(existsSync(join(f.into, 'node_modules', 'partial'))).toBe(false);
      expect(readFileSync(join(f.into, 'node_modules', 'copied'), 'utf8')).toBe('legacy output');
      expect(f.log.mock.calls.some(([line]) =>
        ['native build missing', '@parcel/watcher', 'esbuild', 'backend=npm'].every((text) => String(line).includes(text)))).toBe(true);
      expectMarker(f, 'npm');
    }
  });

  it('accepts absent optional pnpm inputs without creating placeholder files', () => {
    const f = setup();
    rmSync(join(f.sourceRoot, 'pnpm-workspace.yaml'));
    pnpmAwareInstaller(f)(f.into);
    expect(installs(f)).toHaveLength(1);
    expect(existsSync(join(f.into, 'pnpm-workspace.yaml'))).toBe(false);
    expectMarker(f, 'pnpm');
  });

  it('uses legacy when the store generation is unreadable', () => {
    const f = setup(false);
    writeFileSync(f.storeDir, 'a file cannot be a store directory');
    pnpmAwareInstaller(f)(f.into);
    expect(installs(f)).toEqual([]);
    expect(f.legacy).toHaveBeenCalledTimes(1);
    expect(f.legacy).toHaveBeenCalledWith(f.into);
    expect(logged(f, 'backend=npm')).toBe(true);
    expectMarker(f, 'npm');
  });

  it.each(['absent store', 'missing generation', 'invalid generation'])('uses legacy without writing the shared store: %s', (reason) => {
    const f = setup(false);
    if (reason !== 'absent store') mkdirSync(f.storeDir);
    if (reason === 'invalid generation') writeFileSync(join(f.storeDir, '.we-lane-store-generation'), 'invalid');
    const before = reason === 'absent store' ? null : statSync(f.storeDir);
    pnpmAwareInstaller(f)(f.into);
    expect(installs(f)).toEqual([]);
    expect(f.legacy).toHaveBeenCalledTimes(1);
    expect(f.legacy).toHaveBeenCalledWith(f.into);
    expect(f.log).toHaveBeenCalledWith('pnpm store not initialised by a lane; using npm');
    expect(logged(f, 'backend=npm')).toBe(true);
    expectMarker(f, 'npm');
    if (before === null) expect(existsSync(f.storeDir)).toBe(false);
    else {
      expect(statSync(f.storeDir).mtimeMs).toBe(before.mtimeMs);
      expect(readdirSync(f.storeDir)).toEqual(reason === 'invalid generation' ? ['.we-lane-store-generation'] : []);
      if (reason === 'invalid generation') expect(readFileSync(join(f.storeDir, '.we-lane-store-generation'), 'utf8')).toBe('invalid');
    }
  });

  it.each([false, true])('removes partial pnpm output and falls back exactly once; legacy failure=%s', (legacyFails) => {
    const f = setup();
    const failure = new Error('legacy install failed');
    f.exec.mockImplementation((cmd, args) => {
      if (args[0] === '--version') return '12.1.0';
      mkdirSync(join(f.into, 'node_modules'), { recursive: true });
      writeFileSync(join(f.into, 'node_modules', 'partial'), 'partial');
      throw new Error('pnpm failed');
    });
    f.legacy.mockImplementation((into) => {
      expect(existsSync(join(into, 'node_modules'))).toBe(false);
      if (legacyFails) throw failure;
      // The marker must hash the successful legacy output, including a changed lockfile.
      writeFileSync(join(into, 'package-lock.json'), '{"lockfileVersion":3,"legacy":true}');
      mkdirSync(join(into, 'node_modules'));
    });
    const install = pnpmAwareInstaller(f);
    if (legacyFails) {
      expect(() => install(f.into)).toThrow(failure);
      expect(existsSync(join(f.into, '.we-deps-marker'))).toBe(false);
    } else {
      install(f.into);
      expectMarker(f, 'npm');
      expect(logged(f, 'backend=npm')).toBe(true);
    }
    expect(f.legacy).toHaveBeenCalledTimes(1);
    expect(f.legacy).toHaveBeenCalledWith(f.into);
    expect(installs(f)).toHaveLength(1);
    expect(logged(f, 'pnpm install failed; falling back')).toBe(true);
  });

  it('revised rule: pnpm runs in the snapshot with --frozen-lockfile and --ignore-scripts; the daemon never creates the store or rewrites its generation file', () => {
    const f = setup();
    ensureStoreGeneration(f.storeDir);
    const generationFile = join(f.storeDir, '.we-lane-store-generation');
    const generationBefore = readFileSync(generationFile, 'utf8');
    const mtimeBefore = statSync(generationFile).mtimeMs;
    const exec = f.exec.getMockImplementation();
    f.exec.mockImplementation((cmd, args, opts) => {
      if (args[0] === 'install') {
        expect(opts.cwd).toBe(f.into);
        expect(args).toEqual(expect.arrayContaining(['--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile']));
        expect(readFileSync(generationFile, 'utf8')).toBe(generationBefore);
      }
      return exec(cmd, args, opts);
    });
    pnpmAwareInstaller(f)(f.into);
    expect(installs(f)).toHaveLength(1);
    expect(readFileSync(generationFile, 'utf8')).toBe(generationBefore);
    expect(statSync(generationFile).mtimeMs).toBe(mtimeBefore);
    expectMarker(f, 'pnpm');
  });
});

describe('depsStore — completed store validation', () => {
  it.each(['generation changed', 'dangling link', 'valid pnpm', 'npm', 'no marker'])('reports completeness and queues stale stores: %s', async (reason) => {
    const f = fixture();
    const shared = join(mk('deps-shared-'), 'store');
    vi.stubEnv('WE_PNPM_STORE_DIR', shared);
    ensureStoreGeneration(shared);
    const target = join(shared, 'package');
    mkdirSync(target);
    const { dir } = depsStore(f.jobs, f.key);
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    symlinkSync(target, join(dir, 'node_modules', 'package'), 'dir');
    writeFileSync(join(dir, 'package-lock.json'), f.lock);
    writeFileSync(join(dir, '.snapshot-complete'), 'done');
    if (reason !== 'no marker') {
      const backend = reason === 'npm' ? 'npm' : 'pnpm';
      writeFileSync(join(dir, DEPS_MARKER_FILE), `${backend}:${lockHash(dir, backend, shared)}`);
    }
    if (reason === 'generation changed') {
      rmSync(shared, { recursive: true });
      ensureStoreGeneration(shared);
      mkdirSync(target);
    } else if (reason === 'dangling link') rmSync(target, { recursive: true });
    const stale = ['generation changed', 'dangling link'].includes(reason);
    expect(depsStore(f.jobs, f.key)).toEqual({ dir, complete: !stale });
    if (stale) {
      const swap = vi.fn();
      expect(await refreshDepsAsJob({ root: f.root, installed: f.installed, store: f.store, reattach: noReattach, swap, codeSha: SHA })).toMatchObject({ reason: 'deps-job-started' });
      expect(swap).not.toHaveBeenCalled();
      expect(f.store.list().records).toHaveLength(1);
      expect(f.installed.write).not.toHaveBeenCalled();
    }
  });
});

describe('settings — env beats file beats built-in, and the source is named', () => {
  it('built-in default is on', () => {
    expect(resolveDepsAsJob({ env: {}, path: '/nonexistent.json' })).toMatchObject({ enabled: true, source: 'built-in' });
  });
  it('the committed file turns it on', () => {
    expect(resolveDepsAsJob({ env: {} })).toMatchObject({ enabled: true, source: 'file' });
  });
  it('env forces it off (rollback to the inline npm ci)', () => {
    expect(resolveDepsAsJob({ env: { [DEPS_AS_JOB_ENV]: '0' } })).toMatchObject({ enabled: false, source: 'env' });
  });
});

describe('the store marker and the store check read the SAME pnpm inputs (live clone vs pinned snapshot)', () => {
  // The real call sites build a store for a pinned snapshot (sourceDir) with an installer whose sourceRoot is the live
  // clone, whose checked-out pnpm files can differ from the snapshot's while package-lock.json is identical.
  function sites({ snapshotYaml = true } = {}) {
    const lock = '{"lockfileVersion":3}';
    const write = (dir, yaml) => {
      writeFileSync(join(dir, 'package.json'), '{"name":"x","version":"1.0.0"}');
      writeFileSync(join(dir, 'package-lock.json'), lock);
      if (yaml) {
        writeFileSync(join(dir, 'pnpm-lock.yaml'), `lockfileVersion: "9.0"\n# ${yaml}\n`);
        writeFileSync(join(dir, 'pnpm-workspace.yaml'), `packages: []\n# ${yaml}\n`);
      }
    };
    const root = mk('deps-live-clone-'); write(root, 'live clone B');
    const snapshot = mk('deps-pinned-snapshot-'); write(snapshot, snapshotYaml ? 'pinned snapshot A' : null);
    const jobsDir = mk('deps-store-jobs-');
    const storeDir = join(mk('deps-store-pnpm-'), 'store');
    ensureStoreGeneration(storeDir);
    vi.stubEnv('WE_PNPM_STORE_DIR', storeDir);
    const exec = vi.fn((cmd, args) => {
      if (args[0] === '--version') return '12.1.0';
      return '';
    });
    const legacy = vi.fn((into) => mkdirSync(join(into, 'node_modules'), { recursive: true })); // npm leaves a tree
    const installer = pnpmAwareInstaller({
      sourceRoot: root, legacy, storeDir, env: {}, which: () => 'pnpm', parity: () => true, log: () => {},
      exec: (cmd, args, opts) => { exec(cmd, args, opts); if (args[0] === 'install') mkdirSync(join(opts.cwd, 'node_modules'), { recursive: true }); return args[0] === '--version' ? '12.1.0' : ''; },
    });
    const installs = () => exec.mock.calls.filter(([, args]) => args[0] === 'install').length;
    return { root, snapshot, jobsDir, installer, installs, legacy };
  }

  it('a store built for the snapshot is reused, not rebuilt on every call, when the live clone has other pnpm files', () => {
    const f = sites();
    const first = ensureNodeModulesStore({ jobsDir: f.jobsDir, sourceDir: f.snapshot, install: f.installer });
    expect(f.installs()).toBe(1);
    // The store carries the SNAPSHOT's pnpm inputs, not the live clone's.
    expect(readFileSync(join(first.dir, 'pnpm-lock.yaml'), 'utf8')).toBe(readFileSync(join(f.snapshot, 'pnpm-lock.yaml'), 'utf8'));
    expect(readFileSync(join(first.dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('pinned snapshot A');
    expect(storeStillValid(first.dir, f.snapshot)).toBe(true);
    ensureNodeModulesStore({ jobsDir: f.jobsDir, sourceDir: f.snapshot, install: f.installer });
    ensureNodeModulesStore({ jobsDir: f.jobsDir, sourceDir: f.snapshot, install: f.installer });
    expect(f.installs()).toBe(1); // no perpetual rebuild
  });

  it('and still rebuilds once when only the snapshot pnpm-lock.yaml changes', () => {
    const f = sites();
    ensureNodeModulesStore({ jobsDir: f.jobsDir, sourceDir: f.snapshot, install: f.installer });
    writeFileSync(join(f.snapshot, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n# pinned snapshot A2\n');
    ensureNodeModulesStore({ jobsDir: f.jobsDir, sourceDir: f.snapshot, install: f.installer });
    expect(f.installs()).toBe(2);
    ensureNodeModulesStore({ jobsDir: f.jobsDir, sourceDir: f.snapshot, install: f.installer });
    expect(f.installs()).toBe(2);
  });

  it('a snapshot with no pnpm files never borrows the live clone\'s: npm path, stable, no rebuild loop', () => {
    const f = sites({ snapshotYaml: false });
    const first = ensureNodeModulesStore({ jobsDir: f.jobsDir, sourceDir: f.snapshot, install: f.installer });
    expect(f.installs()).toBe(0);
    expect(f.legacy).toHaveBeenCalledTimes(1);
    expect(existsSync(join(first.dir, 'pnpm-lock.yaml'))).toBe(false);
    ensureNodeModulesStore({ jobsDir: f.jobsDir, sourceDir: f.snapshot, install: f.installer });
    expect(f.legacy).toHaveBeenCalledTimes(1);
  });
});

describe('refreshDepsAsJob — the loop side never installs', () => {
  it('up-to-date when the live node_modules was installed for this lockfile', async () => {
    const f = fixture();
    f.installed.write(f.key);
    const swap = vi.fn();
    expect(await refreshDepsAsJob({ root: f.root, installed: f.installed, store: f.store, reattach: noReattach, swap, codeSha: SHA })).toMatchObject({ reason: 'up-to-date' });
    expect(swap).not.toHaveBeenCalled();
  });

  it('a matching key is NOT up-to-date once the live pnpm links dangle: the store is revalidated and recovery queued', async () => {
    const f = fixture();
    f.installed.write(f.key);
    // The swapped-in tree links into a shared store that is then wiped; package-lock.json is unchanged.
    const sharedStore = mk('deps-shared-store-');
    mkdirSync(join(sharedStore, 'esbuild'));
    symlinkSync(join(sharedStore, 'esbuild'), join(f.root, 'node_modules', 'esbuild'), 'dir');
    const swap = vi.fn();
    expect(await refreshDepsAsJob({ root: f.root, installed: f.installed, store: f.store, reattach: noReattach, swap, codeSha: SHA }))
      .toMatchObject({ reason: 'up-to-date' });
    rmSync(sharedStore, { recursive: true, force: true });
    const r = await refreshDepsAsJob({ root: f.root, installed: f.installed, store: f.store, reattach: noReattach, swap, codeSha: SHA });
    expect(r).toMatchObject({ reason: 'deps-job-started', key: f.key });
    expect(f.store.list().records).toHaveLength(1);
    expect(f.store.list().records[0]).toMatchObject({ input: { key: f.key }, job: { kind: DEPS_JOB_KIND.kind, status: 'queued' } });
  });

  it('a matching key with no readable live node_modules is not up-to-date (fail closed)', async () => {
    const f = fixture();
    f.installed.write(f.key);
    rmSync(join(f.root, 'node_modules'), { recursive: true });
    const r = await refreshDepsAsJob({ root: f.root, installed: f.installed, store: f.store, reattach: noReattach, swap: vi.fn(), codeSha: SHA });
    expect(r.reason).not.toBe('up-to-date');
  });

  it('a changed lockfile queues ONE install job and returns at once; the live node_modules is untouched', async () => {
    const f = fixture();
    const swap = vi.fn();
    const r = await refreshDepsAsJob({ root: f.root, installed: f.installed, store: f.store, reattach: noReattach, swap, codeSha: SHA });
    expect(r).toMatchObject({ reason: 'deps-job-started', key: f.key });
    expect(swap).not.toHaveBeenCalled();
    expect(existsSync(join(f.root, 'node_modules', 'old.txt'))).toBe(true);
    const recs = f.store.list().records;
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ input: { key: f.key }, job: { kind: DEPS_JOB_KIND.kind, status: 'queued' } });
    // a second call while it is queued/running does not queue another
    expect(await refreshDepsAsJob({ root: f.root, installed: f.installed, store: f.store, reattach: noReattach, swap, codeSha: SHA })).toMatchObject({ reason: 'deps-job-running' });
    expect(f.store.list().records).toHaveLength(1);
  });

  it('once the job built the store, the next call (a pass boundary) swaps it in and records the key', async () => {
    const f = fixture();
    const st = depsStore(f.jobs, f.key);
    mkdirSync(join(st.dir, 'node_modules'), { recursive: true });
    writeFileSync(join(st.dir, 'node_modules', 'new.txt'), 'new');
    writeFileSync(join(st.dir, '.snapshot-complete'), 'x');
    const r = await refreshDepsAsJob({ root: f.root, installed: f.installed, store: f.store, reattach: noReattach, codeSha: SHA });
    expect(r).toMatchObject({ reason: 'swapped', key: f.key });
    expect(f.installed.write).toHaveBeenCalledWith(f.key);
    expect(existsSync(join(f.root, 'node_modules', 'new.txt'))).toBe(true);
    expect(existsSync(join(f.root, 'node_modules', 'old.txt'))).toBe(false);
    expect(readdirSync(f.root).filter((n) => n.startsWith('.node_modules'))).toEqual([]);
  });

  it('a failed install is retried at most once per retryMs (never back to back)', async () => {
    const f = fixture();
    let t = 1_000_000;
    const opts = { root: f.root, installed: f.installed, store: f.store, reattach: noReattach, codeSha: SHA, now: () => t, retryMs: 300_000 };
    const first = await refreshDepsAsJob(opts);
    f.store.update(first.job.id, (r) => markFailed(r, { at: new Date(t).toISOString(), reason: 'npm ci exited 1' }));
    t += 60_000;
    expect(await refreshDepsAsJob(opts)).toMatchObject({ reason: 'deps-job-spaced' });
    t += 300_000;
    expect(await refreshDepsAsJob(opts)).toMatchObject({ reason: 'deps-job-started' });
  });

  it('a swap failure leaves the live node_modules and the installed key unchanged', async () => {
    const f = fixture();
    const st = depsStore(f.jobs, f.key);
    mkdirSync(join(st.dir, 'node_modules'), { recursive: true });
    writeFileSync(join(st.dir, '.snapshot-complete'), 'x');
    const r = await refreshDepsAsJob({ root: f.root, installed: f.installed, store: f.store, reattach: noReattach, codeSha: SHA, swap: () => { throw new Error('EXDEV'); } });
    expect(r.reason).toBe('swap-failed');
    expect(f.installed.write).not.toHaveBeenCalled();
    expect(existsSync(join(f.root, 'node_modules', 'old.txt'))).toBe(true);
  });
});

describe('job child — npm never runs lifecycle scripts (the daemon holds the operator\'s credentials)', () => {
  it('the declared argv carries --ignore-scripts', () => {
    expect(DEPS_JOB_NPM_ARGS[0]).toBe('ci');
    expect(DEPS_JOB_NPM_ARGS).toContain('--ignore-scripts');
    expect(Object.isFrozen(DEPS_JOB_NPM_ARGS)).toBe(true);
  });
  it('the installer the job uses by default runs exactly that argv, in the store dir', () => {
    const exec = vi.fn();
    depsJobInstaller({ exec })('/tmp/store-x');
    expect(exec).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = exec.mock.calls[0];
    expect(cmd).toBe('npm');
    expect(args).toEqual([...DEPS_JOB_NPM_ARGS]);
    expect(opts.cwd).toBe('/tmp/store-x');
  });
});

describe('job child — installStep', () => {
  it('builds the lockfile-keyed store with the installer, once', () => {
    const f = fixture();
    const install = vi.fn((into) => { mkdirSync(join(into, 'node_modules')); writeFileSync(join(into, 'node_modules', 'pkg.txt'), 'p'); });
    const r = installStep({ jobsDir: f.jobs, sourceDir: f.root, expectKey: f.key, install });
    expect(r.key).toBe(f.key);
    expect(depsStore(f.jobs, f.key).complete).toBe(true);
    installStep({ jobsDir: f.jobs, sourceDir: f.root, expectKey: f.key, install });
    expect(install).toHaveBeenCalledTimes(1);
  });
  it('refuses when the pinned commit\'s lockfile is not the one requested', () => {
    const f = fixture();
    expect(() => installStep({ jobsDir: f.jobs, sourceDir: f.root, expectKey: 'deadbeefdeadbeef', install: vi.fn() })).toThrow(/not the requested/);
  });
});

describe('job child — the kind and the entry the runtime spawns', () => {
  it('DEPS_JOB_KIND is a valid kind, registered, pointing at this file, and needs no node_modules of its own', () => {
    expect(defineJobKind({ ...DEPS_JOB_KIND })).toEqual(DEPS_JOB_KIND);
    expect(DEPS_JOB_KINDS.get(DEPS_JOB_KIND.kind)).toBe(DEPS_JOB_KIND);
    expect(DEPS_JOB_KIND).toMatchObject({
      entry: 'scripts/lib/daemon-rebuild/deps-job.mjs', codeMode: 'readonly-tree', serial: true, nodeModules: false,
    });
    expect(existsSync(join(process.cwd(), DEPS_JOB_KIND.entry))).toBe(true);
  });

  it('runDepsJob claims a launching job from OPERATION_RUNS_DIR, builds the store from its cwd lockfile, and succeeds', async () => {
    const f = fixture();
    const queued = enqueueJob({ store: f.store, kindDef: DEPS_JOB_KIND, codeSha: SHA, input: { key: f.key } });
    f.store.update(queued.id, (r) => markLaunching(r, { at: new Date().toISOString() }));
    const install = vi.fn((into) => { mkdirSync(join(into, 'node_modules')); writeFileSync(join(into, 'node_modules', 'pkg.txt'), 'p'); });
    const out = await runDepsJob({
      env: { [JOB_ID_ENV]: queued.id, [JOB_ATTEMPT_ENV]: '1', OPERATION_RUNS_DIR: f.jobs }, cwd: f.root, install, write: () => {},
    });
    expect(out).toEqual({ outcome: 'succeeded' });
    expect(install).toHaveBeenCalledTimes(1);
    expect(depsStore(f.jobs, f.key).complete).toBe(true);
    expect(f.store.read(queued.id).job.status).toBe('succeeded');
  });

  it('runDepsJob refuses without the runtime env (never installs)', async () => {
    const install = vi.fn();
    expect(await runDepsJob({ env: {}, cwd: mk('deps-cwd-'), install, write: () => {} })).toMatchObject({ outcome: 'refused', code: 'no-job-env' });
    expect(install).not.toHaveBeenCalled();
  });
});

describe('swapNodeModules', () => {
  it('replaces the live directory with a copy of the store and leaves no temp dirs', () => {
    const clone = mk('swap-root-');
    mkdirSync(join(clone, 'node_modules'));
    writeFileSync(join(clone, 'node_modules', 'old.txt'), 'old');
    const store = mk('swap-store-');
    mkdirSync(join(store, 'node_modules'));
    writeFileSync(join(store, 'node_modules', 'new.txt'), 'new');
    swapNodeModules({ root: clone, storeDir: store });
    expect(readdirSync(join(clone, 'node_modules'))).toEqual(['new.txt']);
    expect(readdirSync(clone)).toEqual(['node_modules']);
    expect(existsSync(join(store, 'node_modules', 'new.txt'))).toBe(true); // the store is kept
  });

  const swapFixture = () => {
    const clone = mk('swap-root-');
    mkdirSync(join(clone, 'node_modules'));
    writeFileSync(join(clone, 'node_modules', 'old.txt'), 'old');
    const store = mk('swap-store-');
    mkdirSync(join(store, 'node_modules'));
    writeFileSync(join(store, 'node_modules', 'new.txt'), 'new');
    return { clone, store };
  };

  it('the copy cannot be renamed in AFTER the live tree moved aside: the old tree is renamed back (liveIntact)', () => {
    const { clone, store } = swapFixture();
    let calls = 0;
    const rename = (a, b) => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error('EPERM: rename'), { code: 'EPERM' });
      renameSync(a, b);
    };
    let err;
    try { swapNodeModules({ root: clone, storeDir: store, rename }); } catch (e) { err = e; }
    expect(err?.liveIntact).toBe(true);
    expect(readdirSync(join(clone, 'node_modules'))).toEqual(['old.txt']);
    expect(readdirSync(clone)).toEqual(['node_modules']);
  });

  it('when the rollback fails too the error says so, and the caller\'s log never claims an unchanged tree', async () => {
    const f = fixture();
    const st = depsStore(f.jobs, f.key);
    mkdirSync(join(st.dir, 'node_modules'), { recursive: true });
    writeFileSync(join(st.dir, '.snapshot-complete'), 'x');
    let calls = 0;
    const rename = (a, b) => { calls += 1; if (calls >= 2) throw new Error('ENOSPC'); renameSync(a, b); };
    const log = vi.fn();
    const r = await refreshDepsAsJob({
      root: f.root, installed: f.installed, store: f.store, reattach: noReattach, codeSha: SHA, log,
      swap: (o) => swapNodeModules({ ...o, rename }),
    });
    expect(r).toMatchObject({ reason: 'swap-failed', liveIntact: false });
    expect(f.installed.write).not.toHaveBeenCalled();
    expect(log.mock.calls.some(([m]) => /could NOT be restored/.test(m))).toBe(true);
    expect(log.mock.calls.some(([m]) => /is unchanged/.test(m))).toBe(false);
  });

  it('leftover swap/old dirs from a crashed earlier process (another pid) are removed', () => {
    const { clone, store } = swapFixture();
    mkdirSync(join(clone, '.node_modules.old.99999'));
    mkdirSync(join(clone, '.node_modules.swap.88888'));
    swapNodeModules({ root: clone, storeDir: store });
    expect(readdirSync(clone)).toEqual(['node_modules']);
  });

  it('a crash between the renames (no live node_modules) is healed by the next swap', () => {
    const { clone, store } = swapFixture();
    renameSync(join(clone, 'node_modules'), join(clone, '.node_modules.old.77777'));
    swapNodeModules({ root: clone, storeDir: store });
    expect(readdirSync(join(clone, 'node_modules'))).toEqual(['new.txt']);
    expect(readdirSync(clone)).toEqual(['node_modules']);
  });
});

describe('swapNodeModules — pnpm links survive the change of depth (real cp, no mocks)', () => {
  // The store sits deeper (jobs/node-modules/<key>) than the clone, like the daemon's real layout.
  function pnpmLayout() {
    const base = mk('swap-gvs-');
    const global = join(base, 'global-store');
    for (const pkg of ['esbuild', '@esbuild/darwin-arm64']) {
      mkdirSync(join(global, pkg), { recursive: true });
      writeFileSync(join(global, pkg, 'marker.txt'), pkg);
    }
    const store = join(base, 'jobs', 'snapshots', 'node-modules', 'key');
    const modules = join(store, 'node_modules');
    mkdirSync(join(modules, '@esbuild'), { recursive: true });
    mkdirSync(join(modules, '.bin'));
    mkdirSync(join(modules, '.pnpm', 'inner'), { recursive: true });
    writeFileSync(join(modules, '.pnpm', 'inner', 'inner.txt'), 'inner');
    const rel = (from, to) => relative(from, to);
    symlinkSync(rel(modules, join(global, 'esbuild')), join(modules, 'esbuild'));
    symlinkSync(rel(join(modules, '@esbuild'), join(global, '@esbuild/darwin-arm64')), join(modules, '@esbuild', 'darwin-arm64'));
    symlinkSync(join('.pnpm', 'inner'), join(modules, 'inner')); // inside the tree: text must stay
    symlinkSync(join(global, 'esbuild'), join(modules, 'absolute')); // absolute: untouched
    const shim = join(modules, '.bin', 'esbuild');
    writeFileSync(shim, [
      '#!/bin/sh',
      'basedir=$(dirname "$0")',
      `export NODE_PATH="$basedir/${rel(join(modules, '.bin'), join(global, 'esbuild'))}:$basedir/../.pnpm/inner:$NODE_PATH"`,
      `cat "$basedir/${rel(join(modules, '.bin'), join(global, 'esbuild'))}/marker.txt"`,
      '',
    ].join('\n'));
    chmodSync(shim, 0o755);
    // The shape pnpm 11 really writes (basedir_abs/basedir_win, single-quoted relative path, absolute NODE_PATH).
    const realShim = join(modules, '.bin', 'conc');
    const toStore = rel(join(modules, '.bin'), join(global, 'esbuild'));
    writeFileSync(realShim, [
      '#!/bin/sh',
      'basedir=$(dirname "$0")',
      'basedir_abs=$(CDPATH= cd -P -- "$basedir" && pwd -P) || exit $?',
      'basedir="$basedir_abs"',
      'basedir_win="$basedir"',
      `export NODE_PATH='${join(global, 'esbuild')}'`,
      'if [ -n "$exe" ] && [ -x "$basedir/node.exe" ]; then',
      `  exec "$basedir/node.exe"  "$basedir_win"/'${toStore}/marker.txt' "$@"`,
      'elif [ -x "$basedir/node" ]; then',
      `  exec "$basedir/node"  "$basedir_abs"/'${toStore}/marker.txt' "$@"`,
      'else',
      `  exec cat "$basedir_abs"/'${toStore}/marker.txt'`,
      'fi',
      `# cmd-shim-target=${join(global, 'esbuild', 'marker.txt')}`,
      '',
    ].join('\n'));
    chmodSync(realShim, 0o755);
    const clone = join(base, 'clone');
    mkdirSync(join(clone, 'node_modules'), { recursive: true });
    writeFileSync(join(clone, 'node_modules', 'old.txt'), 'old');
    return { base, global, store, modules, clone };
  }

  it('relative global-store links and bin shims still resolve at the clone, and the copy is not mocked', () => {
    const f = pnpmLayout();
    // Reproduces the break: a verbatim copy dangles at this depth.
    const naive = join(f.base, 'naive');
    execFileSync('cp', ['-R', f.modules, naive]);
    expect(existsSync(join(naive, 'esbuild'))).toBe(false);

    swapNodeModules({ root: f.clone, storeDir: f.store });
    const live = join(f.clone, 'node_modules');
    expect(realpathSync(join(live, 'esbuild'))).toBe(realpathSync(join(f.global, 'esbuild')));
    expect(readFileSync(join(live, 'esbuild', 'marker.txt'), 'utf8')).toBe('esbuild');
    expect(readFileSync(join(live, '@esbuild', 'darwin-arm64', 'marker.txt'), 'utf8')).toBe('@esbuild/darwin-arm64');
    expect(readFileSync(join(live, 'inner', 'inner.txt'), 'utf8')).toBe('inner');
    expect(readlinkSync(join(live, 'inner'))).toBe(join('.pnpm', 'inner'));
    expect(readlinkSync(join(live, 'absolute'))).toBe(join(f.global, 'esbuild'));
    expect(execFileSync('sh', [join(live, '.bin', 'esbuild')], { encoding: 'utf8' })).toBe('esbuild');
    // Real pnpm 11 shim spelling: dangles when copied verbatim, runs after the rebase.
    expect(() => execFileSync('sh', [join(naive, '.bin', 'conc')], { encoding: 'utf8', stdio: 'pipe' })).toThrow();
    expect(execFileSync('sh', [join(live, '.bin', 'conc')], { encoding: 'utf8' })).toBe('esbuild');
    expect(readFileSync(join(live, '.bin', 'conc'), 'utf8')).toContain(`export NODE_PATH='${join(f.global, 'esbuild')}'`);
    expect(statSync(join(live, '.bin', 'esbuild')).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(live, '.bin', 'esbuild'), 'utf8')).toContain('$basedir/../.pnpm/inner');
    // The kept store is not modified by the rebase.
    expect(readFileSync(join(f.modules, '.bin', 'esbuild'), 'utf8')).toContain(relative(join(f.modules, '.bin'), join(f.global, 'esbuild')));
    expect(readdirSync(f.clone).sort()).toEqual(['node_modules']);
  });

  it.each([
    ['unrecognised path spelling', 'exec cat "$basedir"/"../../x"'],
    ['oversized shim', null],
  ])('a bin shim the rebase cannot handle fails closed, live tree untouched: %s', (_, line) => {
    const f = pnpmLayout();
    const shim = join(f.modules, '.bin', 'odd');
    writeFileSync(shim, line === null ? `#!/bin/sh\n# basedir\n${'x'.repeat(4 * 1024 * 1024 + 1)}\n` : `#!/bin/sh\n${line}\n`);
    let err;
    try { swapNodeModules({ root: f.clone, storeDir: f.store }); } catch (e) { err = e; }
    expect(err?.message).toMatch(/bin shim/);
    expect(readdirSync(join(f.clone, 'node_modules'))).toEqual(['old.txt']);
    expect(readdirSync(f.clone)).toEqual(['node_modules']);
  });

  it('a symlinked clone root does not skew the rebased links (physical resolution)', () => {
    const f = pnpmLayout();
    const alias = join(f.base, 'alias');
    symlinkSync(f.base, alias);
    swapNodeModules({ root: join(alias, 'clone'), storeDir: join(alias, 'jobs', 'snapshots', 'node-modules', 'key') });
    expect(readFileSync(join(f.clone, 'node_modules', 'esbuild', 'marker.txt'), 'utf8')).toBe('esbuild');
    expect(execFileSync('sh', [join(f.clone, 'node_modules', '.bin', 'conc')], { encoding: 'utf8' })).toBe('esbuild');
  });

  it('a link that cannot resolve after the copy fails the swap before the working deps are touched', () => {
    const f = pnpmLayout();
    // Source resolves, the (injected) copy drops the link target's directory → rebase must refuse, not stamp.
    const exec = (cmd, args, opts) => {
      execFileSync(cmd, args, opts);
      rmSync(join(args[args.length - 1], '.pnpm', 'inner'), { recursive: true, force: true });
    };
    let err;
    try { swapNodeModules({ root: f.clone, storeDir: f.store, exec }); } catch (e) { err = e; }
    expect(err?.message).toMatch(/did not survive the copy/);
    expect(err?.liveIntact).not.toBe(false);
    expect(readdirSync(join(f.clone, 'node_modules'))).toEqual(['old.txt']);
    expect(readdirSync(f.clone)).toEqual(['node_modules']);
  });
});

describe('nativeBuilt — a platform package needs its own binding (real files)', () => {
  const MACHO = Buffer.from('cffaedfe00000000', 'hex');
  // A pnpm GVS-like layout: <store>/<pkg>/node_modules/<name>, adjacent siblings, linked from into/node_modules.
  function sharpLayout({ binding = true, libvips = true, libvipsExecutable = false } = {}, into = mk('native-into-')) {
    const gvs = mk('native-gvs-');
    const platform = `${process.platform}-${process.arch}`;
    const pkg = (dir, manifest, files = {}) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
      for (const [name, mode] of Object.entries(files)) {
        mkdirSync(join(dir, name, '..'), { recursive: true });
        writeFileSync(join(dir, name), MACHO);
        chmodSync(join(dir, name), mode);
      }
    };
    const modules = join(gvs, 'sharp', 'node_modules');
    pkg(join(modules, 'sharp'), {
      name: 'sharp', optionalDependencies: { [`@img/sharp-${platform}`]: '1', [`@img/sharp-libvips-${platform}`]: '1' },
    });
    if (binding) {
      pkg(join(modules, '@img', `sharp-${platform}`), {
        name: `@img/sharp-${platform}`, os: [process.platform], cpu: [process.arch],
        optionalDependencies: { [`@img/sharp-libvips-${platform}`]: '1' },
      }, { 'lib/sharp.node': 0o644 });
    }
    if (libvips) {
      pkg(join(modules, '@img', `sharp-libvips-${platform}`), {
        name: `@img/sharp-libvips-${platform}`, os: [process.platform], cpu: [process.arch],
      }, { 'lib/libvips-cpp.8.17.1.dylib': libvipsExecutable ? 0o755 : 0o644 });
    }
    mkdirSync(join(into, 'node_modules'), { recursive: true });
    writeFileSync(join(into, 'package.json'), '{}');
    symlinkSync(join(modules, 'sharp'), join(into, 'node_modules', 'sharp'));
    return into;
  }

  it('accepts the binding plus its supporting library', () => {
    expect(nativeBuilt(sharpLayout(), ['sharp'])).toBe(true);
  });

  it.each([false, true])('libvips present (executable=%s) but the binding absent is NOT built', (libvipsExecutable) => {
    expect(nativeBuilt(sharpLayout({ binding: false, libvipsExecutable }), ['sharp'])).toBe(false);
  });

  it('the binding present but its platform supporting library absent is NOT built', () => {
    expect(nativeBuilt(sharpLayout({ libvips: false }), ['sharp'])).toBe(false);
  });

  it('a package whose only artifact is a shared library is NOT built', () => {
    const into = mk('native-lib-only-');
    const dir = join(into, 'node_modules', 'sharp');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"name":"sharp"}');
    writeFileSync(join(dir, 'libvips.dylib'), MACHO);
    chmodSync(join(dir, 'libvips.dylib'), 0o755);
    expect(nativeBuilt(into, ['sharp'])).toBe(false);
  });

  it('the npm fallback runs when the binding is missing (pnpm result is rejected)', () => {
    const sourceRoot = mk('native-fb-source-');
    const into = mk('native-fb-into-');
    const storeDir = join(mk('native-fb-store-'), 'store');
    ensureStoreGeneration(storeDir);
    for (const dir of [sourceRoot, into]) {
      writeFileSync(join(dir, 'package.json'), '{"name":"snapshot","version":"1.0.0"}');
      writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3}');
    }
    writeFileSync(join(sourceRoot, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');
    writeFileSync(join(sourceRoot, 'pnpm-workspace.yaml'), 'allowBuilds:\n  sharp: true\n');
    const legacy = vi.fn();
    const log = vi.fn();
    pnpmAwareInstaller({
      sourceRoot, legacy, log, storeDir, env: {}, which: () => 'pnpm', parity: () => true,
      exec: (cmd, args) => { if (args[0] === '--version') return '12.1.0'; sharpLayout({ binding: false }, into); return ''; },
    })(into);
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(legacy).toHaveBeenCalledWith(into);
    expect(log.mock.calls.some(([line]) => String(line).includes('native build missing: sharp'))).toBe(true);
  });
});
