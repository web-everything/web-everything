/** Maintain an owned guard path L as a symlink to a complete clone in <L>.revs.
 * Only syncers take <L>.guard-lock (<pid> <start-ms> <nonce>, atomically hard-linked).
 * Readers resolve L once and never wait on this lock. Build, clean, protect and verify a
 * private revision before replacing L with one atomic symlink rename; never reset live.
 * Retain live, active readers' revisions, and the two most recent other revisions.
 * Reader records live in each revision's .git/guard-readers; children own independent records.
 * Unknown reader evidence retains the revision without waiting; reclaim dead builders' debris.
 * Collection publishes .git/guard-successor before examining leases, closing acquisition.
 * Legacy migration alone drains both old external leases and revision-local readers before
 * moving their real directory; only the syncer waits. Directory locks remain reclaimable.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

// Built-ins only: the sync lock serialises builders, independently of readers.
const MAX_WAIT_MS = 20_000;
/** WE_GUARD_LOCK_WAIT_MS may only shorten the wait (tests); it can never lengthen it. */
export function lockWaitMs() {
  const value = Number(process.env.WE_GUARD_LOCK_WAIT_MS);
  return process.env.WE_GUARD_LOCK_WAIT_MS !== undefined && Number.isFinite(value) && value >= 0
    ? Math.min(value, MAX_WAIT_MS) : MAX_WAIT_MS;
}
function pause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
const STARTED = Date.now() - Math.round(process.uptime() * 1000);
/** A process's start time in ms, or null when ps cannot say. */
export function processStart(pid) {
  try {
    const text = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    }).trim();
    const time = Date.parse(text);
    return Number.isFinite(time) ? time : null;
  } catch { return null; }
}
/** Live unless the pid is gone or now belongs to a process that started at another time.
 * Unknown evidence counts as live, so a holder is never stolen from on a guess. */
export function alive(pid, started) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (error) { if (error.code !== 'EPERM') return false; }
  if (!Number.isFinite(started) || started <= 0) return true;
  const actual = processStart(pid);
  // ps reports whole seconds; a larger gap is a different process reusing the pid.
  return actual === null || Math.abs(actual - started) < 3_000;
}
export const LEGACY = Symbol('legacy directory lock');
/** The record text, '' when absent, LEGACY for an old-protocol lock directory (no owner). */
export function readRecord(path) {
  try { return readFileSync(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return '';
    if (error.code === 'EISDIR') return LEGACY;
    throw error;
  }
}
function holderAlive(record) {
  if (typeof record !== 'string' || !record) return false;
  const [pid, started] = record.trim().split(' ').map(Number);
  return alive(pid, started);
}
/** An earlier revision's `<lock>/owner` record is `<pid> <hex nonce>`, with no start time, so
 * its second field is never read as one. Its owner wrote it after starting: a live pid whose
 * process started after the file was written is a reuse. Unknown start evidence counts as live. */
export function legacyOwnerAlive(ownerPath) {
  const pid = Number(readFileSync(ownerPath, 'utf8').trim().split(' ')[0]);
  if (!alive(pid, NaN)) return false;
  const started = processStart(pid);
  return started === null || started <= lstatSync(ownerPath).mtimeMs + 3_000;
}
const nonce = () => `${process.pid}-${randomBytes(6).toString('hex')}`;

/** Create `path` holding `record`, atomically; false when it already exists. */
function publish(path, record) {
  const staging = `${path}.new-${nonce()}`;
  writeFileSync(staging, record, { flag: 'wx' });
  try { linkSync(staging, path); return true; }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  finally { rmSync(staging, { force: true }); }
}
/** Remove staging/aside debris left by a sync that crashed mid-publish or mid-reclaim. */
function sweepDebris(lockPath) {
  const debris = new RegExp(`^${basename(lockPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.reclaim)?\\.(?:new|stale)-(\\d+)-[0-9a-f]+$`);
  for (const name of readdirSync(dirname(lockPath))) {
    const match = debris.exec(name);
    if (match && !alive(Number(match[1]))) rmSync(join(dirname(lockPath), name), { recursive: true, force: true });
  }
}
function busyIfLive(lockPath) {
  const current = readRecord(lockPath);
  if (holderAlive(current)) throw new Error('guard clone is busy: another sync is running; retry sync');
  return current;
}
/** Remove an abandoned lock. Only an existing record judged dead is ever removed: an absent
 * lock is left for the caller to publish, because a publisher could create a live lock at any
 * moment after an absent read. An existing record cannot change hands before the move:
 * publishers only create an absent path, reclaimers are serialised, and its owner has exited.
 * `beforeRemove` is a test seam for that window. */
export function reclaim(lockPath, judged, record, { beforeRemove = () => {} } = {}) {
  if (!judged) return;
  const mutex = `${lockPath}.reclaim`;
  if (!publish(mutex, record)) {
    if (holderAlive(readRecord(mutex))) throw new Error('guard clone is busy: another sync is reclaiming an abandoned lock; retry sync');
    throw new Error(`an abandoned reclaim marker blocks sync; confirm no sync is running, then remove ${mutex}`);
  }
  try {
    if (readRecord(lockPath) !== judged) return;
    if (judged === LEGACY) {
      // Directory locks: the mkdir lock (empty) and an earlier revision of this lock, which
      // kept its record in `<lock>/owner`. A live owner there still holds the clone.
      const ownerFile = join(lockPath, 'owner');
      let inner = false;
      try { inner = legacyOwnerAlive(ownerFile); }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
      if (inner) throw new Error('guard clone is busy: another sync is running; retry sync');
      beforeRemove();
      try { rmSync(ownerFile, { force: true }); } catch (error) { if (error.code !== 'ENOTDIR') throw error; }
      // rmdir removes only a directory, never a lock file published meanwhile.
      try { rmdirSync(lockPath); }
      catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
        if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') {
          throw new Error(`an abandoned lock directory holds unexpected entries; confirm no sync is running, then remove ${lockPath}`);
        }
        throw error;
      }
      return;
    }
    beforeRemove();
    const aside = `${lockPath}.stale-${nonce()}`;
    try { renameSync(lockPath, aside); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (readRecord(aside) !== judged) {
      // Defensive: put a record that is not the judged one back, never over a newer lock.
      try { linkSync(aside, lockPath); } catch { /* a newer lock exists; keep it */ }
      rmSync(aside, { force: true });
      throw new Error('guard clone is busy: the sync lock changed hands during reclaim; retry sync');
    }
    rmSync(aside, { force: true });
  } finally {
    rmSync(mutex, { force: true });
  }
}
export function acquireLock(lockPath, record) {
  sweepDebris(lockPath);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (publish(lockPath, record)) return;
    reclaim(lockPath, busyIfLive(lockPath), record);
  }
  throw new Error('guard clone is busy: the sync lock is contended; retry sync');
}

