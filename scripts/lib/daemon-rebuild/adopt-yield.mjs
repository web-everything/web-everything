/** Cooperative one-shot adopt-yield signal. probeFresh() reads live write-point evidence without suppression.
 * Evidence is advisory; adoption still validates under the write lock.
 */
import { readReadyCandidate, readReadyCandidateStrict } from './state.mjs';

export function createAdoptYieldProbe({ root, bootHead, env = process.env,
  readReady = readReadyCandidate, readReadyStrict = readReadyCandidateStrict, now = Date.now, throttleMs = 5000,
  bootAt, swapMinIntervalMs = 0 } = {}) {
  let lastRead = -Infinity;
  const yielded = new Set();
  function readFreshCandidate() {
    // Strict evidence is read before spacing: corruption always holds a grant/spend write.
    const ready = readReadyStrict(root, env);
    const time = now();
    if (!Number.isFinite(time)) throw new Error('adoption clock unreadable');
    if (ready === null) return null; // Strict reader proves ENOENT.
    if (!ready || Array.isArray(ready) || typeof ready.prevHead !== 'string'
      || typeof ready.adopt?.finalSha !== 'string' || !ready.adopt.finalSha.trim()
      || typeof ready.passedAt !== 'string' || !Number.isFinite(Date.parse(ready.passedAt))) {
      throw new Error('Invalid ready candidate');
    }
    if (!bootHead) throw new Error('adoption boot head unreadable');
    if (swapMinIntervalMs > 0 && (!Number.isFinite(bootAt) || time - bootAt < swapMinIntervalMs)) return null;
    if (ready.prevHead !== bootHead) return null;
    return ready;
  }
  const probe = (options) => {
    if (options?.fresh === true) {
      const ready = readFreshCandidate();
      if (ready === null) return false;
      const identity = JSON.stringify([ready.adopt.finalSha, ready.passedAt]);
      if (yielded.has(identity)) return false;
      yielded.add(identity);
      return true;
    }
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
  // Only the explicit write-point API bypasses identity suppression; it never consumes a signal.
  probe.probeFresh = () => readFreshCandidate() !== null;
  return probe;
}

/** Unknown or throwing safe-point callbacks never request a yield. */
export function safeAdoptYield(probe) {
  try { return typeof probe === 'function' && probe() === true; }
  catch { return false; }
}
