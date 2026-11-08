import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync,
  statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { readLockfileParity } from '../check-lockfile-parity.mjs';

/**
 * Lane dependency installation. This runs BEFORE a lane has node_modules, so it imports only `node:` builtins
 * (and the parity reader, which does the same).
 *   - `selectInstaller` / `runDepsInstaller` take every subprocess/filesystem effect injected.
 *   - `lockHash`, `depsReady`, the store generation and `ensureLaneDeps` read and write the lane and store.
 *   - `createLaneDepsRuntime` is the real subprocess wiring lane-pool uses (PATH lookup, probe, install stdio).
 * Ready npm lanes migrate when pnpm is usable; a failed pnpm install suppresses migration for the resulting
 * npm lock hash. Ready pnpm lanes need no installer probe.
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
 * True when a top-level node_modules entry (or a scoped package under `@scope/`) is a symlink whose target is
 * gone: store content deleted underneath a lane while the store root and its token survived (a partial wipe,
 * a disk cleaner). Unreadable node_modules counts as dangling (fail closed).
 */
export function hasDanglingTopLevelLink(nodeModules) {
  try {
    for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue; // .bin, .modules.yaml, .pnpm …
      const path = join(nodeModules, entry.name);
      const children = entry.name.startsWith('@') && entry.isDirectory()
        ? readdirSync(path, { withFileTypes: true }).map(child => [child, join(path, child.name)])
        : [[entry, path]];
      for (const [item, itemPath] of children) if (item.isSymbolicLink() && !existsSync(itemPath)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * 'n/a' | 'missing' | 'stale' | 'ok' — ok when the marker matches the CURRENT hash of either backend. A pnpm
 * marker is ok only while the store it was installed into still carries the same generation token AND the
 * lane's top-level links still resolve into it. A matching npm (including raw-hash) marker is stale when
 * the optional `pnpmUsable()` probe returns true; without a probe, pnpm is treated as unavailable.
 */
export function depsReady(dir, markerPath, storeDir = resolvePnpmStoreDir(), { pnpmUsable = () => false } = {}) {
  if (lockHash(dir) === null) return 'n/a'; // no package.json → nothing to install
  const nodeModules = join(dir, 'node_modules');
  if (!existsSync(nodeModules)) return 'missing';
  const have = readMarker(markerPath);
  if (markerMatches(have, lockHash(dir, 'npm'), 'npm')) return pnpmUsable() === true ? 'stale' : 'ok';
  return DEPS_BACKENDS.some(backend => markerMatches(have, lockHash(dir, backend, storeDir), backend)
    && (backend !== 'pnpm' || (readStoreGeneration(storeDir) !== null && !hasDanglingTopLevelLink(nodeModules))))
    ? 'ok' : 'stale';
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
 * True when another live process holds this lane (a fresh lease whose pid is not ours). `provision`/`refresh`
 * call ensureDeps on leased lanes too, so a lane in use must never be migrated; our own acquire's lease is fine.
 * An unreadable lease file reads as foreign-held (fail closed).
 */
export function hasForeignLiveLease(dir, nowMs = Date.now(), { ownReservedIsOurs = false } = {}) {
  const file = join(dir, '.git', '.lane-lease');
  if (!existsSync(file)) return false;
  try {
    // Mirrors lane-lease.mjs#isLeaseStale (not imported: this file runs before node_modules and the parity
    // bootstrap fixture copies only this file's declared imports). TTL runs from the later of acquire/renew.
    const lease = JSON.parse(readFileSync(file, 'utf8'));
    if (!lease || typeof lease !== 'object') return true;
    // Reserved leases are never ours to migrate, whatever the pid; a stale reinstall (which predates the claim
    // gate) is the one caller that treats our own reserved lease as ours.
    if (lease.reserved && !(ownReservedIsOurs && lease.pid === process.pid)) return true;
    if (lease.pid === process.pid) return false;
    return isLeaseFresh(lease, nowMs);
  } catch {
    return true;
  }
}

/**
 * True while a lease is inside its TTL (from the later of acquire/renew). An unparseable timestamp reads stale,
 * like lane-lease.mjs. A lease that is not fresh can be reclaimed by another acquire at any moment, so it
 * protects nothing: no removal may rely on it.
 */
function isLeaseFresh(lease, nowMs, marginMs = 0) {
  const acquired = Date.parse(lease.acquiredAt);
  if (Number.isNaN(acquired)) return false;
  const renewed = Date.parse(lease.renewedAt);
  const ttl = Number.isFinite(lease.ttlMinutes) ? lease.ttlMinutes * 60_000 : 240 * 60_000;
  return nowMs - (Number.isNaN(renewed) ? acquired : Math.max(acquired, renewed)) < ttl - marginMs;
}

// An install is bounded (a pnpm attempt, then an npm fallback, each under NPM_INSTALL_TIMEOUT_MS = 10 min), and the
// claim is never renewed, so a claim must outlast all of it. The migration claim lasts CLAIM_TTL_MINUTES; our own
// acquire lease is claimed only while it has MIN_CLAIM_REMAINING_MS left (else the lane is left as it is, never
// started and abandoned). A removal needs REMOVAL_MARGIN_MS of lease left, so an expiry cannot land during it.
const CLAIM_TTL_MINUTES = 60;
const MIN_CLAIM_REMAINING_MS = 30 * 60_000;
const REMOVAL_MARGIN_MS = 5 * 60_000;

/**
 * Claim a lane for an install or migration, so no other process can take it between our last lease check and
 * the removal of node_modules. Returns `{ holds(), release() }`, or null when the lane is not ours to claim.
 *   - our own lease (acquire wrote it, same pid, not reserved): already ours, nothing is written or removed;
 *   - no lease: write one atomically and exclusively (temp file + hard link, like lane-pool's acquire), so a
 *     process claiming the lane afterwards fails with EEXIST and sees a live lease;
 *   - anything else (foreign, stale, reserved, unreadable): null. A stale lease cannot be swapped atomically
 *     here, so its lane waits for the next acquire, which holds its own lease while it installs.
 * `holds()` re-reads the lease and is true only while it is still our claim (a process that replaced the lease
 * wins); `release()` removes the lease only if it is still our claim.
 */
export function claimLaneForInstall(dir, nowMs = Date.now()) {
  const file = join(dir, '.git', '.lane-lease');
  const read = () => {
    try {
      const lease = JSON.parse(readFileSync(file, 'utf8'));
      return lease && typeof lease === 'object' ? lease : null;
    } catch {
      return null;
    }
  };
  // A claim only protects the lane while its lease is fresh: an expired lease can be reclaimed by another acquire
  // between our last check and the removal, so `holds()` is false (fail closed) once the lease is not fresh.
  if (existsSync(file)) {
    const lease = read();
    return lease && !lease.reserved && lease.pid === process.pid && isLeaseFresh(lease, nowMs, MIN_CLAIM_REMAINING_MS)
      ? { holds: (marginMs = 0) => { const now = read(); return !!now && !now.reserved && now.pid === process.pid && isLeaseFresh(now, Date.now(), marginMs); }, release: () => {} }
      : null;
  }
  const token = randomUUID();
  const body = JSON.stringify({
    session: 'lane-deps-migration', purpose: 'deps-migration', acquiredAt: new Date(nowMs).toISOString(),
    ttlMinutes: CLAIM_TTL_MINUTES, host: null, pid: process.pid, ownerSession: null, workflowLane: false, depsMigration: token,
  }) + '\n';
  const temp = `${file}.tmp-${process.pid}-${token}`;
  try {
    writeFileSync(temp, body, { flag: 'wx' });
    linkSync(temp, file); // atomic no-clobber: fails EEXIST when anyone claimed the lane since the check above
  } catch {
    return null;
  } finally {
    rmSync(temp, { force: true });
  }
  const mine = (marginMs = 0) => { const now = read(); return now?.depsMigration === token && isLeaseFresh(now, Date.now(), marginMs); };
  const stillOurs = () => read()?.depsMigration === token;
  return { holds: mine, release: () => { if (stillOurs()) rmSync(file, { force: true }); } };
}

/**
 * Install a lane's node_modules when needed. `selectPlan()` picks the installer; `exec(command, args)` runs it.
 * Returns the `depsReady` state ('n/a' | 'ok') when nothing is installed, else 'installed'.
 *
 * A ready pnpm lane is left alone without installer selection. A matching npm/raw-hash lane with node_modules
 * lazily selects a plan and migrates when pnpm is usable; that same plan is reused for installation.
 * A pnpm install failure followed by successful npm fallback records the resulting npm lock hash in
 * `<markerPath>.pnpm-failed`, suppressing migration (and its probe) while that hash remains current.
 * Any install that can remove an existing node_modules (a stale reinstall or a migration) first claims the lane
 * (`claimLaneForInstall`) and holds the claim until the install ends; a lane that cannot be claimed (foreign,
 * stale, reserved or unreadable lease) stays as it is and keeps its current state ('ok' or 'stale'). The one
 * exception is an ordinary stale reinstall (not a migration): it also proceeds, unclaimed, on our own lease or an
 * expired one, and is deferred only while another live process holds the lane.
 * `storeDir` must be the same store `selectPlan` passes to pnpm.
 */
export function ensureLaneDeps({ dir, markerPath, selectPlan, exec, log = () => {}, storeDir = resolvePnpmStoreDir() }) {
  let plan;
  const getPlan = () => (plan ??= selectPlan());
  const failedPath = markerPath + '.pnpm-failed';
  const state = depsReady(dir, markerPath, storeDir, {
    pnpmUsable: () => readMarker(failedPath) !== lockHash(dir, 'npm') && !hasForeignLiveLease(dir)
      && getPlan().backend === 'pnpm',
  });
  if (state === 'n/a' || state === 'ok') return state;
  plan = getPlan();
  // Anything that can remove an existing node_modules (a stale reinstall, or the migration of a lane that reads ok
  // without the pnpm probe) needs the lane first. The probe above can take seconds, so claim the lane now
  // (atomically, see claimLaneForInstall) instead of re-checking and hoping: once the claim is ours no other
  // process can take the lane, and a lane we cannot claim is left exactly as it is.
  let claim = null;
  const unchanged = depsReady(dir, markerPath, storeDir) === 'ok' ? 'ok' : state; // what a left-alone lane reports
  if (existsSync(join(dir, 'node_modules'))) {
    claim = claimLaneForInstall(dir);
    // The claim gate protects a MIGRATION (a lane that reads ok without the probe). An ordinary stale reinstall
    // predates it and must keep running for our own lease (short, reserved or expired: acquire holds the lane while
    // it installs) and for an expired lease, which protects nothing; only another live process holding the lane,
    // or an unreadable lease, defers it. Skipping silently would hand the caller out-of-date node_modules.
    if (!claim) {
      if (unchanged === 'ok') return unchanged;
      if (hasForeignLiveLease(dir, Date.now(), { ownReservedIsOurs: true })) {
        // Fail closed, but never silently: callers ignore the return value, so this line is the only trace that the
        // lane keeps out-of-date node_modules (another live process holds it, or its lease file is unreadable).
        log('stale deps NOT reinstalled: the lane is held by another live process or its lease is unreadable: ' + dir);
        return unchanged;
      }
    }
  }
  try {
    return installLaneDeps({ dir, markerPath, storeDir, plan, claim, unchanged, exec, log, failedPath });
  } finally {
    claim?.release();
  }
}

/** The install half of `ensureLaneDeps`. A held `claim` is re-verified right before every removal. */
function installLaneDeps({ dir, markerPath, storeDir, plan, claim, unchanged, exec, log, failedPath }) {
  const wantedPnpm = plan.backend === 'pnpm'; // also true when the store is unusable and we fall back below
  let generation = null; // the store generation this pnpm install links into
  if (plan.backend === 'pnpm') {
    try {
      generation = ensureStoreGeneration(storeDir);
    } catch (error) {
      log('pnpm store unusable (' + error.message + '); using npm');
      plan = plan.fallback;
    }
  }
  // Last check before anything is touched: a process that replaced our claim owns the lane now.
  if (claim && !claim.holds(REMOVAL_MARGIN_MS)) {
    log('lane claimed by another process (or its lease is about to expire) before migration; leaving deps as they are');
    return unchanged;
  }
  const assertHeld = () => {
    if (claim && !claim.holds(REMOVAL_MARGIN_MS)) throw new Error('lane claim lost or expiring during migration: ' + dir);
  };
  const result = runDepsInstaller({
    plan, hashFor: backend => lockHash(dir, backend, storeDir), marker: readMarker(markerPath),
    hasNodeModules: existsSync(join(dir, 'node_modules')),
    invalidate: () => { assertHeld(); rmSync(markerPath, { force: true }); },
    remove: () => { assertHeld(); rmSync(join(dir, 'node_modules'), { recursive: true, force: true }); },
    log, exec,
  });
  // The store was wiped and recreated WHILE pnpm installed: this lane's links point at the old generation's
  // content. Stamp nothing, so the lane stays stale and the next acquire reinstalls into the new store.
  if (result.backend === 'pnpm' && readStoreGeneration(storeDir) !== generation) {
    log('pnpm store generation changed during install; leaving deps stale');
    return 'stale';
  }
  if (result.state === 'installed') {
    // An expired holder that resumes must not stamp a marker over a lane another acquire may now own: stamp nothing
    // and the lane stays stale, so the next acquire reinstalls.
    if (claim && !claim.holds()) {
      log('lane claim lost during install; leaving deps stale');
      return 'stale';
    }
    if (wantedPnpm && result.backend === 'npm') {
      writeFileSync(failedPath, lockHash(dir, 'npm'));
    }
    writeFileSync(markerPath, result.marker);
  }
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
 *   - the `pnpm --version` probe is bounded (`probeTimeoutMs`, `probeMaxBuffer`) and captured, never printed;
 *     a probe that hangs or floods output selects npm;
 *   - installer stdout goes to OUR stderr (fd 2), so a caller's `--json` stdout stays pure JSON;
 *   - installs are bounded by `installTimeoutMs` and SIGKILLed on overrun.
 */
export const PROBE_TIMEOUT_MS = 15_000;
export const PROBE_MAX_BUFFER = 64 * 1024;
export function createLaneDepsRuntime({ dir, storeDir, env = process.env, installTimeoutMs,
  probeTimeoutMs = PROBE_TIMEOUT_MS, probeMaxBuffer = PROBE_MAX_BUFFER,
  parity = () => readLockfileParity(dir).ok }) {
  return {
    selectPlan: () => selectInstaller({
      which: name => whichOnPath(name, env.PATH),
      exec: (command, args, { cwd }) => execFileSync(command, args, {
        cwd, env, encoding: 'utf8', timeout: probeTimeoutMs, maxBuffer: probeMaxBuffer, killSignal: 'SIGKILL',
        stdio: ['ignore', 'pipe', 'pipe'],
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
