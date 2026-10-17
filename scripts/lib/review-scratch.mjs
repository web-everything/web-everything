// Own scratch paths from allocation onward, including failed git setup and catchable termination.
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const owned = new Set();
let installed = false;
let stopSeats = () => {};
export function removeReviewScratch(dir) {
  rmSync(dir, { recursive: true, force: true });
  owned.delete(dir);
}
export function ownReviewScratch(dir, stop) {
  if (stop) stopSeats = stop;
  owned.add(dir);
  if (!installed) {
    installed = true;
    const cleanup = () => {
      stopSeats();
      for (const path of owned) {
        try { removeReviewScratch(path); } catch (e) { console.error(`review scratch cleanup failed: ${e.code ?? 'unknown'}`); }
      }
    };
    process.on('exit', cleanup);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.once(signal, () => {
        cleanup();
        // Preserve signal termination rather than turning an interrupted review into success.
        process.kill(process.pid, signal);
      });
    }
  }
  writeFileSync(join(dir, '.we-review-owner.json'), JSON.stringify({ pid: process.pid }));
  return dir;
}
