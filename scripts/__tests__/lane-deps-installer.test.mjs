import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectInstaller, runDepsInstaller, markerMatches, lockHash, depsReady, ensureLaneDeps,
  resolvePnpmStoreDir, ensureStoreGeneration, readStoreGeneration, STORE_GENERATION_FILE, whichOnPath,
  createLaneDepsRuntime } from '../lib/lane-deps-installer.mjs';

function select(overrides = {}) {
  return selectInstaller({ which: () => '/bin/pnpm', exec: () => '12.18.0',
    hasPnpmLock: true, hasNpmLock: true, parity: () => true,
    storeDir: '/shared/store', ...overrides });
}
function run(plan, overrides = {}) {
  const exec = vi.fn();
  const remove = vi.fn();
  const result = runDepsInstaller({ plan, hashFor: () => 'hash', marker: null,
    hasNodeModules: true, exec, remove, ...overrides });
  return { result, exec, remove };
}

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
/** A lane-shaped temp dir: both lockfiles, workspace config, installed node_modules, marker inside .git. */
function lane({ marker, nodeModules = true, storeDir: sharedStore } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lane-deps-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), '{"name":"x"}');
  writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3}');
  writeFileSync(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'allowBuilds:\n  esbuild: true\n');
  mkdirSync(join(dir, '.git'));
  if (nodeModules) { mkdirSync(join(dir, 'node_modules')); writeFileSync(join(dir, 'node_modules', 'kept'), 'x'); }
  const markerPath = join(dir, '.git', '.lane-pool-deps');
  const storeDir = sharedStore ?? join(dir, 'store'); // the shared pnpm store this lane links into
  ensureStoreGeneration(storeDir); // an existing, initialised store
  if (marker) writeFileSync(markerPath, marker(dir, storeDir));
  return { dir, markerPath, storeDir };
}
const pnpmMarker = (d, store) => 'pnpm:' + lockHash(d, 'pnpm', store);
const npmMarker = d => 'npm:' + lockHash(d, 'npm');

describe('lane deps installer', () => {
  it('probes pnpm version in the OS temp directory instead of the repo', () => {
    const exec = vi.fn(() => '12.18.0');
    expect(select({ exec }).backend).toBe('pnpm');
    expect(exec).toHaveBeenCalledWith('/bin/pnpm', ['--version'], { cwd: tmpdir() });
    expect(exec.mock.calls[0][2].cwd).not.toBe(process.cwd());
  });
  it('pnpm missing falls back to npm', () => {
    expect(select({ which: () => null }).backend).toBe('npm');
  });
  it('unreadable or malformed pnpm version falls back to npm', () => {
    expect(select({ exec: () => { throw Error('probe failed'); } }).backend).toBe('npm');
    expect(select({ exec: () => 'unknown' }).backend).toBe('npm');
  });
  it('invalidates marker before installation, including when npm fails', () => {
    const events = [];
    expect(() => run(select({ which: () => null }), {
      marker: 'npm:old',
      invalidate: () => events.push('invalidate'),
      exec: () => { events.push('install'); throw Error('failure'); },
    })).toThrow('failure');
    expect(events).toEqual(['invalidate', 'install']);
  });
  it('pnpm old falls back to npm', () => {
    expect(select({ exec: () => '11.9.0' }).backend).toBe('npm');
  });
  it('missing pnpm lock falls back to npm', () => {
    expect(select({ hasPnpmLock: false }).backend).toBe('npm');
  });
  it('parity failure or unreadable evidence falls back to npm', () => {
    expect(select({ parity: () => false }).backend).toBe('npm');
    expect(select({ parity: () => { throw Error('unreadable'); } }).backend).toBe('npm');
  });
  it('happy path builds pnpm argv with store-dir and frozen-lockfile', () => {
    expect(select()).toMatchObject({ backend: 'pnpm', command: '/bin/pnpm',
      args: ['install', '--frozen-lockfile', '--store-dir=/shared/store'] });
  });
  it('pnpm non-zero exit wipes partial modules and falls back to npm', () => {
    const exec = vi.fn().mockImplementationOnce(() => { throw Error('exit 1'); });
    const { result, remove } = run(select(), { exec, hasNodeModules: false });
    expect(exec.mock.calls.map(call => call.slice(0, 2))).toEqual([
      ['/bin/pnpm', ['install', '--frozen-lockfile', '--store-dir=/shared/store']],
      ['npm', ['ci']],
    ]);
    expect(remove).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ backend: 'npm', marker: 'npm:hash' });
  });
  it('pnpm-to-npm fallback marker carries the npm hash, not the pnpm one', () => {
    const exec = vi.fn().mockImplementationOnce(() => { throw Error('exit 1'); });
    const hashFor = backend => backend + '-hash';
    const { result } = run(select(), { exec, hashFor, hasNodeModules: false });
    expect(result).toMatchObject({ state: 'installed', backend: 'npm', marker: 'npm:npm-hash' });
  });
  it.each([['npm:old', 'pnpm'], ['old', 'pnpm'], ['pnpm:old', 'npm']])(
    'stale marker backend switch %s to %s wipes node_modules before install', (marker, backend) => {
      const plan = backend === 'pnpm' ? select() : select({ which: () => null });
      const events = [];
      run(plan, { marker, remove: () => events.push('remove'), exec: () => events.push('install') });
      expect(events).toEqual(['remove', 'install']);
    });
  it('legacy plain lock hash matches npm only', () => {
    expect(markerMatches('hash', 'hash', 'npm')).toBe(true);
    expect(markerMatches('hash', 'hash', 'pnpm')).toBe(false);
  });
  it('npm without a lock uses install and propagates npm failure', () => {
    const plan = select({ which: () => null, hasNpmLock: false });
    expect(plan.args).toEqual(['install']);
    expect(() => run(plan, { exec: () => { throw Error('npm failed'); } })).toThrow('npm failed');
  });
});

