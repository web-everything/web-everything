/** Run guards only from the clone containing this launcher at scripts/hooks/run-pinned-guard.mjs.
 * Preserve the operated checkout as WE_HOOK_ROOT; never fetch from a hook.
 * Usage: run-pinned-guard.mjs [--stop-hook] scripts/<guard>.mjs [guard arguments...]
 *
 * Revision protocol: the configured clone path is a symlink to a complete standalone clone
 * in <clone>.revs. Resolve this launcher's realpath once and use that immutable revision for
 * every check and the child. Sync builds and verifies another revision before atomically
 * replacing the symlink. Revision-local reader records protect delayed imports from pruning;
 * readers never consult the sync lock. The child records its own lifetime before loading code,
 * so it remains protected even if its launcher is killed. Collection closes registration with
 * a successor symlink before scanning records. A late registrant revalidates and relaunches
 * from the complete successor instead of using a revision that collection may have removed.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
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

function pause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** Publish before checking the collection gate. Either collection sees this record, or
 * the reader sees the gate and redirects before using any revision-local code. */
function registerReader(clone) {
  const logical = dirname(clone).endsWith('.revs') ? dirname(clone).slice(0, -5) : clone;
  const readers = join(clone, '.git/guard-readers');
  const lease = join(readers, `${process.pid}-${randomBytes(6).toString('hex')}`);
  let successor;
  try {
    try { mkdirSync(readers); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    writeFileSync(lease, `${process.pid} ${Date.now() - Math.round(process.uptime() * 1000)}\n`, { flag: 'wx' });
    try { successor = readlinkSync(join(clone, '.git/guard-successor')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!successor && realpathSync(clone) === clone) return { lease };
  } catch (error) {
    rmSync(lease, { force: true });
    if (error.code !== 'ENOENT') throw error;
    const current = realpathSync(logical);
    // A missing live .git is damage, not collection: do not retry it indefinitely.
    if (current === clone) throw new Error('launcher must be located at <clone>/scripts/hooks/run-pinned-guard.mjs with revision metadata intact');
    const acquired = registerReader(current);
    return { ...acquired, redirect: acquired.redirect || current };
  }
  rmSync(lease, { force: true });
  // A prior successor can itself have been collected. Prefer today's live revision;
  // only migration (L is still this real directory) needs the unpublished successor.
  const current = realpathSync(logical);
  const redirect = current === clone ? realpathSync(successor) : current;
  if (redirect === clone || dirname(redirect) !== `${logical}.revs`) {
    throw new Error('invalid guard revision successor; run scripts/hooks/sync-guard-clone.mjs');
  }
  // Hold the successor through relaunch, covering Node's entry-module loading as well.
  const acquired = registerReader(redirect);
  return { ...acquired, redirect: acquired.redirect || redirect };
}

const argv = process.argv.slice(2);
// Stop and SubagentStop wrappers pass --stop-hook. There exit 2 means "keep going", and an
// infrastructure failure would recur on every retry, so it exits 1 (non-blocking) instead.
const stopHook = argv[0] === '--stop-hook';
if (stopHook) argv.shift();
const failureCode = stopHook ? 1 : 2;
function run() {
let lease;
try {
  const [script, ...args] = argv;
  if (!script?.startsWith('scripts/') || script.split('/').includes('..')) {
    throw new Error('expected a relative path inside scripts without ..');
  }
  // import.meta.url already names the loaded module. Register using its lexical revision
  // path first: collection may have removed that path while this process was paused.
  const loaded = fileURLToPath(import.meta.url);
  const clone = dirname(dirname(dirname(loaded)));
  const registration = registerReader(clone);
  lease = registration.lease;
  if (registration.redirect) {
    const child = spawnSync(process.execPath, [join(registration.redirect, 'scripts/hooks/run-pinned-guard.mjs'), ...process.argv.slice(2)], {
      stdio: 'inherit', env,
    });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? failureCode;
    return;
  }
  const launcher = realpathSync(loaded);
  if (launcher !== join(clone, 'scripts/hooks/run-pinned-guard.mjs') ||
      realpathSync(git('-C', clone, 'rev-parse', '--show-toplevel')) !== clone) {
    throw new Error('launcher must be located at <clone>/scripts/hooks/run-pinned-guard.mjs');
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
  // --ignored: a file hidden by .gitignore or info/exclude (e.g. a planted node_modules
  // package shadowing a bare import) is not part of the pinned revision either.
  // A reader can race the index refresh after a sync (index.lock held by a sibling launcher,
  // stat data stale after chmod): re-check a few times before denying. Real dirt persists
  // across every attempt and still denies.
  for (let attempt = 1; ; attempt++) {
    try {
      // All evidence is re-read on every attempt: a pass needs every check clean on the same attempt.
      const entries = git('-C', clone, 'ls-files', '-v', '-z').split('\0');
      if (entries.at(-1) !== '') throw new Error('incomplete guard clone index evidence; run scripts/hooks/sync-guard-clone.mjs');
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
      break;
    } catch (error) {
      if (attempt >= 5) throw error;
      pause(200);
    }
  }
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
  // The child and its delayed imports stay inside the resolved revision across swaps.
  // A preload registers the guard itself before its entry module executes. A record owned
  // only by this launcher would stop protecting an orphaned child after launcher SIGKILL.
  const preload = `
import { mkdirSync, writeFileSync, rmSync, readlinkSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
${registerReader.toString()}
const registration = registerReader(${JSON.stringify(clone)});
if (registration.redirect) {
  const child = spawnSync(process.execPath, [join(registration.redirect, 'scripts/hooks/run-pinned-guard.mjs'), ...${JSON.stringify(process.argv.slice(2))}], { stdio: 'inherit' });
  if (child.error) throw child.error;
  process.exit(child.status ?? ${failureCode});
}
process.once('exit', () => { try { rmSync(registration.lease, { force: true }); } catch { /* Reclaimed by sync after exit. */ } });
`;
  const child = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, target, ...args], {
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
}
run();

/** The cwd's checkout; from a non-Git scratch directory (a dispatched worker), the primary
 * checkout beside the clone, which is where the legacy absolute-path hooks lived. */
function operatedRoot(clone) {
  try {
    return realpathSync(git('rev-parse', '--show-toplevel'));
  } catch (error) {
    if (!/not a git repository/i.test(String(error.stderr ?? ''))) throw error;
  }
  const workspace = dirname(clone).endsWith('.revs') ? dirname(dirname(clone)) : dirname(clone);
  for (const name of ['webeverything', 'web-everything']) {
    const candidate = join(workspace, name);
    let top;
    try { top = realpathSync(git('-C', candidate, 'rev-parse', '--show-toplevel')); } catch { continue; }
    if (top === realpathSync(candidate)) return top;
  }
  throw new Error(`cwd is outside Git and no primary checkout exists at ${join(workspace, 'webeverything')}`);
}
