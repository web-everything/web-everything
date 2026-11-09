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

import { createHash, randomUUID } from 'node:crypto';
import * as childProcess from 'node:child_process';
import * as filesystem from 'node:fs';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

import { DEFAULT_CHILD_TIMEOUT_MS, NPM_INSTALL_TIMEOUT_MS } from './bounded-child.mjs';
import { DEFAULT_SNAPSHOT_KEEP, selectEvictions } from './daemon-jobs.mjs';
import { acquireLockDir, makeLockEntry, releaseLockDirIf } from '../readiness/file-locks.mjs';

const COMPLETE_MARKER = '.snapshot-complete';
const INTEGRITY_MARKER = '.snapshot-integrity.json';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
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
function buildOnce(dir, materialize, { acceptConcurrentWinner = true } = {}) {
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
    if (acceptConcurrentWinner && existsSync(join(dir, COMPLETE_MARKER))) return dir; // a concurrent builder won the rename
    throw e;
  }
  return dir;
}

/** Verification and repair share one cross-process lock; contention defers to the next tick.
 * Never steal an old lock: an npm/archive child can outlive its parent. Operators must
 * confirm the owner and its children stopped before removing an abandoned lock.
 */
function withSnapshotLock(jobsDir, dir, fn) {
  const lockRoot = join(snapshotsRoot(jobsDir), '.locks');
  const entry = makeLockEntry(`snapshot-${process.pid}-${randomUUID()}`, dir, new Date().toISOString(), process.pid);
  if (!acquireLockDir(lockRoot, dir, entry)) {
    throw new Error('snapshot verification/repair busy; retry next tick; for an abandoned lock, confirm owner and children stopped before operator removal');
  }
  try { return fn(); } finally { releaseLockDirIf(lockRoot, dir, entry); }
}

/** Default code materializer: bounded archive then extraction; either failure rejects the snapshot. */
export function gitArchiveMaterializer(repoDir, codeSha, { timeoutMs = DEFAULT_CHILD_TIMEOUT_MS } = {}) {
  return (into) => {
    // A shell pipeline only reports tar's status: a failed git archive can otherwise
    // publish an empty "complete" snapshot. Keep the archive outside the extracted tree.
    const archive = `${into}.archive.tar`;
    try {
      childProcess.execFileSync('git', ['-C', repoDir, 'archive', '--format=tar', `--output=${archive}`, codeSha], {
        stdio: ['ignore', 'ignore', 'pipe'], timeout: timeoutMs,
      });
      childProcess.execFileSync('tar', ['-xf', archive, '-C', into], {
        stdio: ['ignore', 'ignore', 'pipe'], timeout: timeoutMs,
      });
    } finally {
      rmSync(archive, { force: true });
    }
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
  return withSnapshotLock(jobsDir, dir, () => {
    if (verifyCodeSnapshot(dir, codeSha)) return dir;
    rmSync(dir, { recursive: true, force: true });
    buildOnce(dir, (into) => {
      make(into);
      writeFileSync(join(into, INTEGRITY_MARKER), JSON.stringify({
        codeSha, treeDigest: codeTreeDigest(into),
      }));
    }, { acceptConcurrentWinner: false });
    if (!verifyCodeSnapshot(dir, codeSha)) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error('code snapshot integrity verification failed; retry next tick');
    }
    return dir;
  });
}

/** Digest archived code separately from the dependency link and publication evidence. */
function codeTreeDigest(root) {
  if (!lstatSync(root).isDirectory()) throw new Error('code snapshot is not a directory');
  const entries = [];
  function visit(at) {
    for (const name of readdirSync(at)) {
      if (at === root && [COMPLETE_MARKER, INTEGRITY_MARKER, 'node_modules'].includes(name)) continue;
      const path = join(at, name);
      const info = lstatSync(path);
      const key = relative(root, path).split(sep).join('/');
      if (info.isDirectory()) {
        entries.push({ path: key, type: 'directory' });
        visit(path);
      } else if (info.isSymbolicLink()) {
        const target = relative(realpathSync(root), realpathSync(path));
        if (isAbsolute(target) || target === '..' || target.startsWith(`..${sep}`)) {
          throw new Error('code link escapes snapshot');
        }
        entries.push({ path: key, type: 'link', target: readlinkSync(path) });
      } else if (info.isFile()) {
        const bytes = filesystem.readFileSync(path);
        entries.push({ path: key, type: 'file', mode: info.mode, size: bytes.length, sha256: sha256(bytes) });
      } else throw new Error('unsupported code entry');
    }
  }
  visit(root);
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return sha256(JSON.stringify(entries));
}

function verifyCodeSnapshot(dir, codeSha) {
  try {
    if (!lstatSync(dir).isDirectory() || !lstatSync(join(dir, COMPLETE_MARKER)).isFile()
      || !lstatSync(join(dir, INTEGRITY_MARKER)).isFile()) return false;
    const record = JSON.parse(readFileSync(join(dir, INTEGRITY_MARKER), 'utf8'));
    return record.codeSha === codeSha && record.treeDigest === codeTreeDigest(dir);
  } catch { return false; }
}

