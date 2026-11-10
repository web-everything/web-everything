/** Run guards only from the clone containing this launcher at scripts/hooks/run-pinned-guard.mjs.
 * Preserve the operated checkout as WE_HOOK_ROOT; never fetch from a hook.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];

function git(...args) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], {
    env, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

let lock;
try {
  const [script, ...args] = process.argv.slice(2);
  if (!script?.startsWith('scripts/') || script.split('/').includes('..')) {
    throw new Error('expected a relative path inside scripts without ..');
  }
  const launcher = realpathSync(fileURLToPath(import.meta.url));
  const clone = realpathSync(dirname(dirname(dirname(launcher))));
  if (launcher !== join(clone, 'scripts/hooks/run-pinned-guard.mjs') ||
      realpathSync(git('-C', clone, 'rev-parse', '--show-toplevel')) !== clone) {
    throw new Error('launcher must be located at <clone>/scripts/hooks/run-pinned-guard.mjs');
  }
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
  const entries = git('-C', clone, 'ls-files', '-v', '-z').split('\0');
  if (entries.at(-1) !== '') throw new Error('incomplete guard clone index evidence; run scripts/hooks/sync-guard-clone.mjs');
  if (entries.slice(0, -1).some(entry => !entry.startsWith('H ')) ||
      git('-C', clone, 'status', '--porcelain', '--untracked-files=all')) {
    throw new Error('guard clone is not pristine; run scripts/hooks/sync-guard-clone.mjs to repair it');
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
  const hookRoot = realpathSync(git('rev-parse', '--show-toplevel'));
  // Run the canonical entry point in place so Node's module URL and argv[1]
  // agree, including when HOME or TMPDIR contains symlinked path components.
  // Retain the clone lock through execution to protect delayed imports from sync.
  const child = spawnSync(process.execPath, [target, ...args], {
    stdio: 'inherit', env: { ...env, WE_HOOK_ROOT: hookRoot },
  });
  if (child.error) throw child.error;
  // Fail closed even if a child exits successfully after its entry path changes.
  if (realpathSync(target) !== target) {
    throw new Error('guard entry path changed during execution; run scripts/hooks/sync-guard-clone.mjs before retrying');
  }
  process.exitCode = child.status ?? 2;
} catch (error) {
  process.stderr.write(`Pinned guard: cannot load dedicated clone guard; denying (exit 2): ${error.message}\n`);
  process.exitCode = 2;
} finally {
  if (lock) rmdirSync(lock);
}
