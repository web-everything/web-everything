import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync,
  writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { readLockfileParity } from '../check-lockfile-parity.mjs';

/**
 * Lane dependency installation. This runs BEFORE a lane has node_modules, so it imports only `node:` builtins
 * (and the parity reader, which does the same).
 *   - `selectInstaller` / `runDepsInstaller` take every subprocess/filesystem effect injected.
 *   - `lockHash`, `depsReady`, the store generation and `ensureLaneDeps` read and write the lane and store.
 *   - `createLaneDepsRuntime` is the real subprocess wiring lane-pool uses (PATH lookup, probe, install stdio).
 */

export const DEPS_BACKENDS = ['npm', 'pnpm'];

// ── pnpm store identity ─────────────────────────────────────────────────────────────────────────────────
// With the global virtual store, a pnpm lane's node_modules are symlinks into the shared store. Existence of
// the store directory proves nothing after a wipe: the first lane to reinstall recreates it, and every other
// lane's links still point at content that is gone. So each store carries a random GENERATION token, created
// once per store; a pnpm marker hashes the token, and a recreated store gets a new one.
export const STORE_GENERATION_FILE = '.we-lane-store-generation';
const GENERATION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The store's generation token, or null when missing, empty or unreadable (all read as "not this store"). */
export function readStoreGeneration(storeDir) {
  try {
    const value = readFileSync(join(storeDir, STORE_GENERATION_FILE), 'utf8').trim();
    return GENERATION_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Return the store's generation, creating the store and a fresh token when it has none. Atomic: the token is
 * written to a private temp file and hard-linked into place, so a concurrent reader never sees a partial
 * token, and when two lanes race, the loser adopts the winner's token. An unreadable existing token is replaced.
 */
export function ensureStoreGeneration(storeDir) {
  mkdirSync(storeDir, { recursive: true });
  const existing = readStoreGeneration(storeDir);
  if (existing) return existing;
  const final = join(storeDir, STORE_GENERATION_FILE);
  const temp = join(storeDir, `${STORE_GENERATION_FILE}.${process.pid}.${randomUUID()}`);
  writeFileSync(temp, randomUUID() + '\n', { flag: 'wx' });
  try {
    try {
      linkSync(temp, final);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!readStoreGeneration(storeDir)) renameSync(temp, final); // existing token unreadable: replace it
    }
  } finally {
    rmSync(temp, { force: true });
  }
  const generation = readStoreGeneration(storeDir);
  if (!generation) throw new Error('pnpm store generation unreadable after write: ' + final);
  return generation;
}

/**
 * Hash of the inputs a `backend` install depends on, or null when there is no package.json. A pnpm install
 * also depends on the store it links into, so the pnpm hash covers the store path AND its generation token:
 * moving `WE_PNPM_STORE_DIR`, or wiping and recreating the store, makes every pnpm lane stale.
 */
export function lockHash(dir, backend = 'npm', storeDir = resolvePnpmStoreDir()) {
  const lock = join(dir, 'package-lock.json');
  const pkg = join(dir, 'package.json');
  const file = existsSync(lock) ? lock : existsSync(pkg) ? pkg : null;
  if (!file) return null;
  const hash = createHash('sha256').update(readFileSync(file));
  // pnpm installs also depend on its own lockfile and workspace config (allowBuilds etc.).
  if (backend === 'pnpm') {
    for (const extra of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      const path = join(dir, extra);
      if (existsSync(path)) hash.update('\0' + extra + '\0').update(readFileSync(path));
    }
    hash.update('\0store\0' + storeDir + '\0generation\0' + (readStoreGeneration(storeDir) ?? ''));
  }
  return hash.digest('hex');
}

function readMarker(markerPath) {
  return existsSync(markerPath) ? readFileSync(markerPath, 'utf8').trim() : null;
}

/**
 * 'n/a' | 'missing' | 'stale' | 'ok' — ok when the marker matches the CURRENT hash of either backend. A pnpm
 * marker is ok only while the store it was installed into still carries the same generation token.
 */
export function depsReady(dir, markerPath, storeDir = resolvePnpmStoreDir()) {
  if (lockHash(dir) === null) return 'n/a'; // no package.json → nothing to install
  if (!existsSync(join(dir, 'node_modules'))) return 'missing';
  const have = readMarker(markerPath);
  return DEPS_BACKENDS.some(backend => markerMatches(have, lockHash(dir, backend, storeDir), backend)
    && (backend !== 'pnpm' || readStoreGeneration(storeDir) !== null)) ? 'ok' : 'stale';
}

/** The shared pnpm store: `WE_PNPM_STORE_DIR` when set, else `~/.cache/we-pnpm-store`. */
export function resolvePnpmStoreDir(env = process.env, home = homedir()) {
  return resolve(env.WE_PNPM_STORE_DIR || join(home, '.cache', 'we-pnpm-store'));
}

/** Installer policy; all subprocess/filesystem effects are injected. */
export function selectInstaller({ which, exec, hasPnpmLock, hasNpmLock, parity, storeDir }) {
  const npm = { backend: 'npm', command: 'npm', args: [hasNpmLock ? 'ci' : 'install'] };
  try {
    if (!hasPnpmLock) return npm;
    const command = which('pnpm');
    if (!command) return npm;
    // A packageManager pin can make even --version rewrite the cwd's lockfile.
    const version = String(exec(command, ['--version'], { cwd: tmpdir() })).trim();
    if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version) || Number(version.split('.')[0]) < 12) return npm;
    if (parity() !== true) return npm;
    return { backend: 'pnpm', command,
      args: ['install', '--frozen-lockfile', '--store-dir=' + storeDir], fallback: npm };
  } catch {
    return npm;
  }
}

