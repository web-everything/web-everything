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
import { spawn, execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

/** Default hard ceiling for one child call — generous against a slow real pool, but never "forever". */
export const DEFAULT_CHILD_TIMEOUT_MS = 5 * 60 * 1000;

/** Env knob that overrides {@link DEFAULT_CHILD_TIMEOUT_MS}. */
export const CHILD_TIMEOUT_ENV = 'WE_CHILD_TIMEOUT_MS';

/** Resolve the timeout from env: a positive integer wins, anything else falls back to the default. */
export function resolveChildTimeoutMs(env = process.env) {
  const n = Number(env?.[CHILD_TIMEOUT_ENV]);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_CHILD_TIMEOUT_MS;
}

/** Summarize stderr with the first non-shim line, retaining the first skipped informational warning. */
export function summarizeStderr(stderr) {
  const lines = stderr.trim().split('\n');
  const primary = lines.findIndex((line) => !line.startsWith('gh-shim:'));
  if (primary <= 0) return lines[0] || '(no stderr)';
  return `${lines[primary]} [warning: ${lines[0]}]`;
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
      else if (code !== 0) reject(failure(`exited ${code ?? signal}: ${summarizeStderr(err)}`));
      else resolvePromise(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

/**
 * Every descendant of `rootPid` in a `ps -A -o pid=,ppid=` listing, deepest first (so a kill in this order never
 * lets a parent respawn a child it has not seen die). Pure. `rootPid` itself is excluded.
 * @param {number} rootPid
 * @param {string} psText  `pid ppid` per line
 * @returns {number[]}
 */
export function descendantPids(rootPid, psText) {
  const children = new Map();
  for (const line of String(psText || '').split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid === ppid) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const out = [];
  const seen = new Set([rootPid]);
  const walk = (pid) => {
    for (const c of children.get(pid) ?? []) {
      if (seen.has(c)) continue;
      seen.add(c);
      walk(c);
      out.push(c);
    }
  };
  walk(rootPid);
  return out;
}

/**
 * Kill `rootPid` and its whole process TREE (not its process group). For a child that must stay in its parent's
 * group (so a supervisor's group kill of the parent still reaches it) but must also be killable on its own, e.g.
 * verify-lane's gate phases (`shell → npm exec → node vitest → esbuild`). Best-effort and synchronous.
 * `orphansOfGroup` (a pgid): ALSO kill processes of that group that were reparented to init (ppid 1) — a
 * descendant whose intermediate parent already exited is no longer reachable through the tree, but it keeps the
 * group it was forked into. The caller passes its OWN pgid; an ancestor is never ppid 1 inside that group
 * unless it is the group's launchd-started leader, which is excluded along with the caller.
 * @returns {number[]} the pids signalled
 */
export function killProcessTree(rootPid, signal = 'SIGKILL', { orphansOfGroup = null, selfPid = process.pid, marker = null, outputFds = [],
  listProcesses = () => execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 10_000 }),
  listMarked = (m) => listMarkedPids(m, { selfPid }), listPeerHolders = (fds) => listPeerHolderPids(fds, { selfPid }),
  kill = process.kill.bind(process) } = {}) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  let tree = [];
  let orphans = [];
  try {
    const text = listProcesses();
    tree = descendantPids(rootPid, text);
    if (Number.isInteger(orphansOfGroup) && orphansOfGroup > 1) {
      for (const line of String(text).split('\n')) {
        const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
        if (ppid === 1 && pgid === orphansOfGroup && pid !== orphansOfGroup && pid !== selfPid && !tree.includes(pid)) orphans.push(pid);
      }
    }
  } catch { /* ps unavailable: still kill the root */ }
  const signalled = [];
  const send = (pid) => {
    if (signalled.includes(pid) || (pid !== rootPid && (!Number.isInteger(pid) || pid <= 1 || pid === selfPid))) return;
    try { kill(pid, signal); signalled.push(pid); } catch { /* already gone */ }
  };
  for (const pid of [...orphans, ...tree, rootPid]) send(pid);
  // PR #5768 — a descendant that left BOTH the tree and the group (detached into its own session, reparented to init)
  // is still provably ours by what it inherited: the per-run env `marker`, or the caller's output pipes (`outputFds`).
  // Swept AFTER the tree is down: these listings are slow (`lsof`, `ps -E`), and the tree must not wait for them.
  if (typeof marker === 'string' && marker.includes('=')) { try { listMarked(marker).forEach(send); } catch { /* best-effort */ } }
  if (outputFds.length) { try { listPeerHolders(outputFds).forEach(send); } catch { /* best-effort */ } }
  return signalled;
}

