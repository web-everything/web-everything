// Keep-alive child processes for tests and soak scenarios — the ONE place allowed to make them.
//
// Live-caught 2026-10-20 on the operator's Mac: 154 orphaned `node -e setInterval(() => {}, 1e9)` /
// `… 1000)` processes (parent pid 1), up to 19 days old, ~864 MB together. Tests spawn a do-nothing node
// child to stand in for a "live holder" (a lease/lock owner pid, a running seat, a hung drain) and either
// never killed it (a detached + unref'd sleeper) or died before their own cleanup ran (vitest killed or
// timed out). A plain `setInterval(() => {}, N)` child has no reason to ever exit, so each leak was forever.
//
// Every keep-alive made here is bounded three ways:
//   1. it watches an ANCHOR pid (by default the process that spawned it; under vitest, the test runner —
//      `WE_KEEPALIVE_ANCHOR_PID`, set by `vitest.setup.ts`) and exits within ~250ms once that pid is gone,
//      so even a SIGKILLed runner leaves nothing behind;
//   2. it exits on its own after a hard max lifetime (10 minutes by default);
//   3. a child spawned through `spawnKeepAlive` is registered and killed on `killKeepAlives()` (wired as an
//      `afterAll` in `vitest.setup.ts`) and on the spawner's own exit / SIGTERM / SIGINT / SIGHUP.
//
// The child's source starts with `KEEPALIVE_MARKER`, so its command line is recognisable (e.g. by an orphan
// sweep). `check:standards` (section 19b) fails on any bare empty-callback timer under scripts/, skills-src/
// or tools/ outside this file.
import { spawn } from 'node:child_process';

export const KEEPALIVE_MARKER = '/*we-keepalive*/';
export const KEEPALIVE_ANCHOR_ENV = 'WE_KEEPALIVE_ANCHOR_PID';
export const KEEPALIVE_MAX_LIFETIME_MS = 10 * 60_000;
export const KEEPALIVE_POLL_MS = 250;

const validPid = (n) => Number.isInteger(n) && n > 1;

/** The pid a keep-alive should outlive no longer than: the env anchor when one is set, else `fallback`. */
export function keepAliveAnchorPid(env = process.env, fallback = process.pid) {
  const fromEnv = Number(env?.[KEEPALIVE_ANCHOR_ENV]);
  return validPid(fromEnv) ? fromEnv : fallback;
}

/**
 * The child's `-e` source. `prelude` runs first (e.g. `process.on('SIGTERM', () => {});` for a child that
 * must ignore SIGTERM); `postlude` runs after the keep-alive is armed (e.g. `process.send('ready');`).
 * Usable as the content of a script FILE too.
 */
export function keepAliveScript({ anchorPid = keepAliveAnchorPid(), maxLifetimeMs = KEEPALIVE_MAX_LIFETIME_MS, prelude = '', postlude = '' } = {}) {
  if (!validPid(anchorPid)) throw new Error(`keepAliveScript: anchorPid must be a pid > 1, got ${anchorPid}`);
  if (!(Number.isFinite(maxLifetimeMs) && maxLifetimeMs > 0)) throw new Error(`keepAliveScript: bad maxLifetimeMs ${maxLifetimeMs}`);
  const body = `{const a=${anchorPid},m=${Math.round(maxLifetimeMs)},s=Date.now();`
    + 'setInterval(()=>{let g=false;try{process.kill(a,0)}catch(e){g=e.code===\'ESRCH\'}'
    + `if(g||Date.now()-s>m)process.exit(0)},${KEEPALIVE_POLL_MS})}`;
  // The marker always comes FIRST, so a process sweep can match it at the start of the `-e` program.
  return `${KEEPALIVE_MARKER}${prelude ? `${prelude}\n` : ''}${body}${postlude ? `\n${postlude}` : ''}`;
}

const live = new Set();
let hooksInstalled = false;

function killOne(child, signal = 'SIGKILL') {
  live.delete(child);
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    // A detached child leads its own process group — kill the group so anything it spawned goes too.
    if (child.__weKeepAliveDetached) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { try { child.kill(signal); } catch { /* already gone */ } }
}

/** Kill every keep-alive this process spawned that is still running. Safe to call repeatedly. */
export function killKeepAlives(signal = 'SIGKILL') {
  for (const child of [...live]) killOne(child, signal);
}

/** Kill one keep-alive (a child or its pid). */
export function killKeepAlive(childOrPid, signal = 'SIGKILL') {
  if (childOrPid && typeof childOrPid === 'object') return killOne(childOrPid, signal);
  const pid = Number(childOrPid);
  const tracked = [...live].find((c) => c.pid === pid);
  if (tracked) return killOne(tracked, signal);
  if (validPid(pid)) { try { process.kill(pid, signal); } catch { /* already gone */ } }
}

function installHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.once('exit', () => killKeepAlives());
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    const onSignal = () => {
      killKeepAlives();
      // Ours was the only listener: restore the default action (terminate) rather than swallow the signal.
      // Counted while ours runs FIRST (prepended), before any other `once` listener has removed itself, so a
      // process with its own graceful-shutdown handler is never re-signalled out from under it.
      if (process.listenerCount(sig) === 1) { process.removeListener(sig, onSignal); process.kill(process.pid, sig); }
    };
    try { process.prependListener(sig, onSignal); } catch { /* signals unsupported here (e.g. a worker thread) */ }
  }
}

/**
 * Spawn a do-nothing node child that stays alive until killed, its anchor dies, or it hits its max lifetime.
 * `detached` defaults to false; pass true only when the test needs the child to lead its own process group
 * (it is still anchored and bounded). `track: false` is ONLY for a child that must outlive its spawner on
 * purpose (a CLI shim minting a "live session" pid): it is then not killed on the spawner's exit, and its
 * anchor/lifetime bounds are the only cleanup — so give it an anchor that outlives the spawner. Returns the
 * ChildProcess.
 */
export function spawnKeepAlive({
  anchorPid, maxLifetimeMs, prelude, postlude, detached = false, stdio = 'ignore', unref = false, track = true, env, cwd,
  execPath = process.execPath,
} = {}) {
  const script = keepAliveScript({ anchorPid: anchorPid ?? keepAliveAnchorPid(process.env, process.pid), maxLifetimeMs, prelude, postlude });
  const child = spawn(execPath, ['-e', script], { detached: Boolean(detached), stdio, ...(env ? { env } : {}), ...(cwd ? { cwd } : {}) });
  child.__weKeepAliveDetached = Boolean(detached);
  if (track) {
    installHooks();
    live.add(child);
    child.once('exit', () => live.delete(child));
  }
  if (unref) child.unref();
  return child;
}