/** Default installer: `npm ci --ignore-scripts` in a directory holding only the manifest and lockfile. */
export function npmCiInstaller({ timeoutMs = NPM_INSTALL_TIMEOUT_MS, exec = childProcess.execFileSync } = {}) {
  return (into) => {
    exec('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: into, stdio: ['ignore', 'ignore', 'pipe'], timeout: timeoutMs });
    if (!existsSync(join(into, 'node_modules'))) {
      // npm ci can succeed without creating a tree for a dependency-free package.
      // Normalize only proven empty input, after npm has validated manifest/lock agreement;
      // unknown evidence or a missing nonempty install still refuses publication.
      const manifest = JSON.parse(readFileSync(join(into, 'package.json'), 'utf8'));
      const lock = JSON.parse(readFileSync(join(into, 'package-lock.json'), 'utf8'));
      const emptyMap = (value) => value !== null && typeof value === 'object'
        && !Array.isArray(value) && Object.keys(value).length === 0;
      const noDependencies = (pkg) => pkg !== null && typeof pkg === 'object' && !Array.isArray(pkg)
        && ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].every(
          (field) => pkg[field] === undefined || emptyMap(pkg[field]),
        ) && ['workspaces', 'bundleDependencies', 'bundledDependencies'].every((field) => pkg[field] === undefined);
      if (![2, 3].includes(lock.lockfileVersion) || !lock.packages || typeof lock.packages !== 'object'
        || Array.isArray(lock.packages) || Object.keys(lock.packages).some((path) => path !== '')
        || (lock.dependencies !== undefined && !emptyMap(lock.dependencies))
        || !noDependencies(manifest) || !noDependencies(Object.hasOwn(lock.packages, '') ? lock.packages[''] : {})) {
        throw new Error('npm ci left no dependency tree without proof of an empty install');
      }
      mkdirSync(join(into, 'node_modules'));
    }
  };
}

/**
 * Digest every installed file, including nested/scoped manifests and bin links. Links must
 * resolve to files inside this tree; external or directory links are not pinned dependencies.
 */
function dependencyTreeDigest(root) {
  if (!lstatSync(root).isDirectory()) throw new Error('dependency tree is not a directory');
  const canonicalRoot = realpathSync(root);
  const entries = [];
  function visit(at) {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (entry.isSymbolicLink()) {
        const target = relative(canonicalRoot, realpathSync(path));
        if (isAbsolute(target) || target === '..' || target.startsWith(`..${sep}`)) {
          throw new Error('dependency link escapes store');
        }
      }
      if (!statSync(path).isFile()) throw new Error('unsupported dependency entry');
      const bytes = filesystem.readFileSync(path);
      entries.push({ path: relative(root, path).split(sep).join('/'), size: bytes.length, sha256: sha256(bytes) });
    }
  }
  visit(root);
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return sha256(JSON.stringify(entries));
}

function verifyDependencyStore(dir, lockHash) {
  try {
    if (!lstatSync(dir).isDirectory() || !statSync(join(dir, COMPLETE_MARKER)).isFile()) return false;
    const record = JSON.parse(readFileSync(join(dir, INTEGRITY_MARKER), 'utf8'));
    return record.lockHash === lockHash
      && sha256(readFileSync(join(dir, 'package-lock.json'))) === lockHash
      && record.treeDigest === dependencyTreeDigest(join(dir, 'node_modules'));
  } catch { return false; }
}

/**
 * The `node_modules` store for the lockfile in `sourceDir`, built on first use.
 * Adopters use a separate npm-installed namespace: shared job stores may be checkout copies.
 * Every store requires integrity evidence; missing/corrupt evidence installs once, then re-verifies.
 * @param {{jobsDir: string, sourceDir: string, install?: (into: string) => void, adopter?: boolean}} o
 * @returns {{key: string, dir: string}}
 */
export function ensureNodeModulesStore({ jobsDir, sourceDir, install = npmCiInstaller(), adopter = false }) {
  const lock = readFileSync(join(sourceDir, 'package-lock.json'), 'utf8');
  const key = lockfileKey(lock);
  const namespace = adopter ? 'adopter-node-modules' : 'node-modules';
  const dir = join(snapshotsRoot(jobsDir), namespace, key);
  mkdirSync(join(snapshotsRoot(jobsDir), namespace), { recursive: true });
  const lockHash = sha256(lock);
  return withSnapshotLock(jobsDir, dir, () => {
    if (verifyDependencyStore(dir, lockHash)) return { key, dir };
    rmSync(dir, { recursive: true, force: true });
    buildOnce(dir, (into) => {
      copyFileSync(join(sourceDir, 'package.json'), join(into, 'package.json'));
      copyFileSync(join(sourceDir, 'package-lock.json'), join(into, 'package-lock.json'));
      install(into);
      writeFileSync(join(into, INTEGRITY_MARKER), JSON.stringify({
        lockHash, treeDigest: dependencyTreeDigest(join(into, 'node_modules')),
      }));
    }, { acceptConcurrentWinner: false });
    // "C: a rebuilt tree still changing during verification refuses adoption after
    // one repair" defends this second read against the freshly recorded digest.
    if (!verifyDependencyStore(dir, lockHash)) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error('dependency integrity verification failed; retry next tick');
    }
    return { key, dir };
  });
}

/** Link a store's `node_modules` into a code snapshot (idempotent). */
export function linkNodeModules(snapshotDir, storeDir, { replace = false } = {}) {
  const link = join(snapshotDir, 'node_modules');
  // Remove the link itself (including a dangling link), never its target store.
  if (replace) rmSync(link, { recursive: true, force: true });
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
