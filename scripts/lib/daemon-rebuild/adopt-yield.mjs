/** Cooperative adopt-yield signal. Evidence is advisory; adoption still validates under the write lock. */
import { readReadyCandidate } from './state.mjs';

export function createAdoptYieldProbe({ root, bootHead, env = process.env,
  readReady = readReadyCandidate, now = Date.now, throttleMs = 5000,
  bootAt, swapMinIntervalMs = 0 } = {}) {
  let lastRead = -Infinity;
  const yielded = new Set();
  return () => {
    try {
      const time = now();
      if (!Number.isFinite(time) || time - lastRead < throttleMs) return false;
      lastRead = time;
      if (swapMinIntervalMs > 0 && (!Number.isFinite(bootAt) || time - bootAt < swapMinIntervalMs)) return false;
      const ready = readReady(root, env);
      if (!bootHead || !ready || Array.isArray(ready) || ready.prevHead !== bootHead
        || typeof ready.adopt?.finalSha !== 'string' || !ready.adopt.finalSha.trim()
        || typeof ready.passedAt !== 'string' || !Number.isFinite(Date.parse(ready.passedAt))) return false;
      const identity = JSON.stringify([ready.adopt.finalSha, ready.passedAt]);
      if (yielded.has(identity)) return false;
      yielded.add(identity);
      return true;
    } catch { return false; }
  };
}

/** Unknown or throwing safe-point callbacks never request a yield. */
export function safeAdoptYield(probe) {
  try { return typeof probe === 'function' && probe() === true; }
  catch { return false; }
}
