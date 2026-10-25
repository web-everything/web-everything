/**
 * Verify-only worker watchdog. Keep its runtime-selected worker/heartbeat imports out of bounded-child.mjs:
 * that shared daemon library must retain a statically knowable import closure.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { killProcessTree, ownProcessGroup } from './bounded-child.mjs';

// The worker runs THIS module's code as captured when it loaded, as a data: URL — never a fresh read from disk, so a
// tree switch or edit while a gate runs cannot hand the watchdog different (or missing) code.
let OWN_SOURCE_URL = null;
try {
  // Capture the helper module too: a worker started after a tree edit must use the same kill implementation.
  // Resolve its sole relative import to the captured data URL so the snapshot needs no on-disk dependencies.
  // Use a filesystem path: Vite's browser transform rewrites relative new URL(..., import.meta.url) as an asset URL.
  const helperPath = join(dirname(fileURLToPath(import.meta.url)), 'bounded-child.mjs');
  const helperUrl = `data:text/javascript;base64,${readFileSync(helperPath).toString('base64')}`;
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .replace("from './bounded-child.mjs'", `from '${helperUrl}'`);
  OWN_SOURCE_URL = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
} catch { /* the fallback timer covers it */ }
const WATCHDOG_SOURCE = `const { workerData, parentPort } = require('node:worker_threads');
import(workerData.module).then((m) => m.runTreeWatchdog(workerData, parentPort));`;

// flag[0]: 0 armed, 1 fired (the tree is killed, the escape sweeps are running), 2 swept (the kill is complete).
function fireTreeKill({ pid, kill, flag, afterTree = () => {} }) {
  Atomics.store(flag, 0, 1);
  const pgid = kill.orphansOfOwnGroup ? ownProcessGroup() : null;
  // Orphans of this group only when this process LEADS it (every member is then provably ours).
  killProcessTree(pid, 'SIGKILL', { orphansOfGroup: pgid === process.pid ? pgid : null, marker: kill.marker ?? null, outputFds: kill.outputFds ?? [], afterTree });
  Atomics.store(flag, 0, 2);
}

/** Worker entry of {@link startTreeWatchdog}. Not for direct use. */
export async function runTreeWatchdog({ pid, deadline, kill, heartbeat, flag }, port) {
  let beat = null;
  setTimeout(() => {
    clearInterval(beat);
    fireTreeKill({ pid, kill, flag, afterTree: () => port.postMessage('fired') });
    port.postMessage('swept');
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
 * @returns {{ fired: () => boolean, settled: (maxWaitMs?: number) => Promise<void>, stop: () => void }}
 */
export function startTreeWatchdog({ pid, timeoutMs, kill = {}, heartbeat = null, onFire = () => {},
  warn = (m) => { try { process.stderr.write(m); } catch { /* logging only */ } }, moduleUrl = OWN_SOURCE_URL }) {
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  let fallback = null;
  let stopped = false;
  let markSwept = () => {};
  const swept = new Promise((r) => { markSwept = r; });
  const fire = () => { if (!stopped && Atomics.load(flag, 0) === 0) { fireTreeKill({ pid, kill, flag }); markSwept(); onFire(); } };
  const fallBack = (why) => {
    if (Atomics.load(flag, 0) === 2) markSwept();
    if (stopped || fallback || Atomics.load(flag, 0) !== 0) return;
    warn(`⚠ tree watchdog: its thread failed (${String(why?.message ?? why).split('\n')[0]}) — the ceiling falls back to a main-thread timer, which a blocked event loop cannot run\n`);
    fallback = setTimeout(fire, Math.max(0, deadline - Date.now()));
    fallback.unref();
  };
  let worker = null;
  try {
    if (!moduleUrl) throw new Error('own module source unavailable');
    worker = new Worker(WATCHDOG_SOURCE, { eval: true, workerData: { module: moduleUrl, pid, deadline, kill, heartbeat, flag } });
    worker.on('message', (m) => { if (m === 'fired' && !stopped) onFire(); if (m === 'swept') markSwept(); });
    worker.on('error', fallBack);
    worker.on('exit', () => markSwept());
    worker.unref();
  } catch (e) {
    fallBack(e);
  }
  return {
    fired: () => Atomics.load(flag, 0) >= 1,
    // After a fire, the kill is complete only once the escape sweeps ran: a caller must await this before it
    // reports the phase done or exits (an exit, or `stop()`, would cut the sweeps short). Bounded by `maxWaitMs`.
    // The wait timer is REF'd on purpose: the child has closed and the worker is unref'd, so without it nothing keeps
    // the caller's event loop alive and Node would exit mid-await, before the caller records its result.
    settled: (maxWaitMs = 60_000) => {
      if (Atomics.load(flag, 0) === 0) return Promise.resolve();
      let hold = null;
      return Promise.race([swept, new Promise((r) => { hold = setTimeout(r, maxWaitMs); })]).finally(() => clearTimeout(hold));
    },
    // Disarms an unfired ceiling. A fired worker is left to finish its sweeps and exit on its own.
    stop: () => { stopped = true; clearTimeout(fallback); if (Atomics.load(flag, 0) === 0) worker?.terminate().catch(() => {}); },
  };
}