describe('lane deps hashing and readiness (real lane directory)', () => {
  it.each(['pnpm-lock.yaml', 'pnpm-workspace.yaml'])(
    'a %s change moves the pnpm hash only and makes a pnpm-marked lane stale', file => {
      const { dir, markerPath, storeDir } = lane({ marker: pnpmMarker });
      const before = { npm: lockHash(dir, 'npm'), pnpm: lockHash(dir, 'pnpm', storeDir) };
      expect(depsReady(dir, markerPath, storeDir)).toBe('ok');
      writeFileSync(join(dir, file), readFileSync(join(dir, file), 'utf8') + '# changed\n');
      expect(lockHash(dir, 'pnpm', storeDir)).not.toBe(before.pnpm);
      expect(lockHash(dir, 'npm')).toBe(before.npm);
      expect(depsReady(dir, markerPath, storeDir)).toBe('stale');
    });
  it('package-lock.json changes move both backend hashes', () => {
    const { dir, storeDir } = lane();
    const before = { npm: lockHash(dir, 'npm'), pnpm: lockHash(dir, 'pnpm', storeDir) };
    writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3,"x":1}');
    expect(lockHash(dir, 'npm')).not.toBe(before.npm);
    expect(lockHash(dir, 'pnpm', storeDir)).not.toBe(before.pnpm);
  });
  it('a wiped pnpm store makes a pnpm-marked lane stale (its links would dangle); npm lanes are unaffected', () => {
    const pnpmLane = lane({ marker: pnpmMarker });
    rmSync(pnpmLane.storeDir, { recursive: true });
    expect(depsReady(pnpmLane.dir, pnpmLane.markerPath, pnpmLane.storeDir)).toBe('stale');
    const npmLane = lane({ marker: npmMarker });
    rmSync(npmLane.storeDir, { recursive: true });
    expect(depsReady(npmLane.dir, npmLane.markerPath, npmLane.storeDir)).toBe('ok');
  });
  it('a moved store (WE_PNPM_STORE_DIR changed) makes a pnpm-marked lane stale even when the new store exists', () => {
    const { dir, markerPath, storeDir } = lane({ marker: pnpmMarker });
    const moved = join(dir, 'other-store');
    ensureStoreGeneration(moved);
    expect(lockHash(dir, 'pnpm', moved)).not.toBe(lockHash(dir, 'pnpm', storeDir));
    expect(depsReady(dir, markerPath, moved)).toBe('stale');
  });
  it('a legacy plain-hash (npm) marker stays ready and skips install', () => {
    const { dir, markerPath, storeDir } = lane({ marker: d => lockHash(d, 'npm') });
    const exec = vi.fn();
    expect(ensureLaneDeps({ dir, markerPath, storeDir, selectPlan: () => select({ storeDir }), exec })).toBe('ok');
    expect(exec).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'node_modules', 'kept'))).toBe(true);
  });
  it('a wiped store makes ensureLaneDeps reinstall a pnpm lane into the store it is given', () => {
    const { dir, markerPath, storeDir } = lane({ marker: pnpmMarker });
    rmSync(storeDir, { recursive: true });
    const exec = vi.fn(() => mkdirSync(join(dir, 'node_modules'), { recursive: true }));
    const plan = select({ storeDir });
    expect(ensureLaneDeps({ dir, markerPath, storeDir, selectPlan: () => plan, exec })).toBe('installed');
    expect(exec).toHaveBeenCalledWith('/bin/pnpm', ['install', '--frozen-lockfile', '--store-dir=' + storeDir]);
    expect(readStoreGeneration(storeDir)).not.toBeNull(); // a fresh generation for the recreated store
    expect(depsReady(dir, markerPath, storeDir)).toBe('ok');
  });
  it('an empty or garbled generation token reads as not-this-store and is replaced', () => {
    const { dir, markerPath, storeDir } = lane({ marker: pnpmMarker });
    const before = readStoreGeneration(storeDir);
    for (const garbage of ['', 'not-a-token\n']) {
      writeFileSync(join(storeDir, STORE_GENERATION_FILE), garbage);
      expect(readStoreGeneration(storeDir)).toBeNull();
      expect(depsReady(dir, markerPath, storeDir)).toBe('stale');
    }
    const replaced = ensureStoreGeneration(storeDir);
    expect(replaced).not.toBe(before);
    expect(ensureStoreGeneration(storeDir)).toBe(replaced); // stable once written
    expect(depsReady(dir, markerPath, storeDir)).toBe('stale'); // the old marker named the old generation
  });
  it('an unusable store (path is a file) falls back to npm instead of installing pnpm', () => {
    const { dir, markerPath } = lane({ marker: () => 'npm:old' });
    const storeDir = join(dir, 'store-is-a-file');
    writeFileSync(storeDir, 'x');
    const exec = vi.fn(() => mkdirSync(join(dir, 'node_modules'), { recursive: true }));
    expect(ensureLaneDeps({ dir, markerPath, storeDir, selectPlan: () => select({ storeDir }), exec })).toBe('installed');
    expect(exec.mock.calls.map(call => call[0])).toEqual(['npm']);
    expect(readFileSync(markerPath, 'utf8')).toBe('npm:' + lockHash(dir, 'npm'));
  });
  it('recreating a wiped shared store does not revalidate other unrepaired pnpm lanes', () => {
    const shared = mkdtempSync(join(tmpdir(), 'lane-deps-store-'));
    dirs.push(shared);
    const storeDir = join(shared, 'store');
    const a = lane({ storeDir });
    const b = lane({ storeDir });
    writeFileSync(join(b.dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n# lane b has a different graph\n");
    const install = l => ensureLaneDeps({ dir: l.dir, markerPath: l.markerPath, storeDir,
      selectPlan: () => select({ storeDir }),
      exec: () => { mkdirSync(storeDir, { recursive: true }); mkdirSync(join(l.dir, 'node_modules'), { recursive: true }); } });
    expect(install(a)).toBe('installed');
    expect(install(b)).toBe('installed');
    expect([depsReady(a.dir, a.markerPath, storeDir), depsReady(b.dir, b.markerPath, storeDir)]).toEqual(['ok', 'ok']);
    rmSync(storeDir, { recursive: true }); // the documented recovery: wipe the store
    expect(install(a)).toBe('installed'); // the first lane to reinstall recreates the store
    expect(depsReady(a.dir, a.markerPath, storeDir)).toBe('ok');
    expect(depsReady(b.dir, b.markerPath, storeDir)).toBe('stale'); // b's links still point into the wiped store
  });
  it('a stale pnpm marker reinstalls from an empty node_modules (dangling links are never reused)', () => {
    const { dir, markerPath, storeDir } = lane({ marker: () => 'pnpm:old' });
    const exec = vi.fn(() => {
      expect(existsSync(join(dir, 'node_modules', 'kept'))).toBe(false);
      mkdirSync(join(dir, 'node_modules'), { recursive: true });
    });
    expect(ensureLaneDeps({ dir, markerPath, storeDir, selectPlan: () => select({ storeDir }), exec })).toBe('installed');
    expect(exec).toHaveBeenCalledOnce();
  });
  it('no package.json is n/a; no node_modules is missing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'lane-deps-empty-'));
    dirs.push(empty);
    expect(depsReady(empty, join(empty, 'marker'))).toBe('n/a');
    const { dir, markerPath } = lane({ nodeModules: false });
    expect(depsReady(dir, markerPath)).toBe('missing');
  });

  it.each([
    ['pnpm-marked lane, plan now resolves to npm', 'pnpm', 'npm'],
    ['npm-marked lane, plan now resolves to pnpm', 'npm', 'pnpm'],
  ])('a ready %s is left alone: no probe, no wipe, no install', (_name, installed) => {
    const { dir, markerPath, storeDir } = lane({ marker: installed === 'pnpm' ? pnpmMarker : npmMarker });
    const before = readFileSync(markerPath, 'utf8');
    // The plan an install would pick now resolves to the OTHER backend (PATH, probe or parity changed).
    const selectPlan = vi.fn(() => installed === 'pnpm' ? select({ which: () => null }) : select());
    const exec = vi.fn();
    const state = ensureLaneDeps({ dir, markerPath, storeDir, selectPlan, exec });
    expect(existsSync(join(dir, 'node_modules', 'kept'))).toBe(true);
    expect(exec).not.toHaveBeenCalled();
    expect(selectPlan).not.toHaveBeenCalled(); // no `pnpm --version` probe on a ready lane
    expect(state).toBe('ok');
    expect(readFileSync(markerPath, 'utf8')).toBe(before);
  });
  it('a stale lane installs and stamps <backend>:<that backend hash>', () => {
    const { dir, markerPath, storeDir } = lane({ marker: () => 'pnpm:old' });
    const exec = vi.fn(() => mkdirSync(join(dir, 'node_modules'), { recursive: true }));
    expect(ensureLaneDeps({ dir, markerPath, storeDir, selectPlan: () => select({ storeDir }), exec })).toBe('installed');
    expect(exec).toHaveBeenCalledOnce();
    expect(readFileSync(markerPath, 'utf8')).toBe('pnpm:' + lockHash(dir, 'pnpm', storeDir));
    expect(depsReady(dir, markerPath, storeDir)).toBe('ok');
  });
  it('a pnpm failure falling back to npm stamps the npm hash, which reads as ready', () => {
    const { dir, markerPath, storeDir } = lane({ nodeModules: false });
    const exec = vi.fn().mockImplementationOnce(() => { throw Error('exit 1'); })
      .mockImplementationOnce(() => mkdirSync(join(dir, 'node_modules')));
    expect(ensureLaneDeps({ dir, markerPath, storeDir, selectPlan: () => select({ storeDir }), exec })).toBe('installed');
    expect(lockHash(dir, 'npm')).not.toBe(lockHash(dir, 'pnpm', storeDir));
    expect(readFileSync(markerPath, 'utf8')).toBe('npm:' + lockHash(dir, 'npm'));
    expect(depsReady(dir, markerPath, storeDir)).toBe('ok');
  });
  it('removes the old marker before installing, so a failed install never leaves it valid', () => {
    const { dir, markerPath, storeDir } = lane({ marker: () => 'npm:old' });
    const exec = vi.fn(() => { expect(existsSync(markerPath)).toBe(false); throw Error('npm failed'); });
    expect(() => ensureLaneDeps({ dir, markerPath, storeDir, selectPlan: () => select({ which: () => null }), exec }))
      .toThrow('npm failed');
    expect(exec).toHaveBeenCalledOnce();
    expect(existsSync(markerPath)).toBe(false);
  });
  it('npm install that creates package-lock.json stamps the hash of the lock it wrote', () => {
    const { dir, markerPath, storeDir } = lane({ nodeModules: false });
    rmSync(join(dir, 'package-lock.json'));
    const exec = vi.fn(() => {
      writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3,"new":true}');
      mkdirSync(join(dir, 'node_modules'));
    });
    const plan = select({ which: () => null, hasNpmLock: false });
    expect(ensureLaneDeps({ dir, markerPath, storeDir, selectPlan: () => plan, exec })).toBe('installed');
    expect(readFileSync(markerPath, 'utf8')).toBe('npm:' + lockHash(dir, 'npm'));
    expect(depsReady(dir, markerPath, storeDir)).toBe('ok');
  });
});

