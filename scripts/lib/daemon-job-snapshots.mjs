/**
 * @file scripts/lib/daemon-job-snapshots.mjs
 * @description PINNED CODE FOR READ-ONLY JOBS (#4125, statute `#daemon-jobs`): a `readonly-tree` job runs from
 *   a snapshot of one commit, so a clone rebuild mid-job never changes the code under it.
 *
 *   `<jobsDir>/.snapshots/code/<codeSha>/`          — `git archive` of the commit, extracted once
 *   `<jobsDir>/.snapshots/node-modules/<lockHash>/` — a `node_modules` store, keyed by the LOCKFILE hash, not
 *                                                     the commit (ratify red-team finding 3: most commits do
 *                                                     not change dependencies, so a per-commit install would
 *                                                     re-download the world on every snapshot)
 *
 *   A snapshot links the matching store in as `node_modules`. Both are built in a temp directory and renamed
 *   into place, so a half-built snapshot is never used. {@link evictSnapshots} removes any store no live job
 *   references, keeping at most 2 (`daemon-jobs.mjs#selectEvictions`).
 *
 *   Every real child call (`git archive | tar`, `npm ci`) is bounded and injectable for tests.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { DEFAULT_CHILD_TIMEOUT_MS, NPM_INSTALL_TIMEOUT_MS } from './bounded-child.mjs';
import { DEFAULT_SNAPSHOT_KEEP, selectEvictions } from './daemon-jobs.mjs';
import { markerMatches, lockHash, hasDanglingTopLevelLink, resolvePnpmStoreDir } from './lane-deps-installer.mjs';

const COMPLETE_MARKER = '.snapshot-complete';
// Keep this leaf independent of deps-job, which imports the snapshot helpers.
const DEPS_MARKER_FILE = '.we-deps-marker';
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** `<jobsDir>/.snapshots` — dot-named so the run store's `*.json` listing never sees it. */
export function snapshotsRoot(jobsDir) {
  return join(jobsDir, '.snapshots');
}

/** The reference a job record carries (`job.snapshotKeys`) for a store it runs on. */
export const codeRef = (sha) => `code:${sha}`;
export const nodeModulesRef = (hash) => `node-modules:${hash}`;

/** Lockfile hash — the `node_modules` store key. 16 hex of sha256, like the repo's other content keys. */
export function lockfileKey(lockText) {
  return createHash('sha256').update(String(lockText)).digest('hex').slice(0, 16);
}

function assertKey(key, what) {
  if (!KEY_RE.test(String(key))) throw new TypeError(`daemon-jobs: invalid ${what} ${JSON.stringify(key)}`);
}

/**
 * Build `dir` once: materialize into a sibling temp dir, mark it complete, rename it into place. A leftover
 * temp dir from a killed build is removed first; a finished `dir` is returned untouched.
 */
