/** Run guards only from the clone containing this launcher at scripts/hooks/run-pinned-guard.mjs.
 * Preserve the operated checkout as WE_HOOK_ROOT; never fetch from a hook.
 * Usage: run-pinned-guard.mjs [--stop-hook] scripts/<guard>.mjs [guard arguments...]
 *
 * Locking: hooks run in parallel (six share the Edit|Write matcher), so each launcher takes only a
 * shared lease, a `<clone>.guard-readers/<pid>-<nonce>` file holding its start time. Only sync
 * takes the exclusive `<clone>.guard-lock` file; it waits for live leases to drain before it
 * changes the clone. A launcher waits a bounded time for a live sync. A lock or lease whose owner
 * process has exited (or whose pid now names a process with another start time) is ignored here
 * and reclaimed by the next sync, so a killed process never wedges the hooks. The lease names the
 * launcher's pid: a launcher killed outright orphans its guard, which then runs unprotected.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];

// Git's messages are matched below, so pin them to English; the guard child keeps `env`.
const gitEnv = { ...env, LC_ALL: 'C', LANGUAGE: 'C' };
function git(...args) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], {
    env: gitEnv, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// Keep this bootstrap self-contained: importing a clone-local lock helper before taking the
// lease would itself race with reset/clean. lockWaitMs, pause, processStart, alive and
// holderAlive match sync-guard-clone.mjs (a test keeps the copies identical).
const MAX_WAIT_MS = 20_000;
/** WE_GUARD_LOCK_WAIT_MS may only shorten the wait (tests); it can never lengthen it. */
function lockWaitMs() {
  const value = Number(process.env.WE_GUARD_LOCK_WAIT_MS);
  return process.env.WE_GUARD_LOCK_WAIT_MS !== undefined && Number.isFinite(value) && value >= 0
    ? Math.min(value, MAX_WAIT_MS) : MAX_WAIT_MS;
}
function pause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
const STARTED = Date.now() - Math.round(process.uptime() * 1000);
/** A process's start time in ms, or null when ps cannot say. */
function processStart(pid) {
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
 * Unknown evidence counts as live. */
function alive(pid, started) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (error) { if (error.code !== 'EPERM') return false; }
  if (!Number.isFinite(started) || started <= 0) return true;
  const actual = processStart(pid);
  // ps reports whole seconds; a larger gap is a different process reusing the pid.
  return actual === null || Math.abs(actual - started) < 3_000;
}
/** True while a live sync process holds the exclusive lock. The lock is a file holding the
 * owner record, or a directory from an earlier revision: the mkdir lock (empty, no owner) or one
 * keeping its record in `<lock>/owner`. A live owner there still holds the clone, exactly as
 * sync's reclaim judges it; an absent lock, an ownerless directory or an exited owner is not
 * a running sync. Any other unreadable evidence throws, so the hook denies. */
function syncRunning(lockPath) {
  // The lock can switch between file and directory between reads; re-read, then fail closed.
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return holderAlive(readFileSync(lockPath, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return false;
      if (error.code !== 'EISDIR') throw error;
    }
    try { return legacyOwnerAlive(join(lockPath, 'owner')); }
    catch (error) {
      if (error.code === 'ENOENT') {
        // Ownerless only while the lock is still a directory; else it changed hands.
        try { if (lstatSync(lockPath).isDirectory()) return false; }
        catch (inner) { if (inner.code === 'ENOENT') return false; throw inner; }
        continue;
      }
      if (error.code !== 'ENOTDIR') throw error;
    }
  }
  throw new Error('guard clone sync lock kept changing while it was read; retry the hook');
}
function holderAlive(record) {
  if (typeof record !== 'string' || !record) return false;
  const [pid, started] = record.trim().split(' ').map(Number);
  return alive(pid, started);
}
/** An earlier revision's `<lock>/owner` record is `<pid> <hex nonce>`, with no start time, so
 * its second field is never read as one. Its owner wrote it after starting: a live pid whose
 * process started after the file was written is a reuse. Unknown start evidence counts as live. */
