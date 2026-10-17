// Own scratch paths from allocation onward, including failed git setup and catchable termination.
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const owned = new Set();
const retained = new Set();
let installed = false;
let stopSeats = () => {};
export function removeReviewScratch(dir) {
  if (retained.has(dir)) return;
  rmSync(dir, { recursive: true, force: true });
  owned.delete(dir);
}
// A failed stop must survive callers' finally blocks. The TTL sweeper owns recovery.
export function retainReviewScratch(dir) {
  for (const path of dir ? [dir] : owned) retained.add(path);
}
export function ownReviewScratch(dir, stop) {
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
  writeFileSync(join(dir, '.we-review-owner.json'), JSON.stringify({ pid: process.pid }));
  return dir;
}
