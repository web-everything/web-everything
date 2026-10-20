#!/usr/bin/env node
/**
 * @file scripts/run-fresh.mjs
 * @description Run one declared operation from a FRESH lane at origin/main, so a command printed for the operator
 *   (needs-you, operator-queue) works from any checkout of this repo, however far behind origin/main it is.
 *
 *   node scripts/run-fresh.mjs <operation> [--flag=value …]
 *
 *   1. leases a free lane through this checkout's own `lane-pool.mjs acquire` (which resets it to origin/main);
 *   2. re-reads origin/main and REFUSES (nothing run) unless the lane's HEAD is exactly that commit;
 *   3. runs `node scripts/operations/run.mjs <operation> …` INSIDE the lane with the terminal passed straight
 *      through (stdin/stdout stay TTYs, so operations that require an interactive operator still see one);
 *   4. releases the lane (by its minted holder slug) whatever the outcome, and exits with the operation's code.
 *
 *   It never resets, cleans, or pushes anything itself; the only git writes are the pool's own acquire/release and
 *   one `git fetch`. The operation's own guards are unchanged.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHA_RE = /^[0-9a-f]{40}$/;

const defaultSpawn = (cmd, args, opts) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });

/** Parse `lane-pool.mjs acquire --json` stdout. `{lane, path, holder}` or null. Pure. */
export function parseAcquire(stdout) {
  try {
    const j = JSON.parse(String(stdout ?? '').trim());
    return Number.isInteger(j?.lane) && typeof j?.path === 'string' && j.path && typeof j?.holder === 'string' && j.holder
      ? { lane: j.lane, path: j.path, holder: j.holder } : null;
  } catch { return null; }
}

/**
 * @returns {number} the exit code (the operation's own, or 1 for a refusal before it ran).
 */
export function runFresh(argv, { spawn = defaultSpawn, root = REPO_ROOT, log = (m) => process.stderr.write(`${m}\n`) } = {}) {
  const [op, ...rest] = argv;
  if (!op || op.startsWith('-')) { log('usage: node scripts/run-fresh.mjs <operation> [--flag=value …]'); return 1; }
  const pool = join(root, 'scripts', 'lane-pool.mjs');
  const acq = spawn(process.execPath, [pool, 'acquire', `--purpose=run-fresh-${op}`, '--json', '--wait-ms=300000', `--repo=${root}`],
    { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
  const lease = acq.status === 0 ? parseAcquire(acq.stdout) : null;
  if (!lease) { log(`run-fresh: REFUSED — could not lease a fresh lane (lane-pool acquire exited ${acq.status}); nothing ran`); return 1; }
  let code = 1;
  try {
    const git = (args) => spawn('git', ['-C', lease.path, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const fetched = git(['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
    const head = String(git(['rev-parse', 'HEAD']).stdout ?? '').trim();
    const main = String(git(['rev-parse', 'refs/remotes/origin/main']).stdout ?? '').trim();
    if (fetched.status !== 0 || !SHA_RE.test(head) || head !== main) {
      log(`run-fresh: REFUSED — lane-${lease.lane} is not at origin/main (HEAD ${head || '?'}, origin/main ${main || '?'}`
        + `${fetched.status !== 0 ? ', fetch failed' : ''}); nothing ran`);
      return 1;
    }
    log(`run-fresh: running ${op} from lane-${lease.lane} at origin/main ${head.slice(0, 9)}`);
    const run = spawn(process.execPath, [join(lease.path, 'scripts', 'operations', 'run.mjs'), op, ...rest],
      { cwd: lease.path, stdio: 'inherit' });
    code = typeof run.status === 'number' ? run.status : (run.signal ? 130 : 1);
    return code;
  } finally {
    const rel = spawn(process.execPath, [pool, 'release', `--lane=${lease.lane}`, `--session=${lease.holder}`, `--repo=${root}`],
      { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
    if (rel.status !== 0) log(`run-fresh: lane-${lease.lane} was not released (exit ${rel.status}); release it: node scripts/lane-pool.mjs release --lane=${lease.lane} --session=${lease.holder}`);
  }
}

/**
 * Keep this process alive through Ctrl-C / SIGTERM / SIGHUP while the operation runs: the operation (same process
 * group, inherited terminal) receives the signal and decides how to stop, and this process then still reaches the
 * lane release in `runFresh`'s `finally` instead of dying with the lease held. Removed once the run returns.
 */
export function withSignalsDeferred(fn, { proc = process } = {}) {
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const noop = () => {};
  for (const s of signals) proc.on(s, noop);
  try { return fn(); } finally { for (const s of signals) proc.off(s, noop); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = withSignalsDeferred(() => runFresh(process.argv.slice(2)));
}
