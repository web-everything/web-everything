/**
 * @file bounded-child.mjs — run a child CLI with a hard timeout, and make sure it dies with its parent (#x7xv2xt).
 *
 * WHY. `we:scripts/readiness/dispatch-plan.mjs` used to shell its collectors (`lane-pool.mjs list --acquirable`,
 * `scope-lease-collect.mjs`, …) with a bare `execFileSync`: no timeout, and the parent's event loop blocked for
 * the whole call. Observed 2026-09-23: test-spawned dispatch-plan processes sat 10–60+ min inside a `lane-pool`
 * scan of the real pool, and when vitest died they were re-parented to init (ppid 1) and kept scanning — a
 * blocked event loop cannot notice that its parent is gone.
 *
 * WHAT. {@link runBounded} spawns the child `detached` (its own process group, the same pattern
 * `we:scripts/conveyor/verify-dispatch.mjs` and `we:scripts/codex-direct-task.mjs` use) so a timeout kills the
 * WHOLE tree — the child and the `git` processes it forks. {@link installChildReaper} kills every live group when
 * the parent exits, is signalled, or is orphaned (its ppid changes), and it polls on an unref'd timer, so it never
 * keeps the parent alive by itself.
 *
 * LIMIT, stated plainly: a parent killed with SIGKILL runs no handler at all, so its detached children survive.
 * Nothing in-process can cover that case. The timeout still bounds how long they can run.
 */
import { spawn } from 'node:child_process';

/** Default hard ceiling for one child call — generous against a slow real pool, but never "forever". */
export const DEFAULT_CHILD_TIMEOUT_MS = 5 * 60 * 1000;

/** Env knob that overrides {@link DEFAULT_CHILD_TIMEOUT_MS}. */
export const CHILD_TIMEOUT_ENV = 'WE_CHILD_TIMEOUT_MS';

/** Resolve the timeout from env: a positive integer wins, anything else falls back to the default. */
export function resolveChildTimeoutMs(env = process.env) {
  const n = Number(env?.[CHILD_TIMEOUT_ENV]);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_CHILD_TIMEOUT_MS;
}

/** Budget for one real `npm ci`/`npm install` (`we:scripts/lane-pool.mjs`'s `ensureDeps`) — the ONE source of it. */
export const NPM_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** Budget for one genuinely network-bound `git` call (`lane-pool.mjs`'s `fetch origin --prune`). Fixed, not env-tuned. */
export const NETWORK_GIT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Budget for an OUTER call to `lane-pool.mjs acquire` that may install deps (#x5n4zn3 review). The acquire does
 * a network `git fetch` (fixed {@link NETWORK_GIT_TIMEOUT_MS}), a few local `git` steps (the env-tuned child
 * budget each), and `ensureDeps`' `npm ci` ({@link NPM_INSTALL_TIMEOUT_MS}), so the wrapper around it must cover
 * all of them, never the generic listing-sized default — or a slow-but-healthy install gets killed mid-way.
 */
export function resolveLaneAcquireTimeoutMs(env = process.env) {
  return NETWORK_GIT_TIMEOUT_MS + NPM_INSTALL_TIMEOUT_MS + 4 * resolveChildTimeoutMs(env);
}

const live = new Set();

function killGroup(child, signal) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) return;
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } }
}

/** Kill every child group {@link runBounded} still has running. Synchronous — safe inside an `exit` handler. */
export function killAllChildren(signal = 'SIGKILL') {
  for (const child of live) killGroup(child, signal);
  live.clear();
}

let reaperInstalled = false;

/**
 * Tie every {@link runBounded} child to this process's lifetime: kill them on exit, on SIGINT/SIGTERM/SIGHUP,
 * and when this process is orphaned (its parent died, so its ppid changed). Idempotent.
 *
 * @param {{ pollMs?: number, log?: (m: string) => void }} [opts]
 */
export function installChildReaper({ pollMs = 2000, log = () => {} } = {}) {
  if (reaperInstalled) return;
  reaperInstalled = true;
  process.on('exit', () => killAllChildren('SIGKILL'));
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    process.on(sig, () => { killAllChildren('SIGKILL'); process.exit(code); });
  }
  const parentPid = process.ppid;
  const timer = setInterval(() => {
    if (process.ppid !== parentPid) {
      log(`  ✗ parent process ${parentPid} is gone (now ppid ${process.ppid}) — killing child processes and exiting`);
      killAllChildren('SIGKILL');
      process.exit(1);
    }
  }, pollMs);
  timer.unref();
}

/**
 * Run `cmd args` and resolve its stdout. Rejects on a spawn error, a non-zero exit, or the timeout — and on the
 * timeout the child's whole process group is killed first.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ timeoutMs?: number, env?: NodeJS.ProcessEnv, cwd?: string, maxBytes?: number }} [opts] `maxBytes`
 *   (#x5n4zn3) — an optional stdout cap, matching the `maxBuffer` several `execFileSync` call sites this
 *   function's rollout replaces already relied on: a verbose-but-not-hung child (a huge `gh`/backlog JSON
 *   payload) must not grow `out` unbounded in memory just because it never hits the timeout. Killed and
 *   rejected the same way a timeout is; omitted (the default) keeps today's unbounded behavior for every
 *   existing caller.
 * @returns {Promise<string>}
 */
export function runBounded(cmd, args, { timeoutMs = DEFAULT_CHILD_TIMEOUT_MS, env, cwd, maxBytes } = {}) {
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env, cwd });
    } catch (e) {
      reject(e);
      return;
    }
    live.add(child);
    // Raw Buffer chunks, decoded once at the end: `maxBytes` counts real bytes (like `maxBuffer`), not UTF-16
    // code units, and a multi-byte char split across two chunks still decodes intact.
    const chunks = [];
    let outBytes = 0;
    let err = '';
    let timedOut = false;
    let overBudget = false;
    child.stdout.on('data', (d) => {
      if (overBudget) return;
      outBytes += d.length;
      if (maxBytes && outBytes > maxBytes) { overBudget = true; killGroup(child, 'SIGKILL'); return; }
      chunks.push(d);
    });
    child.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, 'SIGKILL');
    }, timeoutMs);
    timer.unref();
    const done = () => { clearTimeout(timer); live.delete(child); };
    child.on('error', (e) => { done(); reject(e); });
    child.on('close', (code, signal) => {
      done();
      const failure = message => Object.assign(new Error(message), { stdout: Buffer.concat(chunks).toString('utf8'), stderr: err, status: code, signal });
      if (overBudget) reject(failure(`output exceeded ${maxBytes} bytes (process group killed)`));
      else if (timedOut) reject(failure(`timed out after ${timeoutMs}ms (process group killed)`));
      else if (code !== 0) reject(failure(`exited ${code ?? signal}: ${err.trim().split('\n')[0] || '(no stderr)'}`));
      else resolvePromise(Buffer.concat(chunks).toString('utf8'));
    });
  });
}