describe('lane-pool runtime wiring (real subprocesses, shim installers on PATH)', () => {
  const SHIM = `#!/bin/sh
printf '%s|%s|%s\\n' "$(basename "$0")" "$(pwd -P)" "$*" >> "$SHIM_LOG"
if [ "$1" = "--version" ]; then echo 12.18.0; exit 0; fi
echo "SHIM-STDOUT-$(basename "$0")"
mkdir -p node_modules
`;
  const CHILD = `
    import { ensureLaneDeps, createLaneDepsRuntime, resolvePnpmStoreDir } from ${JSON.stringify(
    pathToFileURL(resolve('scripts/lib/lane-deps-installer.mjs')).href)};
    const dir = process.env.LANE_DIR;
    const storeDir = resolvePnpmStoreDir();
    const state = ensureLaneDeps({ dir, markerPath: dir + '/.git/.lane-pool-deps', storeDir,
      ...createLaneDepsRuntime({ dir, storeDir, installTimeoutMs: 60_000 }) });
    console.log(JSON.stringify({ state, storeDir }));
  `;
  function fixture(shims) {
    const root = mkdtempSync(join(tmpdir(), 'lane-deps-wiring-'));
    dirs.push(root);
    const dir = join(root, 'lane');
    const bin = join(root, 'bin');
    mkdirSync(join(dir, '.git'), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}');
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
      '': { name: 'x' }, 'node_modules/a': { version: '1.0.0', integrity: 'sha512-abc' } } }));
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'packages:\n  a@1.0.0:\n    resolution: {integrity: sha512-abc}\n');
    for (const name of shims) { writeFileSync(join(bin, name), SHIM); chmodSync(join(bin, name), 0o755); }
    const store = join(root, 'store');
    const log = join(root, 'shim.log');
    // The real lane-pool shape: a separate process whose stdout a caller parses as JSON.
    const run = spawnSync(process.execPath, ['--input-type=module', '--eval', CHILD], {
      env: { PATH: bin + ':/bin:/usr/bin', HOME: root, WE_PNPM_STORE_DIR: store, SHIM_LOG: log, LANE_DIR: dir },
      encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 60_000,
    });
    return { dir, store, log, run };
  }
  it('pnpm on PATH: probe outside the lane, install with the env store, installer stdout only on stderr', () => {
    const { dir, store, log, run } = fixture(['pnpm', 'npm']);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout.trim())).toEqual({ state: 'installed', storeDir: store });
    expect(run.stdout).not.toContain('SHIM-STDOUT');
    expect(run.stderr).toContain('SHIM-STDOUT-pnpm');
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => line.split('|'));
    expect(calls).toHaveLength(2);
    const laneReal = realpathSync(dir);
    expect(calls[0][0]).toBe('pnpm');
    expect(calls[0][2]).toBe('--version');
    expect(calls[0][1]).not.toBe(laneReal);
    expect(calls[1]).toEqual(['pnpm', laneReal, 'install --frozen-lockfile --store-dir=' + store]);
    expect(readStoreGeneration(store)).not.toBeNull();
    expect(readFileSync(join(dir, '.git', '.lane-pool-deps'), 'utf8')).toBe('pnpm:' + lockHash(dir, 'pnpm', store));
    expect(depsReady(dir, join(dir, '.git', '.lane-pool-deps'), store)).toBe('ok');
  });
  it('no pnpm on PATH: npm ci in the lane, its stdout only on stderr, child stdout stays pure JSON', () => {
    const { dir, store, log, run } = fixture(['npm']);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout.trim())).toEqual({ state: 'installed', storeDir: store });
    expect(run.stdout).not.toContain('SHIM-STDOUT');
    expect(run.stderr).toContain('SHIM-STDOUT-npm');
    expect(readFileSync(log, 'utf8').trim().split('\n').map(line => line.split('|')))
      .toEqual([['npm', realpathSync(dir), 'ci']]);
    expect(readFileSync(join(dir, '.git', '.lane-pool-deps'), 'utf8')).toBe('npm:' + lockHash(dir, 'npm'));
  });
  it('PATH lookup skips empty and relative entries (they would depend on the cwd)', () => {
    const root = mkdtempSync(join(tmpdir(), 'lane-deps-which-'));
    dirs.push(root);
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin', 'pnpm'), SHIM);
    chmodSync(join(root, 'bin', 'pnpm'), 0o755);
    expect(whichOnPath('pnpm', 'bin::' + join(root, 'missing'))).toBeUndefined();
    expect(whichOnPath('pnpm', ':bin:' + join(root, 'bin'))).toBe(join(root, 'bin', 'pnpm'));
    writeFileSync(join(root, 'not-exec'), 'x');
    expect(whichOnPath('not-exec', root)).toBeUndefined();
  });
});

describe('pnpm store directory', () => {
  it('defaults to the shared store under the home cache directory', () => {
    expect(resolvePnpmStoreDir({}, '/home/op')).toBe(resolve('/home/op/.cache/we-pnpm-store'));
  });
  it('honours WE_PNPM_STORE_DIR, resolved to an absolute path', () => {
    expect(resolvePnpmStoreDir({ WE_PNPM_STORE_DIR: '/data/store' }, '/home/op')).toBe(resolve('/data/store'));
    expect(resolvePnpmStoreDir({ WE_PNPM_STORE_DIR: 'rel/store' }, '/home/op')).toBe(resolve('rel/store'));
  });
  it('an empty WE_PNPM_STORE_DIR falls back to the default', () => {
    expect(resolvePnpmStoreDir({ WE_PNPM_STORE_DIR: '' }, '/home/op')).toBe(resolve('/home/op/.cache/we-pnpm-store'));
  });
});
