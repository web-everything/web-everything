/** Maintain only the explicitly owned, disposable origin/main guard clone. */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, realpathSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

let lock;
try {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => !arg.startsWith('--origin=') || !arg.slice(9))) {
    throw new Error('usage: sync-guard-clone.mjs [--origin=<url>]');
  }
  // Inherited Git overrides must never redirect a destructive command elsewhere.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const git = (cwd, ...argv) => execFileSync('git', argv, {
    cwd, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const origin = args[0]?.slice(9) || git(process.cwd(), 'config', '--get', 'remote.origin.url');
  if (!origin || origin.startsWith('-')) throw new Error('expected a non-option origin URL');
  const clone = resolve(process.env.WE_GUARD_CLONE || join(homedir(), 'workspace/.guard-main'));
  mkdirSync(dirname(clone), { recursive: true });
  if (realpathSync(dirname(clone)) !== dirname(clone)) throw new Error('clone parent must not contain symlinks');
  // Bootstrap uses only built-ins so a concurrent reset cannot rewrite a lock
  // helper during module loading. Match the launcher's non-reclaiming mutex.
  const lockPath = `${clone}.guard-lock`;
  try { mkdirSync(lockPath); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('guard clone is busy; retry sync; inspect an abandoned .guard-lock only after confirming its owner has stopped');
    throw error;
  }
  lock = lockPath;
  if (!existsSync(clone)) {
    git(process.cwd(), 'clone', '--single-branch', '--branch', 'main', '--no-tags', '--', origin, clone);
    git(clone, 'config', '--local', 'we.guardClone', clone);
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
    git(clone, 'fetch', 'origin', 'main');
    git(clone, 'reset', '--hard', 'origin/main');
    git(clone, 'clean', '-fdx');
  }
  process.stdout.write('Guard clone synchronized to origin/main.\n');
} catch (error) {
  process.stderr.write(`Guard clone sync refused/failed: ${error.message}\n`);
  process.exitCode = 2;
} finally {
  if (lock) rmdirSync(lock);
}
