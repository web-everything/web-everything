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
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { setTreeWritable as setNodeModulesWritable, removeReadonlyTree as removeStore } from './readonly-tree.mjs';
import { DEFAULT_CHILD_TIMEOUT_MS, NPM_INSTALL_TIMEOUT_MS } from './bounded-child.mjs';
import { DEFAULT_SNAPSHOT_KEEP, selectEvictions } from './daemon-jobs.mjs';
import { withFileLock } from './atomic-json-file.mjs';

const COMPLETE_MARKER = '.snapshot-complete';
/** Recorded before completion, never regenerated on reuse (including legacy stores). */
export const NODE_MODULES_HASH_FILE = '.node-modules-lock.sha256';
export const NODE_MODULES_MANIFEST_FILE = '.node-modules-packages.json';
export const NODE_MODULES_UNSAFE_FILE = '.node-modules-unsafe';
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

export { setTreeWritable as setNodeModulesWritable } from './readonly-tree.mjs';

// Outside the store so deleting the store cannot delete a held lock. The leading dot also keeps
// this sibling file out of listStores. Do not wait on contention in a daemon tick: refuse or retain.
const consumerLockPath = (storeDir) => join(dirname(storeDir), `.${basename(storeDir)}.consumers.lock`);
const CONSUMER_LOCK_OPTIONS = Object.freeze({ timeoutMs: 0 });

/** Copying, reference publication, and eviction share one non-waiting store lock. */
export function withNodeModulesStoreLock(storeDir, run) {
  return withFileLock(consumerLockPath(storeDir), run, CONSUMER_LOCK_OPTIONS);
}

const quarantineNotice = (storeDir) => join(dirname(storeDir), `.node-modules-quarantined-${basename(storeDir)}.json`);

/** A tombstone survives quarantine eviction until a normal install completes at the original key. */
export function hasQuarantinedNodeModulesStore(storeDir) {
  return existsSync(quarantineNotice(storeDir));
}

/** Resolve a quarantined generation to a fresh store without disturbing existing consumers.
 * Tombstone content gives every installer/reader the same next key. Unreadable evidence throws.
 */
export function nodeModulesStoreDir(jobsDir, key) {
  assertKey(key, 'lockfile key');
  const root = join(snapshotsRoot(jobsDir), 'node-modules');
  for (let generation = 0; generation < 16; generation += 1) {
    const dir = join(root, key);
    if (!hasQuarantinedNodeModulesStore(dir)) return dir;
    const next = lockfileKey(`${key}:${readFileSync(quarantineNotice(dir), 'utf8')}`);
    if (!existsSync(dir) && !existsSync(join(root, next))) return dir;
    key = next;
  }
  throw new Error('dependency recovery generation limit reached; operator must stop consumers and perform quarantine cleanup');
}

export function quarantineNodeModulesStore(storeDir, reason) {
  return withNodeModulesStoreLock(storeDir, () => {
    const quarantined = join(dirname(storeDir), `.quarantined-${Date.now()}-${process.pid}-${basename(storeDir)}`);
    writeFileSync(quarantineNotice(storeDir), JSON.stringify({ reason, quarantined }));
    // Quarantine revokes reuse immediately, but existing links must keep resolving.
    // Keep their tree and permissions intact until the normal locked evictor sees
    // no consumers. Unknown reference evidence also retains the store.
    if (hasNodeModulesConsumer(storeDir, console.error, readFileSync)) {
      writeFileSync(join(storeDir, NODE_MODULES_UNSAFE_FILE), JSON.stringify({ phase: 'quarantine', reason }));
      return storeDir;
    }
    renameSync(storeDir, quarantined);
    // A quarantine is never reusable; leave it removable by the next eviction pass.
    setNodeModulesWritable(join(quarantined, 'node_modules'), true);
    writeFileSync(join(quarantined, NODE_MODULES_UNSAFE_FILE), JSON.stringify({ phase: 'quarantine', reason }));
    return quarantined;
  });
}

/** One metadata-only pass over the entire owned tree, including nested dependencies and dotfiles.
 * Fingerprint symlinks including their text; resolve them only to check containment, never walk
 * their targets. POSIX symlink modes are not access controls, so include but do not reject 0777.
 * Resolve the root because a completed snapshot may itself alias another dependency store.
 * Earlier count-only walk measured 21,448 entries in 591.8 ms (2026-11-05, queued macOS
 * checkout probe, requireReadonly:false). That is not a timing of this extended fingerprint.
 * Threat model: cooperating jobs and accidental mutation, not forged same-user mtimes.
 */
