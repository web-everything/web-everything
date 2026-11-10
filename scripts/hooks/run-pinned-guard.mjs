/** Run guards only from WE_GUARD_CLONE (default: ~/workspace/.guard-main).
 * Preserve the operated checkout as WE_HOOK_ROOT; never fetch from a hook.
 */
import { homedir, tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, rmdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];

function git(...args) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    env, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

let lock;
let snapshot;
try {
  const [script, ...args] = process.argv.slice(2);
  if (!script?.startsWith('scripts/') || script.split('/').includes('..')) {
    throw new Error('expected a relative path inside scripts without ..');
  }
  const clone = realpathSync(process.env.WE_GUARD_CLONE || join(homedir(), 'workspace/.guard-main'));
  // Keep this bootstrap self-contained: importing a clone-local lock helper
  // before acquiring the lock would itself race with reset/clean.
  const lockPath = `${clone}.guard-lock`;
  try { mkdirSync(lockPath); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('guard clone is busy; retry the hook; inspect an abandoned .guard-lock only after confirming its owner has stopped');
    throw error;
  }
  lock = lockPath;
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
  if (git('-C', clone, 'status', '--porcelain', '--untracked-files=all')) {
    throw new Error('guard clone is not pristine; run scripts/hooks/sync-guard-clone.mjs to repair it');
  }
  if (git('-C', clone, 'rev-parse', 'HEAD') !== git('-C', clone, 'rev-parse', 'refs/remotes/origin/main')) {
    throw new Error('guard clone HEAD differs from origin/main; run scripts/hooks/sync-guard-clone.mjs to repair it');
  }
  if (process.env.WE_GUARD_ORIGIN !== undefined &&
      git('-C', clone, 'config', '--get-all', 'remote.origin.url') !== process.env.WE_GUARD_ORIGIN) {
    throw new Error('guard clone origin differs from WE_GUARD_ORIGIN; restore the expected origin before syncing');
  }
  let refreshedAt;
  try { refreshedAt = statSync(join(clone, '.git/FETCH_HEAD')).mtimeMs; }
  catch {
    refreshedAt = Number(git('-C', clone, 'show', '-s', '--format=%ct', 'HEAD')) * 1000;
  }
  if (!Number.isFinite(refreshedAt) || refreshedAt <= 0) throw new Error('cannot determine clone freshness');
  if (Date.now() - refreshedAt > 24 * 60 * 60 * 1000) {
    process.stderr.write('Pinned guard: warning: guard clone is >24h behind; run scripts/hooks/sync-guard-clone.mjs to refresh it.\n');
  }
  const hookRoot = realpathSync(git('rev-parse', '--show-toplevel'));
  // Publish a private, complete scripts revision before releasing the clone.
  // Sync never traverses these directories, and each invocation retains its
  // revision until the guard exits, including any delayed imports.
  snapshot = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'we-guard-revision-'));
  cpSync(scripts, join(snapshot, 'scripts'), { recursive: true, dereference: true });
  if (existsSync(join(clone, 'package.json'))) cpSync(join(clone, 'package.json'), join(snapshot, 'package.json'));
  rmdirSync(lock);
  lock = undefined;
  const child = spawnSync(process.execPath, [join(snapshot, 'scripts', withinScripts), ...args], {
    stdio: 'inherit', env: { ...env, WE_HOOK_ROOT: hookRoot },
  });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 2;
} catch (error) {
  process.stderr.write(`Pinned guard: cannot load dedicated clone guard; denying (exit 2): ${error.message}\n`);
  process.exitCode = 2;
} finally {
  if (lock) rmdirSync(lock);
  if (snapshot) {
    // cpSync preserves read-only directory modes from the synchronized clone.
    execFileSync('chmod', ['-R', 'u+w', snapshot]);
    rmSync(snapshot, { recursive: true, force: true });
  }
}
