#!/usr/bin/env node
/**
 * @file scripts/run-fresh.mjs
 * @description Run land-human-only from a FRESH lane at origin/main. A checkout predating this launcher must
 *   first update with `git pull --ff-only origin main` (the operator-queue command includes that step).
 *
 *   node scripts/run-fresh.mjs land-human-only [--flag=value …]
 *
 *   1. leases a free lane through this checkout's own `lane-pool.mjs acquire` (which resets it to origin/main);
 *   2. re-reads origin/main and REFUSES (nothing run) unless the lane's HEAD is exactly that commit;
 *   3. runs `node scripts/operations/run.mjs <operation> …` INSIDE the lane with the terminal passed straight
 *      through (stdin/stdout stay TTYs, so operations that require an interactive operator still see one);
 *   4. releases the lane (by its minted holder slug) whatever the outcome, and exits with the operation's code.
 *
 *   It never resets, cleans, or pushes anything itself; the only git writes are the pool's own acquire/release and
 *   one `git fetch`. The operation's own guards are unchanged.
 *   Only land-human-only is supported: its IO completes before exit. Other operations can launch detached
 *   workers (restart-runner, dispatch, review) that escape the process group and outlive the lane lease.
 */

import { spawnSync, spawn as spawnChild } from 'node:child_process';
import { constants } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHA_RE = /^[0-9a-f]{40}$/;

const defaultSpawn = (cmd, args, opts) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const operationGroups = process.platform !== 'win32';

function signalOperation(child, signal) {
  if (!child) return;
  try {
    if (operationGroups && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    // An exited group needs no signal. Other failures retain the lease until the operation actually stops.
    if (error.code !== 'ESRCH') process.stderr.write(`run-fresh: could not forward ${signal}: ${error.message}\n`);
  }
}

/** An exited operation may have left a writing subprocess behind. Zombies cannot write and need no wait. */
async function waitForGroupStop(pid) {
  for (;;) {
    try { process.kill(-pid, 0); } catch (error) { if (error.code === 'ESRCH') return; }
    const members = defaultSpawn('ps', ['-ax', '-o', 'pgid=,stat='],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 1000 });
    if (members.status === 0 && !String(members.stdout).split('\n').some((line) => {
      const [group, state] = line.trim().split(/\s+/);
      return group === String(pid) && !state?.startsWith('Z');
    })) return;
    // Retain the lease if live processes remain or process inspection fails.
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 100));
  }
}

/** Parse `lane-pool.mjs acquire --json` stdout. `{lane, path, holder}` or null. Pure. */
export function parseAcquire(stdout) {
  try {
    const j = JSON.parse(String(stdout ?? '').trim());
    return Number.isInteger(j?.lane) && typeof j?.path === 'string' && j.path && typeof j?.holder === 'string' && j.holder
      ? { lane: j.lane, path: j.path, holder: j.holder } : null;
  } catch { return null; }
}

/**
 * @returns {Promise<number>} the exit code (the operation's own, or 1 for a refusal before it ran).
 */
export function runFresh(argv, { spawn = defaultSpawn, spawnOperation = spawnChild, root = REPO_ROOT, log = (m) => process.stderr.write(`${m}\n`), proc = process } = {}) {
  return withSignalsDeferred(async (cancellation) => {
    const [op, ...rest] = argv;
    if (!op || op.startsWith('-')) { log('usage: node scripts/run-fresh.mjs land-human-only [--flag=value …]'); return 1; }
    // Fail closed for new operations too. Group draining cannot account for detached workers, and an override
    // of cwd or supervisor does not prove that every descendant will stop using this temporary checkout.
    if (op !== 'land-human-only') {
      log('run-fresh: REFUSED — only supports land-human-only; other operations may leave detached workers using the released lane. Run them from a persistent checkout.');
      return 1;
    }
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
      // Deliver signals queued during synchronous acquire/fetch before starting an operation that can write.
      await new Promise((resolveTurn) => setImmediate(resolveTurn));
      if (cancellation.signal) return 128 + constants.signals[cancellation.signal];
      log(`run-fresh: running ${op} from lane-${lease.lane} at origin/main ${head.slice(0, 9)}`);
      const child = spawnOperation(process.execPath, [join(lease.path, 'scripts', 'operations', 'run.mjs'), op, ...rest],
        { cwd: lease.path, stdio: 'inherit', detached: operationGroups });
      const run = await new Promise((resolveRun) => {
        cancellation.child = child;
        child.once('error', (error) => log(`run-fresh: could not run ${op}: ${error.message}`));
        // close follows exit/error, but descendants can still be using the lane after the leader exits.
        child.once('close', (status, signal) => {
          resolveRun({ status, signal });
        });
        if (cancellation.signal) signalOperation(child, cancellation.signal);
      });
      // Always drain the group, even if only the leader was killed or exited normally.
      if (operationGroups && child.pid) await waitForGroupStop(child.pid);
      cancellation.child = null;
      code = typeof run.status === 'number' && run.status >= 0 ? run.status
        : (run.signal ? 128 + constants.signals[run.signal] : 1);
      return code;
    } finally {
      const rel = spawn(process.execPath, [pool, 'release', `--lane=${lease.lane}`, `--session=${lease.holder}`, `--repo=${root}`],
        { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
      if (rel.status !== 0) log(`run-fresh: lane-${lease.lane} was not released (exit ${rel.status}); release it: node scripts/lane-pool.mjs release --lane=${lease.lane} --session=${lease.holder}`);
    }
  }, { proc });
}

/**
 * Forward cancellation to the active operation group, but keep the wrapper alive until it stops and releases its lane.
 * A child that handles the signal and exits successfully still leaves the wrapper with a cancellation exit code.
 * Listeners remain installed across the asynchronous wait and are removed after cleanup finishes.
 */
export async function withSignalsDeferred(fn, { proc = process } = {}) {
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const cancellation = { signal: null, child: null };
  const handlers = signals.map((signal) => [signal, () => {
    cancellation.signal ??= signal;
    signalOperation(cancellation.child, signal);
  }]);
  for (const [signal, handler] of handlers) proc.on(signal, handler);
  try {
    const code = await fn(cancellation);
    return cancellation.signal ? 128 + constants.signals[cancellation.signal] : code;
  } finally {
    for (const [signal, handler] of handlers) proc.off(signal, handler);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runFresh(process.argv.slice(2));
}
