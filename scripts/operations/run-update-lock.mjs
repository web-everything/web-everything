import { withFileLock } from '../lib/atomic-json-file.mjs';
import { readRun, resolveRunsDir, runPath, writeRun } from './run-store.mjs';

/**
 * Read-modify-write one run record under a per-run file lock, re-reading INSIDE the lock so concurrent writers (the
 * review job, its detached extra-seats process, the red team) never overwrite each other's fields.
 * @param {string} runId
 * @param {(run: object) => object} mutate pure: returns the record to write
 * @param {string} [dir]
 */
export function updateRunLocked(runId, mutate, dir = resolveRunsDir()) {
  return withFileLock(`${runPath(runId, dir)}.lock`, () => {
    const next = mutate(readRun(runId, dir));
    writeRun(next, dir);
    return next;
  });
}