export function nodeModulesTreeEvidence(modules, { lstat = lstatSync, readDir = readdirSync, readLink = readlinkSync, requireReadonly = true } = {}) {
  const root = realpathSync(modules);
  const pending = [root];
  const entries = [];
  const contained = (path) => {
    const rel = relative(root, path);
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  let entryCount = 0;
  while (pending.length) {
    const path = pending.pop();
    const info = lstat(path);
    entryCount += 1;
    const link = info.isSymbolicLink();
    if (!Number.isSafeInteger(info.mode) || !Number.isSafeInteger(info.size) || !Number.isFinite(info.mtimeMs)) throw new Error('unreadable tree entry');
    if (!link && requireReadonly && info.mode & 0o222) {
      throw Object.assign(new Error('writable tree entry'), { code: 'ENODEMODULESPERMISSION' });
    }
    let text = null;
    if (link) {
      try {
        text = readLink(path);
        if (typeof text !== 'string' || !text || isAbsolute(text) || !contained(resolve(dirname(path), text)) || !contained(realpathSync(path))) {
          throw new Error('link escapes dependency store');
        }
      } catch (error) {
        throw Object.assign(new Error('unsafe or unreadable dependency symlink', { cause: error }), { code: 'EUNSAFENODEMODULESLINK' });
      }
    }
    const type = link ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
    entries.push([relative(root, path), type, info.mode, info.size, info.mtimeMs, text]);
    if (link) continue;
    if (info.isDirectory()) {
      for (const entry of readDir(path, { withFileTypes: true })) pending.push(join(path, entry.name));
    }
  }
  entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return { entryCount, treeSha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
}

/** Shallow npm package inventory: depth one, or depth two under @scope. No package-content walk.
 * Manifest stats and permissions must be readable; workspace links are checked via their targets.
 */
export function nodeModulesPackageManifest(modules, { stat = statSync, readFile = readFileSync, requireReadonly = true } = {}) {
  const packages = [];
  const directory = (path) => {
    const info = stat(path);
    if (!info.isDirectory() || !Number.isSafeInteger(info.mode)) throw new Error('package directory evidence unreadable');
    if (requireReadonly && info.mode & 0o222) throw Object.assign(new Error('package directory writable'), { code: 'ENODEMODULESPERMISSION' });
  };
  const add = (name) => {
    const dir = join(modules, name);
    directory(dir);
    const path = join(dir, 'package.json');
    const info = stat(path);
    if (!info.isFile() || !Number.isSafeInteger(info.mode)
      || !Number.isSafeInteger(info.size) || !Number.isFinite(info.mtimeMs)) throw new Error('package.json evidence unreadable or writable');
    if (requireReadonly && info.mode & 0o222) throw Object.assign(new Error('package.json writable'), { code: 'ENODEMODULESPERMISSION' });
    const pkg = JSON.parse(readFile(path, 'utf8'));
    if (typeof pkg.name !== 'string' || !pkg.name || typeof pkg.version !== 'string' || !pkg.version) {
      throw new Error('package identity missing');
    }
    packages.push([name, `${pkg.name}@${pkg.version}`, info.size, info.mtimeMs]);
  };
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    if (entry.name.startsWith('@')) {
      directory(join(modules, entry.name));
      for (const child of readdirSync(join(modules, entry.name), { withFileTypes: true })) {
        if (!child.name.startsWith('.') && (child.isDirectory() || child.isSymbolicLink())) add(`${entry.name}/${child.name}`);
      }
    } else add(entry.name);
  }
  packages.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const sha256 = createHash('sha256').update(JSON.stringify(packages)).digest('hex');
  return { packages, sha256 };
}

/** A reverse reference keeps a dependency store alive for the lifetime of a rebuild snapshot.
 * Record BEFORE linking. buildOnce atomically promotes `<consumer>.building.<pid>` to consumer;
 * retain both names so the reference survives that rename and an interrupted materialization.
 * Keeping a finished snapshot is conservative: its runtime evicts it after live job refs clear.
 */
export function recordNodeModulesConsumer(storeDir, into, { live = false, staging, backup, requestedRef, publish = () => {} } = {}) {
  return withNodeModulesStoreLock(storeDir, () => {
    // Eviction may have won the lock after the caller's integrity check. Refuse a deleted or
    // partly thawed source instead of publishing a reference and then creating a dangling link.
    if (!live && hasQuarantinedNodeModulesStore(storeDir)) {
      throw new Error('consumer source is quarantined');
    }
    const modules = statSync(join(storeDir, 'node_modules'));
    if (!modules.isDirectory() || (!live && modules.mode & 0o222) || !existsSync(join(storeDir, COMPLETE_MARKER))) {
      throw Object.assign(new Error('consumer source no longer complete and read-only'), { code: 'ENODEMODULESSOURCE' });
    }
    const building = resolve(into);
    const consumer = building.replace(/\.building\.\d+$/, '');
    const refs = join(storeDir, CONSUMER_REFS);
    try { mkdirSync(refs); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    const key = createHash('sha256').update(`${live ? 'live:' : ''}${consumer}`).digest('hex');
    const path = join(refs, `${key}.json`);
    const tmp = `${path}.${process.pid}.tmp`;
    const ref = nodeModulesRef(basename(storeDir));
    writeFileSync(tmp, JSON.stringify({ ref, refs: [...new Set([ref, requestedRef].filter(Boolean))], consumer, building, live, staging, backup }));
    renameSync(tmp, path);
    // Live references inspect link targets, so publish the staging link before releasing the lock.
    // The atomic staging -> live rename is then covered by the same reference in every evictor.
    publish();
  });
}

function hasNodeModulesConsumer(storeDir, log, readFile, key = basename(storeDir)) {
  const refs = join(storeDir, CONSUMER_REFS);
  try {
    let names;
    try { names = readdirSync(refs); } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
    for (const name of names) {
      // A pending write or unknown record is not evidence that the store is unreferenced.
      if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error('incomplete consumer reference');
      const data = JSON.parse(readFile(join(refs, name), 'utf8'));
      if (data.ref !== nodeModulesRef(key) || !isAbsolute(data.consumer ?? '') || !isAbsolute(data.building ?? '')) {
        throw new Error('invalid consumer reference');
      }
      if (data.live === true) {
        for (const path of [data.staging, join(data.consumer, 'node_modules'), data.backup].filter(Boolean)) {
          if (!isAbsolute(path)) throw new Error('invalid live link reference');
          try {
            if (lstatSync(path).isSymbolicLink() && realpathSync(path) === realpathSync(join(storeDir, 'node_modules'))) return true;
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            // Missing live link can be the interval between swap renames. Keep the store closed.
            if (path === join(data.consumer, 'node_modules') && existsSync(data.consumer)) return true;
          }
        }
        continue;
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
 * temp dir from a killed build is removed first; a finished `dir` is reused only if accepted.
 */
function buildOnce(dir, materialize, reusable = () => true) {
  if (existsSync(join(dir, COMPLETE_MARKER)) && reusable(dir)) return dir;
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
    if (existsSync(join(dir, COMPLETE_MARKER)) && reusable(dir)) return dir; // a concurrent builder won the rename
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

/** Aliases carry no independent integrity: always check the resolved store's original evidence. */
function validateNodeModulesAlias(dir, key) {
  const modules = join(dir, 'node_modules');
  if (!lstatSync(modules).isSymbolicLink()) return;
  const source = realpathSync(modules);
  const store = dirname(source);
  if (hasQuarantinedNodeModulesStore(store)
    || lstatSync(join(store, NODE_MODULES_UNSAFE_FILE), { throwIfNoEntry: false })
    || !readFileSync(join(store, COMPLETE_MARKER), 'utf8').trim()
    || lockfileKey(readFileSync(join(store, 'package-lock.json'), 'utf8')) !== key) {
    throw new Error('cached dependency alias target rejected');
  }
  const hash = readFileSync(join(store, NODE_MODULES_HASH_FILE), 'utf8').trim();
  const actual = createHash('sha256').update(readFileSync(join(source, '.package-lock.json'))).digest('hex');
  const recorded = JSON.parse(readFileSync(join(store, NODE_MODULES_MANIFEST_FILE), 'utf8'));
  const packages = nodeModulesPackageManifest(source);
  const tree = nodeModulesTreeEvidence(source);
  if (!/^[a-f0-9]{64}$/.test(hash) || hash !== actual
    || recorded.sha256 !== packages.sha256
    || JSON.stringify(recorded.packages) !== JSON.stringify(packages.packages)
    || recorded.entryCount !== tree.entryCount || recorded.treeSha256 !== tree.treeSha256) {
    throw new Error('cached dependency alias integrity mismatch');
  }
}

/**
 * The `node_modules` store for the lockfile in `sourceDir`, built on first use.
 * Installers receive `{ forcePrivate: true }` after rejecting a cached alias; rebuild installers
 * must install from the pinned inputs instead of linking or copying the rejected live target.
 * @param {{jobsDir: string, sourceDir: string, install?: (into: string, options?: {forcePrivate: boolean}) => void}} o
 * @returns {{key: string, dir: string}} Physical store key (a fresh generation after quarantine).
 */
export function ensureNodeModulesStore({ jobsDir, sourceDir, install = npmCiInstaller(),
  readFile = readFileSync, writeFile = writeFileSync, freeze = setNodeModulesWritable,
  packageManifest = nodeModulesPackageManifest, treeEvidence = nodeModulesTreeEvidence }) {
  const lock = readFileSync(join(sourceDir, 'package-lock.json'), 'utf8');
  const key = lockfileKey(lock);
  const dir = nodeModulesStoreDir(jobsDir, key);
  let forcePrivate = false;
  mkdirSync(join(snapshotsRoot(jobsDir), 'node-modules'), { recursive: true });
  buildOnce(dir, (into) => {
    copyFileSync(join(sourceDir, 'package.json'), join(into, 'package.json'));
    copyFileSync(join(sourceDir, 'package-lock.json'), join(into, 'package-lock.json'));
    if (forcePrivate) install(into, { forcePrivate: true });
    else install(into);
    // Cheap mutation evidence from npm's hidden lock, not a recursive package-content audit.
    // Missing/unreadable evidence leaves this store copy-only for rebuilds.
    // Some injected installers and npm configurations produce no hidden lock: do not invent evidence.
    let phase = 'hash';
    try {
      const hash = createHash('sha256').update(readFile(join(into, 'node_modules', '.package-lock.json'))).digest('hex');
      writeFile(join(into, NODE_MODULES_HASH_FILE), `${hash}\n`);
      const modules = join(into, 'node_modules');
      phase = 'manifest';
      const packages = packageManifest(modules, { requireReadonly: false });
      // Fingerprint the final read-only modes. Hashing before chmod would reject every reuse.
      phase = 'chmod';
      freeze(modules, false);
      phase = 'tree';
      const manifest = {
        ...packages,
        ...treeEvidence(modules),
      };
      phase = 'manifest-write';
      writeFile(join(into, NODE_MODULES_MANIFEST_FILE), `${JSON.stringify(manifest)}\n`);
    } catch (error) {
      // buildOnce writes .snapshot-complete only after this marker is durable. If writing the
      // marker itself fails, abort the build rather than publish an unmarked, unverified store.
      const reason = String(error?.message ?? error).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1000);
      writeFile(join(into, NODE_MODULES_UNSAFE_FILE), `${JSON.stringify({ phase, reason, code: error?.code ?? null })}\n`);
    }
    // Never re-freeze reused stores or regenerate their evidence: mutation must fail the guard,
    // not silently regain trust. Installs lacking the hidden lock never reach the freeze above.
  }, (cached) => {
    try { validateNodeModulesAlias(cached, key); return true; }
    catch { forcePrivate = true; return false; }
  });
  rmSync(quarantineNotice(dir), { force: true });
  return { key: basename(dir), dir };
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
    if (sub === 'node-modules' && existsSync(dir)) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('.quarantined-')) {
          const key = /^\.quarantined-\d+-\d+-(.+)$/.exec(entry.name)?.[1];
          if (!key || (!existsSync(join(dir, key)) && refs.has(nodeModulesRef(key)))) continue;
          try {
            withLock(consumerLockPath(join(dir, key)), () => {
              const storeDir = join(dir, entry.name);
              if (hasNodeModulesConsumer(storeDir, log, readFile, key)) return;
              if (!dryRun) removeStore(storeDir);
              evicted.push(`quarantine:${entry.name}`);
            }, CONSUMER_LOCK_OPTIONS);
          } catch {
            log(`snapshot eviction: retaining quarantine ${entry.name}; consumer protection unavailable`);
          }
        }
      }
    }
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