function buildOnce(dir, materialize) {
  if (existsSync(join(dir, COMPLETE_MARKER))) return dir;
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); // an incomplete snapshot is never used
  const tmp = `${dir}.building.${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    materialize(tmp);
    writeFileSync(join(tmp, COMPLETE_MARKER), `${new Date().toISOString()}\n`);
    renameSync(tmp, dir);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    if (existsSync(join(dir, COMPLETE_MARKER))) return dir; // a concurrent builder won the rename
    throw e;
  }
  return dir;
}

/** Default code materializer: `git archive <sha> | tar -x`, bounded. */
export function gitArchiveMaterializer(repoDir, codeSha, { timeoutMs = DEFAULT_CHILD_TIMEOUT_MS } = {}) {
  return (into) => {
    execFileSync('sh', ['-c', 'git -C "$1" archive --format=tar "$2" | tar -x -C "$3"', 'sh', repoDir, codeSha, into], {
      stdio: ['ignore', 'ignore', 'pipe'], timeout: timeoutMs,
    });
  };
}

/**
 * The pinned code snapshot for `codeSha`, built on first use.
 * @param {{jobsDir: string, codeSha: string, repoDir?: string, materialize?: (into: string) => void}} o
 * @returns {string} the snapshot directory
 */
export function ensureCodeSnapshot({ jobsDir, codeSha, repoDir, materialize }) {
  assertKey(codeSha, 'codeSha');
  const make = materialize ?? gitArchiveMaterializer(repoDir, codeSha);
  const dir = join(snapshotsRoot(jobsDir), 'code', codeSha);
  mkdirSync(join(snapshotsRoot(jobsDir), 'code'), { recursive: true });
  return buildOnce(dir, make);
}

/** Default installer: `npm ci --ignore-scripts` in a directory holding only the manifest and lockfile. */
export function npmCiInstaller({ timeoutMs = NPM_INSTALL_TIMEOUT_MS } = {}) {
  return (into) => {
    execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: into, stdio: ['ignore', 'ignore', 'pipe'], timeout: timeoutMs });
  };
}

/**
 * Read-only reuse check. Whatever the marker says, a tree whose top-level store links dangle is never reused: a copy of
 * a pnpm-linked clone can be stamped npm (its provenance is lost), and the shared store it links into can vanish.
 * A pnpm marker must also still match the current inputs and store generation. With `sourceDir` (the source the store
 * is being requested for) the marker is compared with THAT source's pnpm inputs: the store key is the npm lockfile
 * alone, so a change to only `pnpm-lock.yaml` / `pnpm-workspace.yaml` of the source leaves the key unchanged and the
 * cached copy's own (old) inputs would still match its own marker. Without it, the cached copy's inputs are used.
 */
export function storeStillValid(dir, sourceDir = null) {
  let marker;
  try { marker = readFileSync(join(dir, DEPS_MARKER_FILE), 'utf8').trim(); }
  catch (error) {
    // Historical stores have no marker. Other read failures are incomplete evidence.
    if (error.code !== 'ENOENT') return false;
    marker = null;
  }
  try {
    // A source with no readable inputs hashes to null, which matches no marker: fail closed (rebuild).
    if (marker?.startsWith('pnpm:') && !markerMatches(marker, lockHash(sourceDir ?? dir, 'pnpm', resolvePnpmStoreDir()), 'pnpm')) return false;
    return !hasDanglingTopLevelLink(join(dir, 'node_modules'));
  } catch { return false; }
}

/** 8 hex naming the pnpm inputs of `sourceDir` (the part of a store's validity the npm-lockfile key cannot see). */
function pnpmInputsKey(sourceDir) {
  const hash = lockHash(sourceDir, 'pnpm', resolvePnpmStoreDir()) ?? 'none';
  return createHash('sha256').update(String(hash)).digest('hex').slice(0, 8);
}

const MAX_LINK_SCAN = 256;

/**
 * True when a code snapshot's `node_modules` symlink points into store `dir`. Fails closed: an unreadable snapshot
 * directory, an unreadable link, or more snapshots than {@link MAX_LINK_SCAN} count as in use, so a store is never
 * deleted on incomplete evidence.
 */
export function storeInUse(jobsDir, dir) {
  const codeRoot = join(snapshotsRoot(jobsDir), 'code');
  if (!existsSync(codeRoot)) return false;
  const target = resolve(dir, 'node_modules');
  try {
    const snapshots = readdirSync(codeRoot);
    if (snapshots.length > MAX_LINK_SCAN) return true;
    for (const name of snapshots) {
      const link = join(codeRoot, name, 'node_modules');
      let isLink;
      try { isLink = lstatSync(link).isSymbolicLink(); } catch (error) { if (error.code === 'ENOENT') continue; return true; }
      if (!isLink) continue;
      const to = resolve(join(codeRoot, name), readlinkSync(link));
      if (to === target || to.startsWith(target + sep)) return true;
    }
    return false;
  } catch { return true; }
}

function storeHasDanglingLink(dir) {
  try { return hasDanglingTopLevelLink(join(dir, 'node_modules')); } catch { return false; }
}

/**
 * The `node_modules` store for the lockfile in `sourceDir`, built on first use.
 * @param {{jobsDir: string, sourceDir: string, install?: (into: string) => void}} o
 * @returns {{key: string, dir: string}}
 */
export function ensureNodeModulesStore({ jobsDir, sourceDir, install = npmCiInstaller() }) {
  const lock = readFileSync(join(sourceDir, 'package-lock.json'), 'utf8');
  const baseKey = lockfileKey(lock);
  mkdirSync(join(snapshotsRoot(jobsDir), 'node-modules'), { recursive: true });
  let key = baseKey;
  let dir = join(snapshotsRoot(jobsDir), 'node-modules', key);
  if (existsSync(join(dir, COMPLETE_MARKER)) && !storeStillValid(dir, sourceDir)) {
    // The npm lockfile is the key, so two sources can differ only in their pnpm inputs and ask for the same store.
    // A store another snapshot still links to is never deleted under it: the replacement is built beside it, under a
    // key that also names the source's pnpm inputs. Only a store nothing links to (or one whose links dangle, so
    // nothing can use it) is removed and rebuilt in place.
    if (storeInUse(jobsDir, dir) && !storeHasDanglingLink(dir)) {
      key = `${baseKey}.p${pnpmInputsKey(sourceDir)}`;
      dir = join(snapshotsRoot(jobsDir), 'node-modules', key);
      if (existsSync(join(dir, COMPLETE_MARKER)) && !storeStillValid(dir, sourceDir)) {
        if (storeInUse(jobsDir, dir) && !storeHasDanglingLink(dir)) {
          throw new Error(`node_modules store ${key} is in use and stale: refusing to delete it under a running snapshot`);
        }
        rmSync(dir, { recursive: true, force: true });
      }
    } else {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  buildOnce(dir, (into) => {
    copyFileSync(join(sourceDir, 'package.json'), join(into, 'package.json'));
    copyFileSync(join(sourceDir, 'package-lock.json'), join(into, 'package-lock.json'));
    // The installer is told which tree this store is FOR: its pnpm inputs (and so the marker it stamps) must come from
    // the same `sourceDir` that `storeStillValid(dir, sourceDir)` later hashes, never from a different checkout.
    install(into, { sourceDir });
  });
  return { key, dir };
}

/** Link a store's `node_modules` into a code snapshot (idempotent). */
export function linkNodeModules(snapshotDir, storeDir) {
  const link = join(snapshotDir, 'node_modules');
  if (existsSync(link)) return link;
  symlinkSync(join(storeDir, 'node_modules'), link, 'dir');
  return link;
}

function listStores(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => KEY_RE.test(name) && !name.includes('.building.'))
    .map((name) => ({ key: name, mtimeMs: statSync(join(dir, name)).mtimeMs }));
}

/**
 * Evict snapshot stores no live job references, keeping at most `keep` per store type.
 * @param {{jobsDir: string, referenced: Iterable<string>, keep?: number, dryRun?: boolean}} o - `referenced`
 *   is the union of every non-terminal job's `snapshotKeys` (`code:<sha>`, `node-modules:<hash>`).
 * @returns {{evicted: string[]}}
 */
export function evictSnapshots({ jobsDir, referenced, keep = DEFAULT_SNAPSHOT_KEEP, dryRun = false }) {
  const refs = new Set(referenced);
  const evicted = [];
  for (const [sub, ref] of [['code', codeRef], ['node-modules', nodeModulesRef]]) {
    const dir = join(snapshotsRoot(jobsDir), sub);
    const stores = listStores(dir);
    const held = new Set(stores.filter((s) => refs.has(ref(s.key))).map((s) => s.key));
    for (const key of selectEvictions({ stores, referenced: held, keep })) {
      if (!dryRun) rmSync(join(dir, key), { recursive: true, force: true });
      evicted.push(ref(key));
    }
  }
  return { evicted };
}