/** Unknown reader evidence preserves the revision: collection must never break a guard.
 * Readers and children publish their own pid/start records without taking the sync lock.
 * No drain or wait: sync can always publish a new revision while these records remain live. */
export function revisionInUse(revision) {
  const readers = join(revision, '.git/guard-readers');
  let names;
  try { names = readdirSync(readers); }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    process.stderr.write('Guard clone sync: retaining revision with unreadable reader evidence; inspect .git/guard-readers before manual cleanup\n');
    return true;
  }
  let active = false;
  for (const name of names) {
    try {
      const record = readFileSync(join(readers, name), 'utf8');
      const match = /^(\d+) (\d+)\n?$/.exec(record);
      // Includes partially published records: never guess that an unknown reader is dead.
      if (!match || alive(Number(match[1]), Number(match[2]))) active = true;
      else rmSync(join(readers, name), { force: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue; // A reader exited and removed its record.
      process.stderr.write('Guard clone sync: retaining revision with unreadable reader record; inspect .git/guard-readers before manual cleanup\n');
      active = true;
    }
  }
  return active;
}

/** Earlier launchers publish <pid>-<nonce> files containing just their start time. */
function legacyReadersInUse(clone) {
  const readers = `${clone}.guard-readers`;
  let names;
  try { names = readdirSync(readers); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  let active = false;
  for (const name of names) {
    const match = /^(\d+)-[0-9a-f]+$/.exec(name);
    if (!match) continue;
    try {
      const text = readFileSync(join(readers, name), 'utf8').trim();
      if (alive(Number(match[1]), text ? Number(text) : NaN)) active = true;
      else rmSync(join(readers, name), { force: true });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return active;
}
function drainLegacyReaders(clone) {
  const deadline = Date.now() + lockWaitMs();
  let announced = false;
  while (legacyReadersInUse(clone) || revisionInUse(clone)) {
    if (Date.now() >= deadline) throw new Error('legacy guard readers still running; retry sync after they exit');
    if (!announced) {
      process.stderr.write(`Guard clone sync: waiting up to ${lockWaitMs()}ms for legacy guard readers before migration\n`);
      announced = true;
    }
    pause(50);
  }
}
/** Atomic gate publication precedes scanning leases. Registered readers remain protected;
 * late readers see the successor and revalidate there, even if the old path is gone. */
function closeRegistration(revision, successor) {
  try { symlinkSync(successor, join(revision, '.git/guard-successor'), 'dir'); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

// Run only as a CLI; tests import the lock helpers above without side effects.
const invokedAsCli = (() => {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (invokedAsCli) main();

function main() {
let lock;
let candidate;
let swap;
let migrationGate;
const owner = `${process.pid} ${STARTED} ${randomBytes(6).toString('hex')}\n`;
try {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => !arg.startsWith('--origin=') || !arg.slice(9))) {
    throw new Error('usage: sync-guard-clone.mjs [--origin=<url>]');
  }
  // Inherited Git overrides must never redirect a destructive command elsewhere.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const git = (cwd, ...argv) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...argv], {
    cwd, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const origin = args[0]?.slice(9) || git(process.cwd(), 'config', '--get', 'remote.origin.url');
  if (!origin || origin.startsWith('-')) throw new Error('expected a non-option origin URL');
  const clone = resolve(process.env.WE_GUARD_CLONE || join(homedir(), 'workspace/.guard-main'));
  mkdirSync(dirname(clone), { recursive: true });
  if (realpathSync(dirname(clone)) !== dirname(clone)) throw new Error('clone parent must not contain symlinks');
  const lockPath = `${clone}.guard-lock`;
  const revisions = `${clone}.revs`;
  // Validate and inspect L only while holding the syncers' lock.
  acquireLock(lockPath, owner);
  lock = lockPath;
  let live;
  let legacy = false;
  let target;
  try { target = lstatSync(clone); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (target) {
    live = realpathSync(clone);
    legacy = target.isDirectory() && live === clone;
    if ((!legacy && (!target.isSymbolicLink() || dirname(live) !== revisions)) ||
        !lstatSync(live).isDirectory() || !lstatSync(join(live, '.git')).isDirectory() ||
        realpathSync(git(live, 'rev-parse', '--show-toplevel')) !== live) {
      throw new Error('target must be a standalone dedicated clone inside its revision root, or a legacy real directory');
    }
    let marker;
    try { marker = git(live, 'config', '--local', '--get', 'we.guardClone'); } catch { /* Refuse missing ownership. */ }
    if (marker !== clone) {
      throw new Error('target is not an owned dedicated clone; move it aside and rerun sync to create one');
    }
    if (git(live, 'config', '--get-all', 'remote.origin.url') !== origin ||
        git(live, 'config', '--get-all', 'remote.origin.fetch') !== '+refs/heads/main:refs/remotes/origin/main' ||
        git(live, 'symbolic-ref', '--short', 'HEAD') !== 'main') {
      throw new Error('dedicated clone has a different origin or is not tracking main only');
    }
  }
  mkdirSync(revisions, { recursive: true });
  if (!lstatSync(revisions).isDirectory() || realpathSync(revisions) !== revisions) {
    throw new Error('revision root must be a real directory without symlinks');
  }
  const ownedRevision = path => {
    // Missing or unreadable ownership is not permission to collect.
    try {
      return dirname(path) === revisions && lstatSync(path).isDirectory() &&
        realpathSync(path) === path && lstatSync(join(path, '.git')).isDirectory() &&
        git(path, 'config', '--local', '--get', 'we.guardClone') === clone;
    } catch { return false; }
  };
  const removeRevision = path => {
    if (lstatSync(path).isDirectory()) execFileSync('chmod', ['-R', 'u+w', path], { timeout: 30_000 });
    rmSync(path, { recursive: true, force: true });
  };
  for (const name of readdirSync(dirname(clone))) {
    const prefix = `${basename(clone)}.swap-`;
    if (!name.startsWith(prefix)) continue;
    const match = /^(\d+)-[0-9a-f]+$/.exec(name.slice(prefix.length));
    if (match && !alive(Number(match[1]))) rmSync(join(dirname(clone), name), { force: true });
  }
  for (const name of readdirSync(revisions)) {
    const path = join(revisions, name);
    const match = /^(\d+)-[0-9a-f]+$/.exec(name);
    if (path !== live && match && !alive(Number(match[1])) && ownedRevision(path) &&
        !existsSync(join(path, '.git/we-guard-complete')) && !revisionInUse(path)) removeRevision(path);
  }
  const id = nonce();
  candidate = join(revisions, id);
  // No alternates or hard-linked objects: every revision remains independently disposable.
  git(process.cwd(), 'clone', '--no-hardlinks', '--single-branch', '--branch', 'main', '--no-tags', '--', live || origin, candidate);
  git(candidate, 'remote', 'set-url', 'origin', origin);
  git(candidate, 'config', '--local', 'we.guardClone', clone);
  git(candidate, 'fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  git(candidate, 'reset', '--hard', 'origin/main');
  git(candidate, 'clean', '-fdx');
  // Metadata stays writable; protect the working tree before refreshing index stat data.
  for (const name of readdirSync(candidate)) {
    if (name !== '.git') execFileSync('chmod', ['-R', 'a-w', join(candidate, name)], { timeout: 30_000 });
  }
  chmodSync(candidate, lstatSync(candidate).mode & ~0o222);
  git(candidate, 'update-index', '-q', '--refresh');
  const fetchHead = join(candidate, '.git/FETCH_HEAD');
  closeSync(openSync(fetchHead, 'a'));
  const syncedAt = new Date();
  utimesSync(fetchHead, syncedAt, syncedAt);

  // Same fail-closed Git evidence as the reader, including ignored files and hidden flags.
  git(candidate, '--git-dir', join(candidate, '.git'), 'rev-parse', '--verify', 'HEAD^{commit}');
  const entries = git(candidate, 'ls-files', '-v', '-z').split('\0');
  if (entries.at(-1) !== '' || entries.slice(0, -1).some(entry => !entry.startsWith('H ')) ||
      git(candidate, 'status', '--porcelain', '--untracked-files=all', '--ignored')) {
    throw new Error('candidate guard clone is not pristine');
  }
  git(candidate, 'diff-index', '--quiet', 'HEAD', '--');
  if (git(candidate, 'rev-parse', 'HEAD') !== git(candidate, 'rev-parse', 'refs/remotes/origin/main')) {
    throw new Error('candidate guard clone HEAD differs from origin/main');
  }
  if (git(candidate, 'config', '--get-all', 'remote.origin.url') !== origin ||
      (process.env.WE_GUARD_ORIGIN !== undefined && origin !== process.env.WE_GUARD_ORIGIN)) {
    throw new Error('candidate guard clone origin differs from expected origin');
  }
  const fetched = lstatSync(fetchHead);
  if (!fetched.isFile() || !Number.isFinite(fetched.mtimeMs) || fetched.mtimeMs <= 0 ||
      fetched.mtimeMs > Date.now() || Date.now() - fetched.mtimeMs > 24 * 60 * 60 * 1000) {
    throw new Error('cannot determine candidate clone sync freshness');
  }
  writeFileSync(join(candidate, '.git/we-guard-complete'), 'verified\n');
  swap = `${clone}.swap-${id}`;
  symlinkSync(candidate, swap, 'dir');
  if (legacy) {
    // Existing legacy guards keep using L until they exit, including their late imports.
    // Drain before closing acquisition so readers keep running while only sync waits.
    drainLegacyReaders(clone);
    migrationGate = join(clone, '.git/guard-successor');
    closeRegistration(clone, candidate);
    // Cover a reader that registered between the drain and gate publication. Never move
    // it; late registrants now use the complete candidate instead of the legacy path.
    if (legacyReadersInUse(clone) || revisionInUse(clone)) {
      throw new Error('legacy guard reader acquired during migration; retry sync after it exits');
    }
    // First migration alone has a tiny gap: rename cannot replace a real directory with a link.
    live = join(revisions, `legacy-${id}`);
    renameSync(clone, live);
    try { renameSync(swap, clone); }
    catch (error) { renameSync(live, clone); throw error; }
    migrationGate = undefined;
  } else renameSync(swap, clone);
  swap = undefined;
  const published = candidate;
  candidate = undefined;
  const others = readdirSync(revisions).map(name => join(revisions, name))
    .filter(path => path !== published && ownedRevision(path))
    .sort((a, b) => lstatSync(b).mtimeMs - lstatSync(a).mtimeMs);
  for (const path of others.slice(2)) {
    closeRegistration(path, published);
    if (!revisionInUse(path)) removeRevision(path);
  }
  process.stdout.write('Guard clone synchronized to origin/main.\n');
} catch (error) {
  process.stderr.write(`Guard clone sync refused/failed: ${error.message}\n`);
  process.exitCode = 2;
} finally {
  try {
    if (migrationGate) rmSync(migrationGate, { force: true });
    if (swap) rmSync(swap, { force: true });
    // A migration successor may already have readers, even when migration itself failed.
    if (candidate && existsSync(candidate) && !revisionInUse(candidate)) {
      execFileSync('chmod', ['-R', 'u+w', candidate], { timeout: 30_000 });
      rmSync(candidate, { recursive: true, force: true });
    }
  } catch (error) {
    process.stderr.write(`Guard clone sync could not remove unpublished revision: ${error.message}\n`);
    process.exitCode = 2;
  }
  // Release only a lock this run still owns; nobody else can replace an existing lock file.
  try { if (lock && readRecord(lock) === owner) rmSync(lock, { force: true }); }
  catch (error) { process.stderr.write(`Guard clone sync could not release its lock: ${error.message}\n`); process.exitCode = 2; }
}
}