export function markerMatches(marker, hash, backend) {
  return marker === backend + ':' + hash || (backend === 'npm' && marker === hash);
}

/**
 * Install unconditionally — readiness is `depsReady`'s call alone. `hashFor(backend)` hashes that backend's
 * install inputs. Returns the marker to persist only AFTER success. A throwing npm install propagates.
 */
export function runDepsInstaller({ plan, hashFor, marker, hasNodeModules, exec, remove,
  invalidate = () => {}, log = () => {} }) {
  invalidate();
  // Unknown or legacy state is npm-shaped; never reuse it for a pnpm installation. A pnpm install also always
  // starts from an empty node_modules: we only get here when the lane is not ready, and a not-ready pnpm lane
  // may hold links into a wiped or replaced store that pnpm could treat as already installed.
  const previous = marker?.startsWith('pnpm:') ? 'pnpm' : 'npm';
  if (hasNodeModules && (previous !== plan.backend || plan.backend === 'pnpm')) remove();
  let selected = plan;
  log('installing deps with ' + selected.backend);
  try {
    exec(selected.command, selected.args);
  } catch (error) {
    if (!selected.fallback) throw error;
    log('pnpm install failed; falling back to npm');
    remove(); // includes partial output from a failed first installation
    selected = selected.fallback;
    exec(selected.command, selected.args);
  }
  // Hash AFTER the install, for the backend that actually installed: a fallback must not stamp the pnpm
  // hash, and `npm install` may create or update package-lock.json.
  return { state: 'installed', backend: selected.backend, marker: selected.backend + ':' + hashFor(selected.backend) };
}

/**
 * Install a lane's node_modules when needed. `selectPlan()` picks the installer; `exec(command, args)` runs it.
 * Returns the `depsReady` state ('n/a' | 'ok') when nothing is installed, else 'installed'.
 *
 * A lane that is ready under EITHER backend is left alone, before any installer selection runs: selection
 * depends on the environment (PATH, the `pnpm --version` probe, a parity read), and letting it decide again
 * would wipe and reinstall a ready lane whenever that environment differs from the one that installed it.
 * So a lane switches backend only when its install inputs change (lockfiles, or the pnpm store it links into).
 * `storeDir` must be the same store `selectPlan` passes to pnpm.
 */
export function ensureLaneDeps({ dir, markerPath, selectPlan, exec, log = () => {}, storeDir = resolvePnpmStoreDir() }) {
  const state = depsReady(dir, markerPath, storeDir);
  if (state === 'n/a' || state === 'ok') return state;
  let plan = selectPlan();
  if (plan.backend === 'pnpm') {
    try {
      ensureStoreGeneration(storeDir);
    } catch (error) {
      log('pnpm store unusable (' + error.message + '); using npm');
      plan = plan.fallback;
    }
  }
  const result = runDepsInstaller({
    plan, hashFor: backend => lockHash(dir, backend, storeDir), marker: readMarker(markerPath),
    hasNodeModules: existsSync(join(dir, 'node_modules')),
    invalidate: () => rmSync(markerPath, { force: true }),
    remove: () => rmSync(join(dir, 'node_modules'), { recursive: true, force: true }),
    log, exec,
  });
  if (result.state === 'installed') writeFileSync(markerPath, result.marker);
  return result.state;
}

/** First executable `name` on an ABSOLUTE PATH entry; empty or relative entries (cwd-dependent) are skipped. */
export function whichOnPath(name, pathValue = process.env.PATH) {
  for (const entry of String(pathValue || '').split(delimiter)) {
    if (!entry || !isAbsolute(entry)) continue;
    const file = join(entry, name);
    try {
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) return file;
    } catch { /* not here */ }
  }
  return undefined;
}

/**
 * The real subprocess wiring for `ensureLaneDeps`: `{ selectPlan, exec }` for one lane directory.
 *   - the `pnpm --version` probe is bounded (15s, 64 KiB) and captured, never printed;
 *   - installer stdout goes to OUR stderr (fd 2), so a caller's `--json` stdout stays pure JSON;
 *   - installs are bounded by `installTimeoutMs` and SIGKILLed on overrun.
 */
export function createLaneDepsRuntime({ dir, storeDir, env = process.env, installTimeoutMs,
  parity = () => readLockfileParity(dir).ok }) {
  return {
    selectPlan: () => selectInstaller({
      which: name => whichOnPath(name, env.PATH),
      exec: (command, args, { cwd }) => execFileSync(command, args, {
        cwd, env, encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      }),
      hasPnpmLock: existsSync(join(dir, 'pnpm-lock.yaml')),
      hasNpmLock: existsSync(join(dir, 'package-lock.json')),
      parity,
      storeDir,
    }),
    exec: (command, args) => execFileSync(command, args, {
      cwd: dir, env, stdio: ['inherit', 2, 'inherit'], timeout: installTimeoutMs, killSignal: 'SIGKILL',
    }),
  };
}
