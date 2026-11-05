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
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { DEFAULT_CHILD_TIMEOUT_MS, NPM_INSTALL_TIMEOUT_MS } from './bounded-child.mjs';
import { DEFAULT_SNAPSHOT_KEEP, selectEvictions } from './daemon-jobs.mjs';
import { withFileLock } from './atomic-json-file.mjs';

const COMPLETE_MARKER = '.snapshot-complete';
/** Recorded before completion, never regenerated on reuse (including legacy stores). */
export const NODE_MODULES_HASH_FILE = '.node-modules-lock.sha256';
const CONSUMER_REFS = '.node-modules-consumers';
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

/** chmod -R a-w / u+w without following package/workspace symlinks outside the owned tree.
 * Setting directories first permits traversal/removal after a partial freeze or a killed build.
 */
export function setNodeModulesWritable(path, writable) {
  let entry;
  try { entry = lstatSync(path); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  if (entry.isSymbolicLink()) return;
  chmodSync(path, writable ? entry.mode | 0o200 : entry.mode & ~0o222);
  if (entry.isDirectory()) for (const name of readdirSync(path)) setNodeModulesWritable(join(path, name), writable);
}

function removeStore(dir) {
  // Never thaw through node_modules symlinks: their source may still serve another live job.
  setNodeModulesWritable(join(dir, 'node_modules'), true);
  rmSync(dir, { recursive: true, force: true });
}

// Outside the store so deleting the store cannot delete a held lock. The leading dot also keeps
// this sibling file out of listStores. Do not wait on contention in a daemon tick: copy or retain.
const consumerLockPath = (storeDir) => join(dirname(storeDir), `.${basename(storeDir)}.consumers.lock`);
const CONSUMER_LOCK_OPTIONS = Object.freeze({ timeoutMs: 0 });

/** A reverse reference keeps a dependency store alive for the lifetime of a rebuild snapshot.
 * Record BEFORE linking. buildOnce atomically promotes `<consumer>.building.<pid>` to consumer;
 * retain both names so the reference survives that rename and an interrupted materialization.
 * Keeping a finished snapshot is conservative: its runtime evicts it after live job refs clear.
 */
export function recordNodeModulesConsumer(storeDir, into) {
  return withFileLock(consumerLockPath(storeDir), () => {
    // Eviction may have won the lock after the caller's integrity check. Refuse a deleted or
    // partly thawed source instead of publishing a reference and then creating a dangling link.
    const modules = statSync(join(storeDir, 'node_modules'));
    if (!modules.isDirectory() || modules.mode & 0o222 || !existsSync(join(storeDir, COMPLETE_MARKER))) {
      throw new Error('consumer source no longer complete and read-only');
    }
    const building = resolve(into);
    const consumer = building.replace(/\.building\.\d+$/, '');
    const refs = join(storeDir, CONSUMER_REFS);
    try { mkdirSync(refs); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    const key = createHash('sha256').update(consumer).digest('hex');
    const path = join(refs, `${key}.json`);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ref: nodeModulesRef(basename(storeDir)), consumer, building }));
    renameSync(tmp, path);
  }, CONSUMER_LOCK_OPTIONS);
}

function hasNodeModulesConsumer(storeDir, log, readFile) {
  const refs = join(storeDir, CONSUMER_REFS);
  try {
    let names;
    try { names = readdirSync(refs); } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
    for (const name of names) {
      // A pending write or unknown record is not evidence that the store is unreferenced.
      if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error('incomplete consumer reference');
      const data = JSON.parse(readFile(join(refs, name), 'utf8'));
      if (data.ref !== nodeModulesRef(basename(storeDir)) || !isAbsolute(data.consumer ?? '') || !isAbsolute(data.building ?? '')) {
        throw new Error('invalid consumer reference');
      }
      // building first, then consumer: an atomic building -> consumer rename cannot look absent.
      for (const path of [data.building, data.consumer]) {
        try { lstatSync(path); return true; }
        catch (error) { if (error?.code !== 'ENOENT') throw error; }
      }
    }
    return false;
  } catch {
    log(`snapshot eviction: retaining ${nodeModulesRef(basename(storeDir))}; rebuild consumer evidence unreadable or incomplete`);
    return true;
  }
}

