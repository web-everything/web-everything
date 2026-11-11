/** Maintain only the explicitly owned, disposable origin/main guard clone.
 * Sync is the only exclusive holder of `<clone>.guard-lock` (an `owner` record names its pid).
 * After taking it, sync waits a bounded time for live hook leases in `<clone>.guard-readers`
 * to drain, and refuses if they do not. Records whose owner process has exited are reclaimed.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Bootstrap uses only built-ins so a concurrent reset cannot rewrite a lock helper during
// module loading. These three helpers match run-pinned-guard.mjs.
const MAX_WAIT_MS = 20_000;
/** WE_GUARD_LOCK_WAIT_MS may only shorten the wait (tests); it can never lengthen it. */
function lockWaitMs() {
  const value = Number(process.env.WE_GUARD_LOCK_WAIT_MS);
  return process.env.WE_GUARD_LOCK_WAIT_MS !== undefined && Number.isFinite(value) && value >= 0
    ? Math.min(value, MAX_WAIT_MS) : MAX_WAIT_MS;
}
function pause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
const nonce = () => `${process.pid}-${randomBytes(6).toString('hex')}`;
function readOwner(path) {
  try { return readFileSync(join(path, 'owner'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

/** Publish the lock with its owner record in one rename; reclaim it only from an exited owner. */
function acquireLock(lockPath, owner) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const staging = `${lockPath}.new-${nonce()}`;
    mkdirSync(staging);
    writeFileSync(join(staging, 'owner'), owner);
    try { renameSync(staging, lockPath); return; }
    catch (error) {
      rmSync(staging, { recursive: true, force: true });
      if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
    }
    const current = readOwner(lockPath);
    if (alive(Number(current.split(' ')[0]))) {
      throw new Error('guard clone is busy: another sync is running; retry sync');
    }
    // Move the abandoned lock aside, then confirm it is still the record judged abandoned.
    const aside = `${lockPath}.stale-${nonce()}`;
    try { renameSync(lockPath, aside); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (readOwner(aside) !== current) {
      try { renameSync(aside, lockPath); } catch { /* the new holder keeps its own lock */ }
      throw new Error('guard clone is busy: the sync lock changed hands; retry sync');
    }
    rmSync(aside, { recursive: true, force: true });
  }
  throw new Error('guard clone is busy: the sync lock is contended; retry sync');
}

/** Wait for live hook leases to drain, pruning leases of exited processes. */
function drainLeases(readers) {
  mkdirSync(readers, { recursive: true });
  if (!lstatSync(readers).isDirectory()) throw new Error(`${readers} must be a real directory`);
  const deadline = Date.now() + lockWaitMs();
  for (;;) {
    const live = [];
    for (const name of readdirSync(readers)) {
      const match = /^(\d+)-[0-9a-f]+$/.exec(name);
      // Unrecognised entries count as live, so sync refuses rather than guessing.
      if (match && !alive(Number(match[1]))) rmSync(join(readers, name), { force: true });
      else live.push(name);
    }
    if (!live.length) return;
    if (Date.now() >= deadline) {
      throw new Error(`${live.length} guard hook(s) still running (leases in ${readers}); retry sync`);
    }
    pause(50);
  }
}

let lock;
let owner;
try {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => !arg.startsWith('--origin=') || !arg.slice(9))) {
    throw new Error('usage: sync-guard-clone.mjs [--origin=<url>]');
  }
  // Inherited Git overrides must never redirect a destructive command elsewhere.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const git = (cwd, ...argv) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...argv], {
    cwd, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const origin = args[0]?.slice(9) || git(process.cwd(), 'config', '--get', 'remote.origin.url');
  if (!origin || origin.startsWith('-')) throw new Error('expected a non-option origin URL');
  const clone = resolve(process.env.WE_GUARD_CLONE || join(homedir(), 'workspace/.guard-main'));
  mkdirSync(dirname(clone), { recursive: true });
  if (realpathSync(dirname(clone)) !== dirname(clone)) throw new Error('clone parent must not contain symlinks');
  const lockPath = `${clone}.guard-lock`;
  owner = `${nonce().replace('-', ' ')}\n`;
  acquireLock(lockPath, owner);
  lock = lockPath;
  drainLeases(`${clone}.guard-readers`);
  if (!existsSync(clone)) {
    git(process.cwd(), 'clone', '--single-branch', '--branch', 'main', '--no-tags', '--', origin, clone);
    git(clone, 'config', '--local', 'we.guardClone', clone);
    // A fresh clone has no FETCH_HEAD; publish the same sync evidence as refreshes.
    git(clone, 'fetch', 'origin', 'main');
    // Main may have advanced between clone and fetch; apply the fetched revision.
    git(clone, 'reset', '--hard', 'origin/main');
  } else {
    if (!lstatSync(clone).isDirectory() || realpathSync(clone) !== clone ||
        !lstatSync(join(clone, '.git')).isDirectory() ||
        realpathSync(git(clone, 'rev-parse', '--show-toplevel')) !== clone) {
      throw new Error('target must be a standalone dedicated clone, without symlinks or worktree indirection');
    }
    let owner;
    try { owner = git(clone, 'config', '--local', '--get', 'we.guardClone'); } catch { /* Missing ownership is refused below. */ }
    if (owner !== clone) {
      throw new Error('target is not an owned dedicated clone; move it aside and rerun sync to create one');
    }
    if (git(clone, 'config', '--get-all', 'remote.origin.url') !== origin ||
        git(clone, 'config', '--get-all', 'remote.origin.fetch') !== '+refs/heads/main:refs/remotes/origin/main' ||
        git(clone, 'symbolic-ref', '--short', 'HEAD') !== 'main') {
      throw new Error('dedicated clone has a different origin or is not tracking main only');
    }
    execFileSync('chmod', ['-R', 'u+w', clone]);
    git(clone, 'fetch', 'origin', 'main');
    git(clone, 'reset', '--hard', 'origin/main');
    git(clone, 'clean', '-fdx');
  }
  // Keep metadata writable for Git; discourage working-tree edits. Integrity
  // checks in the launcher remain the defence against same-user tampering.
  for (const name of readdirSync(clone)) {
    if (name !== '.git') execFileSync('chmod', ['-R', 'a-w', join(clone, name)]);
  }
  chmodSync(clone, lstatSync(clone).mode & ~0o222);
  // Record every successful sync, including an unchanged origin/main.
  const syncedAt = new Date();
  utimesSync(join(clone, '.git/FETCH_HEAD'), syncedAt, syncedAt);
  process.stdout.write('Guard clone synchronized to origin/main.\n');
} catch (error) {
  process.stderr.write(`Guard clone sync refused/failed: ${error.message}\n`);
  process.exitCode = 2;
} finally {
  // Release only a lock this run still owns.
  try { if (lock && readOwner(lock) === owner) rmSync(lock, { recursive: true, force: true }); }
  catch (error) { process.stderr.write(`Guard clone sync could not release its lock: ${error.message}\n`); process.exitCode = 2; }
}