function legacyOwnerAlive(ownerPath) {
  const pid = Number(readFileSync(ownerPath, 'utf8').trim().split(' ')[0]);
  if (!alive(pid, NaN)) return false;
  const started = processStart(pid);
  return started === null || started <= lstatSync(ownerPath).mtimeMs + 3_000;
}

const argv = process.argv.slice(2);
// Stop and SubagentStop wrappers pass --stop-hook. There exit 2 means "keep going", and an
// infrastructure failure would recur on every retry, so it exits 1 (non-blocking) instead.
const stopHook = argv[0] === '--stop-hook';
if (stopHook) argv.shift();
const failureCode = stopHook ? 1 : 2;
let lease;
try {
  const [script, ...args] = argv;
  if (!script?.startsWith('scripts/') || script.split('/').includes('..')) {
    throw new Error('expected a relative path inside scripts without ..');
  }
  const launcher = realpathSync(fileURLToPath(import.meta.url));
  const clone = realpathSync(dirname(dirname(dirname(launcher))));
  if (launcher !== join(clone, 'scripts/hooks/run-pinned-guard.mjs') ||
      realpathSync(git('-C', clone, 'rev-parse', '--show-toplevel')) !== clone) {
    throw new Error('launcher must be located at <clone>/scripts/hooks/run-pinned-guard.mjs');
  }
  const lockPath = `${clone}.guard-lock`;
  const readers = `${clone}.guard-readers`;
  mkdirSync(readers, { recursive: true });
  if (!lstatSync(readers).isDirectory()) throw new Error(`${readers} must be a real directory`);
  const marker = join(readers, `${process.pid}-${randomBytes(6).toString('hex')}`);
  const waitMs = lockWaitMs();
  const deadline = Date.now() + waitMs;
  let announced = false;
  for (;;) {
    if (!syncRunning(lockPath)) {
      writeFileSync(marker, String(STARTED), { flag: 'wx' });
      lease = marker;
      // Sync takes its lock before it lists leases, so re-checking after publishing ours
      // means either sync sees this lease or this launcher sees sync's lock.
      if (!syncRunning(lockPath)) break;
      rmSync(marker, { force: true });
      lease = undefined;
    }
    if (Date.now() >= deadline) {
      throw new Error('guard clone sync is in progress; retry the hook');
    }
    if (!announced) {
      // The effective bound, printed so tests can pin the cap without waiting it out.
      process.stderr.write(`Pinned guard: waiting up to ${waitMs}ms for guard clone sync to finish\n`);
      announced = true;
    }
    pause(50);
  }
  const scripts = join(clone, 'scripts');
  const target = realpathSync(join(clone, script));
  const withinScripts = relative(scripts, target);
  if (!withinScripts || withinScripts === '..' || withinScripts.startsWith(`..${sep}`) ||
      isAbsolute(withinScripts) || !statSync(target).isFile()) {
    throw new Error('clone guard must be a regular file inside clone/scripts');
  }
  // Freshness is not repository evidence. Pin Git's metadata path so it cannot
  // discover a parent checkout when this clone is damaged or incomplete.
  git('--git-dir', join(clone, '.git'), 'rev-parse', '--verify', 'HEAD^{commit}');
  const entries = git('-C', clone, 'ls-files', '-v', '-z').split('\0');
  if (entries.at(-1) !== '') throw new Error('incomplete guard clone index evidence; run scripts/hooks/sync-guard-clone.mjs');
  // --ignored: a file hidden by .gitignore or info/exclude (e.g. a planted node_modules
  // package shadowing a bare import) is not part of the pinned revision either.
  const hidden = entries.slice(0, -1).filter(entry => !entry.startsWith('H '));
  const dirty = git('-C', clone, 'status', '--porcelain', '--untracked-files=all', '--ignored');
  if (hidden.length || dirty) {
    // Name the first offenders (capped, control characters stripped) so the next occurrence
    // identifies the writer without a repair destroying the evidence. The check stays strict.
    const named = [...hidden, ...dirty.split('\n').filter(Boolean)].slice(0, 5)
      .map(line => line.replace(/[^\x20-\x7e]/g, '?').slice(0, 200)).join('; ');
    throw new Error(`guard clone is not pristine (${named}); run scripts/hooks/sync-guard-clone.mjs to repair it`);
  }
  git('-C', clone, 'diff-index', '--quiet', 'HEAD', '--');
  if (git('-C', clone, 'rev-parse', 'HEAD') !== git('-C', clone, 'rev-parse', 'refs/remotes/origin/main')) {
    throw new Error('guard clone HEAD differs from origin/main; run scripts/hooks/sync-guard-clone.mjs to repair it');
  }
  if (process.env.WE_GUARD_ORIGIN !== undefined &&
      git('-C', clone, 'config', '--get-all', 'remote.origin.url') !== process.env.WE_GUARD_ORIGIN) {
    throw new Error('guard clone origin differs from WE_GUARD_ORIGIN; restore the expected origin before syncing');
  }
  const syncHelp = `run node ${join(clone, 'scripts/hooks/sync-guard-clone.mjs')}; launchd template: ${join(clone, 'scripts/hooks/com.we.guard-main-sync.plist.template')}`;
  let fetchTime;
  try {
    const fetchHead = statSync(join(clone, '.git/FETCH_HEAD'));
    if (!fetchHead.isFile()) throw new Error('not a regular file');
    fetchTime = fetchHead.mtimeMs;
  } catch {
    throw new Error(`cannot read FETCH_HEAD sync freshness; ${syncHelp}`);
  }
  if (!Number.isFinite(fetchTime) || fetchTime <= 0 || fetchTime > Date.now()) {
    throw new Error(`cannot determine clone sync freshness; ${syncHelp}`);
  }
  if (Date.now() - fetchTime > 24 * 60 * 60 * 1000) {
    throw new Error(`guard clone is stale: last sync was more than 24h ago (FETCH_HEAD mtime); ${syncHelp}`);
  }
  const hookRoot = operatedRoot(clone);
  // Run the canonical entry point in place so Node's module URL and argv[1]
  // agree, including when HOME or TMPDIR contains symlinked path components.
  // Hold the lease through execution so sync cannot reset/clean delayed imports.
  const child = spawnSync(process.execPath, [target, ...args], {
    stdio: 'inherit', env: { ...env, WE_HOOK_ROOT: hookRoot },
  });
  if (child.error) throw child.error;
  // Fail closed even if a child exits successfully after its entry path changes.
  if (realpathSync(target) !== target) {
    throw new Error('guard entry path changed during execution; run scripts/hooks/sync-guard-clone.mjs before retrying');
  }
  process.exitCode = child.status ?? failureCode;
} catch (error) {
  process.stderr.write(stopHook
    ? `Pinned guard: cannot load dedicated clone guard; stop guard skipped (exit 1, non-blocking): ${error.message}\n`
    : `Pinned guard: cannot load dedicated clone guard; denying (exit 2): ${error.message}\n`);
  process.exitCode = failureCode;
} finally {
  if (lease) rmSync(lease, { force: true });
}

/** The cwd's checkout; from a non-Git scratch directory (a dispatched worker), the primary
 * checkout beside the clone, which is where the legacy absolute-path hooks lived. */
function operatedRoot(clone) {
  try {
    return realpathSync(git('rev-parse', '--show-toplevel'));
  } catch (error) {
    if (!/not a git repository/i.test(String(error.stderr ?? ''))) throw error;
  }
  for (const name of ['webeverything', 'web-everything']) {
    const candidate = join(dirname(clone), name);
    let top;
    try { top = realpathSync(git('-C', candidate, 'rev-parse', '--show-toplevel')); } catch { continue; }
    if (top === realpathSync(candidate)) return top;
  }
  throw new Error(`cwd is outside Git and no primary checkout exists at ${join(dirname(clone), 'webeverything')}`);
}