/**
 * Build `dir` once: materialize into a sibling temp dir, mark it complete, rename it into place. A leftover
 * temp dir from a killed build is removed first; a finished `dir` is returned untouched.
 */
function buildOnce(dir, materialize) {
  if (existsSync(join(dir, COMPLETE_MARKER))) return dir;
  if (existsSync(dir)) removeStore(dir); // an incomplete snapshot is never used
  const tmp = `${dir}.building.${process.pid}`;
  removeStore(tmp);
  mkdirSync(tmp, { recursive: true });
  try {
    materialize(tmp);
    writeFileSync(join(tmp, COMPLETE_MARKER), `${new Date().toISOString()}\n`);
    renameSync(tmp, dir);
  } catch (e) {
    removeStore(tmp);
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
 * The `node_modules` store for the lockfile in `sourceDir`, built on first use.
 * @param {{jobsDir: string, sourceDir: string, install?: (into: string) => void}} o
 * @returns {{key: string, dir: string}}
 */
export function ensureNodeModulesStore({ jobsDir, sourceDir, install = npmCiInstaller() }) {
  const lock = readFileSync(join(sourceDir, 'package-lock.json'), 'utf8');
  const key = lockfileKey(lock);
  const dir = join(snapshotsRoot(jobsDir), 'node-modules', key);
  mkdirSync(join(snapshotsRoot(jobsDir), 'node-modules'), { recursive: true });
  buildOnce(dir, (into) => {
    copyFileSync(join(sourceDir, 'package.json'), join(into, 'package.json'));
    copyFileSync(join(sourceDir, 'package-lock.json'), join(into, 'package-lock.json'));
    install(into);
    // Cheap mutation evidence from npm's hidden lock, not a recursive package-content audit.
    // Missing/unreadable evidence leaves this store copy-only for rebuilds.
    // Some injected installers and npm configurations produce no hidden lock: do not invent evidence.
    let recorded = false;
    try {
      const hash = createHash('sha256').update(readFileSync(join(into, 'node_modules', '.package-lock.json'))).digest('hex');
      writeFileSync(join(into, NODE_MODULES_HASH_FILE), `${hash}\n`);
      recorded = true;
    } catch { /* reuse fails closed to a private copy when no hash was recorded */ }
    // One-time recursive freeze covers package files as well as the hidden lock. Do not re-freeze
    // reused stores: a writable store must fail the consumer guard, not silently regain trust.
    // Without hash evidence the tree remains copy-only; do not freeze an unverifiable install.
    if (recorded) setNodeModulesWritable(join(into, 'node_modules'), false);
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
export function evictSnapshots({ jobsDir, referenced, keep = DEFAULT_SNAPSHOT_KEEP, dryRun = false,
  log = console.error, readFile = readFileSync, withLock = withFileLock }) {
  const refs = new Set(referenced);
  const evicted = [];
  for (const [sub, ref] of [['code', codeRef], ['node-modules', nodeModulesRef]]) {
    const dir = join(snapshotsRoot(jobsDir), sub);
    const stores = listStores(dir);
    const held = new Set(stores.filter((s) => refs.has(ref(s.key))).map((s) => s.key));
    if (sub === 'node-modules') for (const store of stores) {
      if (!held.has(store.key) && hasNodeModulesConsumer(join(dir, store.key), log, readFile)) held.add(store.key);
    }
    for (const key of selectEvictions({ stores, referenced: held, keep })) {
      const storeDir = join(dir, key);
      const remove = () => {
        if (!dryRun) removeStore(storeDir);
        evicted.push(ref(key));
      };
      if (sub !== 'node-modules') { remove(); continue; }
      let locked = false;
      try {
        withLock(consumerLockPath(storeDir), () => {
          locked = true;
          // Selection above is advisory. Registration can land after that scan, so the final
          // reference check AND the entire thaw/delete must share the publisher's lock.
          if (!hasNodeModulesConsumer(storeDir, log, readFile)) remove();
        }, CONSUMER_LOCK_OPTIONS);
      } catch (error) {
        if (locked) throw error; // a deletion error must not be reported as an intact retained tree
        log(`snapshot eviction: retaining ${ref(key)}; rebuild consumer lock unavailable`);
      }
    }
  }
  return { evicted };
}
