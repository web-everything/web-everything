// Own scratch paths from allocation onward, including failed git setup and catchable termination.
import { rmSync, writeFileSync } from 'node:fs';
// Allocation and recovery share names; ownership metadata must never enter a PR's tree.
export const REVIEW_SCRATCH_PREFIXES = Object.freeze({
  seat: 'we-review-seat-', recheck: 'we-red-team-recheck-', overlay: 'we-overlay-dispatch-smoke-',
});
export const reviewScratchOwnerPath = dir => `${dir}.owner.json`;
export const isReviewScratchName = name => Object.values(REVIEW_SCRATCH_PREFIXES)
  .some(prefix => name.startsWith(prefix) && /^[\w-]+$/.test(name.slice(prefix.length)));
const owned = new Set();
// A pooled seat checkout is released, never deleted: its slot stays warm for the next seat.
const releasers = new Map();
// Once pooled, a path is never deleted by this module, even by a repeated cleanup after its slot was handed on.
const pooled = new Set();
const retained = new Set();
let installed = false;
let stopSeats = () => {};
export function removeReviewScratch(dir) {
  if (retained.has(dir)) return;
  if (pooled.has(dir) && !releasers.has(dir)) return;
  const release = releasers.get(dir);
  if (release) {
    releasers.delete(dir);
    owned.delete(dir);
    release();
    return;
  }
  rmSync(dir, { recursive: true, force: true });
  if (owned.has(dir)) rmSync(reviewScratchOwnerPath(dir), { force: true });
  owned.delete(dir);
}
// A failed stop must survive callers' finally blocks. The TTL sweeper owns recovery.
export function retainReviewScratch(dir) {
  for (const path of dir ? [dir] : owned) retained.add(path);
}
export function ownReviewScratch(dir, stop, { release = null } = {}) {
  if (stop) stopSeats = stop;
  owned.add(dir);
  if (!installed) {
    installed = true;
    let cleaning;
    let terminating = false;
    const removeOwned = () => {
      for (const path of owned) {
        try { removeReviewScratch(path); } catch (e) { console.error(`review scratch cleanup failed: ${e.code ?? 'unknown'}`); }
      }
    };
    const cleanup = () => {
      if (cleaning) return cleaning;
      const stopped = stopSeats();
      if (stopped?.then) {
        cleaning = stopped.then(removeOwned, error => {
          retainReviewScratch();
          throw error;
        });
        return cleaning;
      }
      removeOwned();
    };
    // exit cannot await children. Request their stop, but leave their checkout for
    // the sweeper unless completion can be established synchronously.
    process.on('exit', () => { cleanup()?.catch(() => {}); });
    const handlers = new Map();
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => {
        if (terminating) return;
        terminating = true;
        Promise.resolve().then(cleanup).catch(e => {
          console.error(`review seat shutdown failed: ${e.code ?? 'unknown'}`);
        }).finally(() => {
          // Keep all handlers installed while waiting, including repeated signals.
          for (const [name, fn] of handlers) process.removeListener(name, fn);
          process.kill(process.pid, signal);
        });
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
  }
  if (release) { releasers.set(dir, release); pooled.add(dir); return dir; }
  writeFileSync(reviewScratchOwnerPath(dir), JSON.stringify({ pid: process.pid }), { flag: 'wx' });
  return dir;
}
