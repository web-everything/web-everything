/** Maintain only the explicitly owned, disposable origin/main guard clone.
 * Sync is the only exclusive holder of `<clone>.guard-lock`, a file holding
 * `<pid> <start-ms> <nonce>` and published with one hard link (an atomic create).
 * It fetches into a private ref BEFORE taking the lock, so the lock covers only the local
 * update-ref/reset/clean. After taking the lock it waits a bounded time for live hook leases
 * in `<clone>.guard-readers` to drain, and refuses if they do not. Records whose owner process
 * has exited (pid gone, or reused by a process with another start time) are reclaimed; reclaim
 * itself is serialised behind `<clone>.guard-lock.reclaim`, so a moved-aside lock is never live.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

// Bootstrap uses only built-ins so a concurrent reset cannot rewrite a lock helper during
// module loading. lockWaitMs, pause, processStart, alive and holderAlive match run-pinned-guard.mjs
// (a test keeps the copies identical).
const MAX_WAIT_MS = 20_000;
/** WE_GUARD_LOCK_WAIT_MS may only shorten the wait (tests); it can never lengthen it. */
export function lockWaitMs() {
  const value = Number(process.env.WE_GUARD_LOCK_WAIT_MS);
  return process.env.WE_GUARD_LOCK_WAIT_MS !== undefined && Number.isFinite(value) && value >= 0
    ? Math.min(value, MAX_WAIT_MS) : MAX_WAIT_MS;
}
const MAX_LISTING_BYTES = 256 * 1024 * 1024;
/** WE_GUARD_LISTING_MAX_BYTES may only shorten the tracked-file listing bound (tests). */
function listingMaxBytes() {
  const value = Number(process.env.WE_GUARD_LISTING_MAX_BYTES);
  return process.env.WE_GUARD_LISTING_MAX_BYTES !== undefined && Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_LISTING_BYTES) : MAX_LISTING_BYTES;
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

