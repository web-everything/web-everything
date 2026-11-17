/** Marker ownership and lifecycle IO, shared by foreground verification and orphan takeover. */
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { reserve, readLockEntry, releaseLockDirIf } from '../readiness/file-locks.mjs';
import { verifyPidAlive, verifyFinishBody } from './lane-verify.mjs';

/** Use the existing atomic directory lock, with no TTL eviction of a live/unknown holder. */
export function markerLock(gitDir, { pid = process.pid, pidProbe = verifyPidAlive,
  pidAlive = pid => pidProbe(pid), now = Date.now } = {}) {
  const root = join(gitDir, '.lane-verify.takeover');
  const owner = `${pid}-${randomUUID()}`;
  const ms = now();
  const result = reserve(root, 'marker', owner, ms, new Date(ms).toISOString(), pid,
    entry => pidAlive(entry.pid) === false ? 'dead' : 'unknown', Infinity);
  if (!result.ok) return null;
  const expected = readLockEntry(root, 'marker');
  return () => releaseLockDirIf(root, 'marker', expected);
}

export function sameVerifyRun(current, expected) {
  return !!current && !!expected && current.sha === expected.sha && current.runId === expected.runId;
}

/** Bounded synchronous retry also works in process exit handlers. Never bypass the lock. */
export function markerLockWithRetry(gitDir, { lock = markerLock, retryMs = 2_000, now = Date.now,
  wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  const deadline = now() + retryMs;
  let error;
  do {
    let release;
    try { release = lock(gitDir); error = null; } catch (caught) { error = caught; }
    if (release) return release;
    if (now() >= deadline) break;
    wait(Math.min(50, Math.max(0, deadline - now())));
  } while (true);
  if (error) throw error;
  return null;
}

/** The lock closes the read/rename gap; the identity check rejects a replaced same-SHA run. */
export function updateOwnedMarker({ gitDir, expected, readMarker, writeMarker, update, lock = markerLock,
  retryMs = 0, now = Date.now, wait }) {
  const release = markerLockWithRetry(gitDir, { lock, retryMs, now, wait });
  if (!release) return false;
  try {
    const current = readMarker();
    if (!sameVerifyRun(current, expected) || current.status !== 'running') return false;
    writeMarker(update(current));
    return true;
  } finally { release(); }
}

/** No gate may turn green through these handlers, including a clean but unfinished process exit. */
export function startVerifyLifecycle({ expected, update, events = process, now = Date.now,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval, exit = code => process.exit(code),
  terminateGate = () => {}, log = message => process.stderr.write(message) }) {
  const terminal = reason => {
    try {
      const written = update(current => verifyFinishBody(current, {
    sha: expected.sha, finishedAt: new Date(now()).toISOString(), exitCode: 3,
    infrastructure: { reason, detail: `verification infrastructure failure: ${reason}; rerun node scripts/verify-lane.mjs.` },
      }), { retryMs: 2_000 });
      if (written === false) log(`verify-lane: terminal marker write skipped (${reason}): marker lock unavailable or ownership changed; leaving marker for orphan detection; inspect .git/.lane-verify and rerun node scripts/verify-lane.mjs.\n`);
      return written;
    }
    catch (error) {
      log(`verify-lane: terminal marker write failed (${reason}): ${error.message}; leaving marker for orphan detection; inspect .git/.lane-verify and rerun node scripts/verify-lane.mjs.\n`);
      return false;
    }
  };
  const stopWith = (reason, code) => {
    try { terminateGate(); } finally { try { terminal(reason); } finally { exit(code); } }
  };
  const handlers = {
    SIGTERM: () => stopWith('killed-SIGTERM', 3),
    SIGINT: () => stopWith('killed-SIGINT', 3),
    SIGHUP: () => stopWith('killed-SIGHUP', 3),
    uncaughtException: () => stopWith('crashed', 3),
    unhandledRejection: () => stopWith('crashed', 3),
    exit: () => { try { terminateGate(); } finally { terminal('crashed'); } },
  };
  for (const [event, handler] of Object.entries(handlers)) events.on(event, handler);
  const timer = setIntervalFn(() => {
    try { update(current => ({ ...current, heartbeatAt: new Date(now()).toISOString() })); }
    catch { /* A slow/unavailable disk cannot prove this process dead. */ }
  }, 30_000);
  timer.unref?.();
  return { terminal, stopWith, stop() {
    clearIntervalFn(timer);
    for (const [event, handler] of Object.entries(handlers)) events.removeListener(event, handler);
  } };
}