/**
 * Pids whose environment carries `marker` (`NAME=value`), from a darwin `ps -A -ww -E -o pid=,command=` listing (the
 * environment is printed after the arguments). Pure. LIMIT: macOS hides a platform binary's environment (`/bin/sleep`),
 * so such a process is only found here on Linux; on darwin it is found by its inherited output pipe, if it kept one.
 */
export function markedPidsFromPs(psText, marker, { selfPid = process.pid } = {}) {
  const out = [];
  for (const line of String(psText || '').split('\n')) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);
    const pid = m ? Number(m[1]) : NaN;
    if (pid > 1 && pid !== selfPid && ` ${m[2]} `.includes(` ${marker} `)) out.push(pid);
  }
  return out;
}

/** Every live pid (not `selfPid`, never init) whose environment carries `marker`: `/proc/<pid>/environ` on Linux, `ps -E` on darwin. */
export function listMarkedPids(marker, { selfPid = process.pid, platform = process.platform } = {}) {
  if (platform === 'darwin') {
    return markedPidsFromPs(execFileSync('ps', ['-A', '-ww', '-E', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 10_000, maxBuffer: 256 << 20 }), marker, { selfPid });
  }
  if (platform !== 'linux') return [];
  const out = [];
  for (const name of readdirSync('/proc')) {
    const pid = /^\d+$/.test(name) ? Number(name) : NaN;
    if (!(pid > 1) || pid === selfPid) continue;
    try { if (readFileSync(`/proc/${name}/environ`, 'latin1').split('\0').includes(marker)) out.push(pid); } catch { /* gone or not ours */ }
  }
  return out;
}

/**
 * Pids other than `selfPid` holding the PEER end of one of `fds` (this process's ends of the socket pairs a child's
 * stdio was created on), from an `lsof -U -F pfdn` listing: `p<pid>`, then per fd `f<fd>`, `d<this end>`, `n-><peer end>`.
 * A process holding that peer end can write into the caller's output pipe — it inherited it. Pure.
 */
export function peerHolderPids(lsofText, { selfPid = process.pid, fds = [] } = {}) {
  const wanted = new Set(fds.map(Number));
  const entries = [];
  let pid = null;
  let cur = null;
  for (const line of String(lsofText || '').split('\n')) {
    const value = line.slice(1);
    if (line[0] === 'p') { pid = Number(value); cur = null; }
    else if (line[0] === 'f') { cur = { pid, fd: Number(value), dev: null, peer: null }; entries.push(cur); }
    else if (line[0] === 'd' && cur) cur.dev = value.toLowerCase();
    else if (line[0] === 'n' && cur) cur.peer = /^->0x[0-9a-f]+$/i.test(value) ? value.slice(2).toLowerCase() : null;
  }
  const peers = new Set(entries.filter((e) => e.pid === selfPid && wanted.has(e.fd) && e.peer).map((e) => e.peer));
  return [...new Set(entries.filter((e) => e.pid > 1 && e.pid !== selfPid && peers.has(e.dev)).map((e) => e.pid))];
}

/** darwin: the holders of the peer ends of `fds` (an `lsof -U` scan of this user's processes, ~1s). Elsewhere: none —
 *  Linux shows no socket peers there, and the env marker already finds every descendant on Linux. */
export function listPeerHolderPids(fds, { selfPid = process.pid, platform = process.platform } = {}) {
  if (platform !== 'darwin' || !fds.length) return [];
  const uid = process.getuid?.();
  let text;
  // lsof exits 1 when one process could not be read; its listing of the rest is still valid.
  try { text = execFileSync('lsof', ['-n', '-P', '-w', '-U', ...(Number.isInteger(uid) ? ['-a', '-u', String(uid)] : []), '-F', 'pfdn'], { encoding: 'utf8', timeout: 20_000, maxBuffer: 256 << 20 }); }
  catch (e) { text = typeof e?.stdout === 'string' ? e.stdout : ''; }
  return peerHolderPids(text, { selfPid, fds });
}