/** Wait for live hook leases to drain, pruning leases of exited processes. */
export function drainLeases(readers) {
  mkdirSync(readers, { recursive: true });
  if (!lstatSync(readers).isDirectory()) throw new Error(`${readers} must be a real directory`);
  const waitMs = lockWaitMs();
  const deadline = Date.now() + waitMs;
  let announced = false;
  for (;;) {
    const live = [];
    for (const name of readdirSync(readers)) {
      // Launchers write only <pid>-<hex> leases; anything else (e.g. .DS_Store) is not a lease.
      const match = /^(\d+)-[0-9a-f]+$/.exec(name);
      if (!match) continue;
      let text;
      try { text = readFileSync(join(readers, name), 'utf8').trim(); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      // A lease still being written has no start time yet; judge it by pid alone.
      if (alive(Number(match[1]), text ? Number(text) : NaN)) live.push(name);
      else rmSync(join(readers, name), { force: true });
    }
    if (!live.length) return;
    if (Date.now() >= deadline) {
      throw new Error(`${live.length} guard hook(s) still running (leases in ${readers}); retry sync`);
    }
    if (!announced) {
      // The effective bound, printed so tests can pin the cap without waiting it out.
      process.stderr.write(`Guard clone sync: waiting up to ${waitMs}ms for ${live.length} guard hook(s) to finish\n`);
      announced = true;
    }
    pause(50);
  }
}

// Run only as a CLI; tests import the lock helpers above without side effects.
const invokedAsCli = (() => {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (invokedAsCli) main();

function main() {
let lock;
const startedAt = Date.now();
let lockStartedAt;
let fetchMs = 0;
const owner = `${process.pid} ${STARTED} ${randomBytes(6).toString('hex')}\n`;
try {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => !arg.startsWith('--origin=') || !arg.slice(9))) {
    throw new Error('usage: sync-guard-clone.mjs [--origin=<url>]');
  }
  // Inherited Git overrides must never redirect a destructive command elsewhere.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const gitBounded = (maxBuffer, cwd, ...argv) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...argv], {
    cwd, env, encoding: 'utf8', timeout: 120_000, maxBuffer,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const gitRaw = (cwd, ...argv) => gitBounded(1024 * 1024, cwd, ...argv);
  const git = (cwd, ...argv) => gitRaw(cwd, ...argv).trim();
  // The tracked-file listing grows with the repository (about 1 MB at 16k files), so it has
  // its own, far larger bound. Past it sync refuses by name instead of trusting a cut-off list.
  const listingMax = listingMaxBytes();
  const ordinaryIndexEntries = () => {
    let raw;
    try { raw = gitBounded(listingMax, clone, 'ls-files', '-v', '-z'); }
    catch (error) {
      if (error.code === 'ENOBUFS') {
        throw new Error(`tracked-file listing is larger than ${listingMax} bytes; refusing to judge a partial index`);
      }
      throw error;
    }
    const entries = raw.split('\0');
    return entries.pop() === '' && entries.every(entry => entry.startsWith('H '));
  };
  const pristine = () => {
    if (!ordinaryIndexEntries()) return false;
    if (git(clone, 'status', '--porcelain', '--untracked-files=all', '--ignored')) return false;
    git(clone, 'diff-index', '--quiet', 'HEAD', '--');
    return true;
  };
  const origin = args[0]?.slice(9) || git(process.cwd(), 'config', '--get', 'remote.origin.url');
  if (!origin || origin.startsWith('-')) throw new Error('expected a non-option origin URL');
  const clone = resolve(process.env.WE_GUARD_CLONE || join(homedir(), 'workspace/.guard-main'));
  mkdirSync(dirname(clone), { recursive: true });
  if (realpathSync(dirname(clone)) !== dirname(clone)) throw new Error('clone parent must not contain symlinks');
  const checkReadOnly = path => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.mode & 0o222) throw new Error('writable tree');
    if (stat.isDirectory()) for (const name of readdirSync(path)) {
      if (path !== clone || name !== '.git') checkReadOnly(join(path, name));
    }
  };
  // Read complete effective configuration, including inherited values. A command error,
  // truncated output or ambiguous encoding refuses sync rather than trusting cached stats.
  const statDefaults = new Map([
    ['core.trustctime', 'true'], ['core.checkstat', 'default'],
    ['core.fsmonitor', 'false'], ['core.untrackedcache', 'false'],
    ['core.ignorestat', 'false'], ['core.assumeunchanged', 'false'],
  ]);
  const weakSettings = () => {
    const raw = gitRaw(clone, 'config', '--null', '--list');
    const entries = raw.split('\0');
    if (entries.pop() !== '' || raw.includes('\ufffd')) throw new Error('unreadable stat-check configuration');
    const weak = new Set();
    for (const entry of entries) {
      const separator = entry.indexOf('\n');
      const key = (separator < 0 ? entry : entry.slice(0, separator)).toLowerCase();
      if (!key) throw new Error('incomplete stat-check configuration');
      const value = separator < 0 ? '' : entry.slice(separator + 1).toLowerCase();
      if (statDefaults.has(key) && value !== statDefaults.get(key)) weak.add(key);
    }
    return weak;
  };
  const hardenStatChecks = () => {
    const weak = weakSettings();
    for (const key of weak) {
      if (key === 'core.trustctime') continue;
      try { git(clone, 'config', '--local', '--unset-all', key); }
      catch (error) { if (error.status !== 5) throw error; } // 5 means no local value.
    }
    git(clone, 'config', '--local', '--replace-all', 'core.trustctime', 'true');
    // Unsetting a local value may expose an inherited weakening value: override it.
    for (const key of weakSettings()) {
      git(clone, 'config', '--local', '--replace-all', key, statDefaults.get(key));
    }
    if (weak.size) {
      plan = undefined;
      process.stderr.write('Guard clone sync: weakened stat checks; using whole-tree repair.\n');
    }
  };
  const lockPath = `${clone}.guard-lock`;
  const fresh = !existsSync(clone);
  let plan;
  if (!fresh) {
    if (!lstatSync(clone).isDirectory() || realpathSync(clone) !== clone ||
        !lstatSync(join(clone, '.git')).isDirectory() ||
        realpathSync(git(clone, 'rev-parse', '--show-toplevel')) !== clone) {
      throw new Error('target must be a standalone dedicated clone, without symlinks or worktree indirection');
    }
    let marker;
    try { marker = git(clone, 'config', '--local', '--get', 'we.guardClone'); } catch { /* Missing ownership is refused below. */ }
    if (marker !== clone) {
      throw new Error('target is not an owned dedicated clone; move it aside and rerun sync to create one');
    }
    if (git(clone, 'config', '--get-all', 'remote.origin.url') !== origin ||
        git(clone, 'config', '--get-all', 'remote.origin.fetch') !== '+refs/heads/main:refs/remotes/origin/main' ||
        git(clone, 'symbolic-ref', '--short', 'HEAD') !== 'main') {
      throw new Error('dedicated clone has a different origin or is not tracking main only');
    }
    busyIfLive(lockPath);
    // Fetch without the lock: only a private ref changes (an empty --refmap keeps
    // origin/main and FETCH_HEAD untouched), so running guards see no difference.
    const fetchStartedAt = Date.now();
    git(clone, 'fetch', '--no-tags', '--no-write-fetch-head', '--refmap=', 'origin', '+refs/heads/main:refs/we-guard/incoming');
    fetchMs = Date.now() - fetchStartedAt;
    try {
      const head = git(clone, 'rev-parse', '--verify', 'HEAD^{commit}');
      const incoming = git(clone, 'rev-parse', '--verify', 'refs/we-guard/incoming^{commit}');
      const raw = gitRaw(clone, 'diff', '--name-only', '-z', '--no-renames', head, incoming);
      // Bounded command output, complete NUL framing and lossless UTF-8 are required.
      // Anything uncertain takes the original whole-tree repair path.
      if (raw.includes('\ufffd') || (raw && !raw.endsWith('\0'))) throw new Error('ambiguous diff');
      const paths = new Set([clone]);
      for (const name of raw ? raw.slice(0, -1).split('\0') : []) {
        if (!name || name.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
          throw new Error('ambiguous path');
        }
        let path = join(clone, name);
        while (path !== clone) { paths.add(path); path = dirname(path); }
      }
      // Read-only preparation stays outside the exclusive lock. A writable tree
      // needs the original repair, even when Git reports no content differences.
      checkReadOnly(clone);
      plan = { head, incoming, paths: [...paths].sort((a, b) => a.length - b.length) };
    } catch {
      process.stderr.write('Guard clone sync: preparation uncertain; using whole-tree repair.\n');
    }
  }
  acquireLock(lockPath, owner);
  lock = lockPath;
  lockStartedAt = Date.now();
  drainLeases(`${clone}.guard-readers`);
  if (fresh) {
    git(process.cwd(), 'clone', '--single-branch', '--branch', 'main', '--no-tags', '--', origin, clone);
    git(clone, 'config', '--local', 'we.guardClone', clone);
    hardenStatChecks();
    // A fresh clone has no FETCH_HEAD; publish the same sync evidence as refreshes.
    const fetchStartedAt = Date.now();
    git(clone, 'fetch', 'origin', 'main');
    fetchMs = Date.now() - fetchStartedAt;
    // Main may have advanced between clone and fetch; apply the fetched revision.
    git(clone, 'reset', '--hard', 'origin/main');
  } else {
    hardenStatChecks();
    // Another sync may have completed during preparation. Never use its stale plan.
    try {
      if (!plan || git(clone, 'rev-parse', 'HEAD') !== plan.head ||
          git(clone, 'rev-parse', 'refs/we-guard/incoming') !== plan.incoming || !pristine()) plan = undefined;
      if (plan) checkReadOnly(clone);
    } catch { plan = undefined; }
    const chmodPaths = writable => {
      // Inspect every path before changing any: plan.paths is shortest first, so a symlinked
      // ancestor is seen before the paths beneath it, which lstat would resolve through the
      // link to a file outside the clone.
      const found = [];
      for (const path of plan.paths) {
        let stat;
        try { stat = lstatSync(path); }
        catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error; }
        if (stat.isSymbolicLink()) throw new Error('symlink requires whole-tree repair');
        found.push([path, stat]);
      }
      for (const [path, stat] of writable ? found : found.reverse()) {
        chmodSync(path, writable ? stat.mode | 0o200 : stat.mode & ~0o222);
      }
    };
    const repair = selective => {
      if (selective) {
        chmodPaths(true);
        const metadata = join(clone, '.git');
        chmodSync(metadata, lstatSync(metadata).mode | 0o200);
      }
      else execFileSync('chmod', ['-R', 'u+w', clone]);
      git(clone, 'update-ref', 'refs/remotes/origin/main', 'refs/we-guard/incoming');
      if (!selective) {
        // Preserve refusal of hidden entries before discarding their flags. Neither
        // reset --hard nor checkout-index --force guarantees a rewrite on a stat hit.
        if (!ordinaryIndexEntries()) throw new Error('guard clone is not pristine: hidden index entries');
        // This owned, disposable clone is exclusively locked and readers have drained.
        // Rebuild from the fetched tree without any cached worktree stat evidence.
        rmSync(join(clone, '.git/index'), { force: true });
      }
      git(clone, 'reset', '--hard', 'origin/main');
      if (!selective) git(clone, 'checkout-index', '--all', '--force');
      git(clone, 'clean', '-fdx');
      if (selective) chmodPaths(false);
    };
    if (plan && plan.head === plan.incoming) {
      git(clone, 'update-ref', 'refs/remotes/origin/main', plan.incoming);
    } else if (plan) {
      try { repair(true); }
      catch {
        process.stderr.write('Guard clone sync: selective repair uncertain; using whole-tree repair.\n');
        plan = undefined;
        repair(false);
      }
    } else repair(false);
  }
  // Fresh clones and conservative repairs retain the original whole-tree protection.
  if (fresh || !plan) {
    for (const name of readdirSync(clone)) {
      if (name !== '.git') execFileSync('chmod', ['-R', 'a-w', join(clone, name)]);
    }
    chmodSync(clone, lstatSync(clone).mode & ~0o222);
  }
  // Only modified file ctimes need a stat refresh; unchanged syncs leave them alone.
  if (!fresh && (!plan || plan.head !== plan.incoming)) git(clone, 'update-index', '-q', '--refresh');
  if (!pristine() || git(clone, 'rev-parse', 'HEAD') !== git(clone, 'rev-parse', 'refs/remotes/origin/main')) {
    throw new Error('guard clone is not pristine after sync');
  }
  // Record every successful sync, including an unchanged origin/main.
  const fetchHead = join(clone, '.git/FETCH_HEAD');
  closeSync(openSync(fetchHead, 'a'));
  const syncedAt = new Date();
  utimesSync(fetchHead, syncedAt, syncedAt);
  process.stdout.write('Guard clone synchronized to origin/main.\n');
} catch (error) {
  process.stderr.write(`Guard clone sync refused/failed: ${error.message}\n`);
  process.exitCode = 2;
} finally {
  // Release only a lock this run still owns; nobody else can replace an existing lock file.
  try { if (lock && readRecord(lock) === owner) rmSync(lock, { force: true }); }
  catch (error) { process.stderr.write(`Guard clone sync could not release its lock: ${error.message}\n`); process.exitCode = 2; }
  if (process.env.WE_GUARD_SYNC_TIMING === '1') {
    const endedAt = Date.now();
    process.stderr.write(`guard-sync-timing lock_hold_ms=${lockStartedAt === undefined ? 0 : endedAt - lockStartedAt} fetch_ms=${fetchMs} total_ms=${endedAt - startedAt}\n`);
  }
}
}
