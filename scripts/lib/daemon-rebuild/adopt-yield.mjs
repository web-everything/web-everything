/** Cooperative adopt-yield signal. Evidence is advisory; adoption still validates under the write lock. */
import { readReadyCandidate } from './state.mjs';

export function createAdoptYieldProbe({ root, bootHead, env = process.env,
  readReady = readReadyCandidate, now = Date.now, throttleMs = 5000,
  bootAt, swapMinIntervalMs = 0 } = {}) {
  let lastRead = -Infinity;
  let lastObserved = true;
  const yielded = new Set();
  return () => {
    try {
      const time = now();
      if (!Number.isFinite(time)) return (lastObserved = true);
      // Throttling reuses evidence; it is not a failed observation.
      if (time - lastRead < throttleMs) return lastObserved;
      lastRead = time;
      if (swapMinIntervalMs > 0 && (!Number.isFinite(bootAt) || time - bootAt < swapMinIntervalMs)) return (lastObserved = false);
      const ready = readReady(root, env);
      if (!bootHead || !ready || Array.isArray(ready) || ready.prevHead !== bootHead
        || typeof ready.adopt?.finalSha !== 'string' || !ready.adopt.finalSha.trim()
        || typeof ready.passedAt !== 'string' || !Number.isFinite(Date.parse(ready.passedAt))) return (lastObserved = false);
      const identity = JSON.stringify([ready.adopt.finalSha, ready.passedAt]);
      if (yielded.has(identity)) return (lastObserved = false);
      yielded.add(identity);
      return (lastObserved = true);
    } catch { return (lastObserved = true); }
  };
}

/** An unavailable safe-point probe yields conservatively; an absent probe is opt-out. */
export function safeAdoptYield(probe) {
  try { return typeof probe === 'function' && probe() === true; }
  catch { return true; }
}