// The worker runs THIS module's code as captured when it loaded, as a data: URL — never a fresh read from disk, so a
// tree switch or edit while a gate runs cannot hand the watchdog different (or missing) code.
let OWN_SOURCE_URL = null;
try { OWN_SOURCE_URL = `data:text/javascript;base64,${readFileSync(new URL(import.meta.url)).toString('base64')}`; } catch { /* the fallback timer covers it */ }
const WATCHDOG_SOURCE = `const { workerData, parentPort } = require('node:worker_threads');
import(workerData.module).then((m) => m.runTreeWatchdog(workerData, parentPort));`;

function fireTreeKill({ pid, kill, flag }) {
  Atomics.store(flag, 0, 1);
  const pgid = kill.orphansOfOwnGroup ? ownProcessGroup() : null;
  // Orphans of this group only when this process LEADS it (every member is then provably ours).
  killProcessTree(pid, 'SIGKILL', { orphansOfGroup: pgid === process.pid ? pgid : null, marker: kill.marker ?? null, outputFds: kill.outputFds ?? [] });
}

/** Worker entry of {@link startTreeWatchdog}. Not for direct use. */
export async function runTreeWatchdog({ pid, deadline, kill, heartbeat, flag }, port) {
  let beat = null;
  setTimeout(() => {
    clearInterval(beat);
    fireTreeKill({ pid, kill, flag });
    port.postMessage('fired');
  }, Math.max(0, deadline - Date.now()));
  if (heartbeat) {
    // The ceiling above is already armed and must survive a heartbeat module that fails to load.
    let fn = null;
    try { fn = (await import(heartbeat.module))[heartbeat.exportName]; } catch { /* no heartbeat; the ceiling still holds */ }
    if (typeof fn === 'function' && Atomics.load(flag, 0) === 0) beat = setInterval(() => { try { fn(heartbeat.args); } catch { /* best-effort */ } }, heartbeat.everyMs);
  }
}

/**
 * Arm a hard ceiling for child `pid` on its OWN thread (PR #5768). The caller forwards the child's output with
 * synchronous writes, so a reader that stops reading blocks the caller's event loop, and a main-thread timer (or slot
 * heartbeat) would never run. At the ceiling the worker kills the tree (with `kill`: `{ orphansOfOwnGroup, marker,
 * outputFds }`, see {@link killProcessTree}), sets `fired()`, and posts to `onFire` (which runs once the caller's loop
 * is free). `heartbeat` (`{ module, exportName, args, everyMs }`) is called on that thread until the ceiling, then
 * stops, so a caller still stuck after the kill no longer keeps its slot. If the worker cannot run, the same ceiling
 * falls back to a main-thread timer, which a blocked main thread defeats — so that downgrade is logged through `warn`.
 * Unref'd; `stop()` ends it.
 * @returns {{ fired: () => boolean, stop: () => void }}
 */
export function startTreeWatchdog({ pid, timeoutMs, kill = {}, heartbeat = null, onFire = () => {},
  warn = (m) => { try { process.stderr.write(m); } catch { /* logging only */ } }, moduleUrl = OWN_SOURCE_URL }) {
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  let fallback = null;
  let stopped = false;
  const fire = () => { if (!stopped && Atomics.load(flag, 0) === 0) { fireTreeKill({ pid, kill, flag }); onFire(); } };
  const fallBack = (why) => {
    if (stopped || fallback || Atomics.load(flag, 0) === 1) return;
    warn(`⚠ tree watchdog: its thread failed (${String(why?.message ?? why).split('\n')[0]}) — the ceiling falls back to a main-thread timer, which a blocked event loop cannot run\n`);
    fallback = setTimeout(fire, Math.max(0, deadline - Date.now()));
    fallback.unref();
  };
  let worker = null;
  try {
    if (!moduleUrl) throw new Error('own module source unavailable');
    worker = new Worker(WATCHDOG_SOURCE, { eval: true, workerData: { module: moduleUrl, pid, deadline, kill, heartbeat, flag } });
    worker.on('message', (m) => { if (m === 'fired' && !stopped) onFire(); });
    worker.on('error', fallBack);
    worker.unref();
  } catch (e) {
    fallBack(e);
  }
  return {
    fired: () => Atomics.load(flag, 0) === 1,
    stop: () => { stopped = true; clearTimeout(fallback); worker?.terminate().catch(() => {}); },
  };
}

/** This process's process-group id (null when `ps` cannot say). */
export function ownProcessGroup({ pid = process.pid, exec = execFileSync } = {}) {
  try {
    const n = Number(String(exec('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', timeout: 10_000 })).trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}
