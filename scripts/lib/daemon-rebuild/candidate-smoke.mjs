/**
 * @file scripts/lib/daemon-rebuild/candidate-smoke.mjs
 * @description Resolve the smoke RUNNER from the CANDIDATE tree, so the harness always matches the code it judges.
 *
 * Live 2026-11-24: PR #7430 made `dispatchReview` refuse a missing `expectedHead` and updated
 * `daemon-live-smoke.mjs` to pass one, but every daemon still ran its OLD installed smoke against the NEW
 * candidate, so `dispatch-dry-run` failed ("no prompt captured") and held every daemon on last-good code.
 * The guard stays strict; the harness is taken from the same commit as the code under test.
 *
 * Only the DEFAULT runner is replaced. An injected runner (tests, overlay callers) is used as given. A candidate
 * without the module, or whose module cannot be loaded, falls back to the installed runner (logged).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CANDIDATE_SMOKE_REL = 'scripts/lib/daemon-live-smoke.mjs';

/**
 * @param {{candidatePath:string, runSmoke:Function, installedRunSmoke:Function, log?:Console,
 *   exists?:(p:string)=>boolean, load?:(url:string)=>Promise<any>}} o
 * @returns {Promise<Function>} the runner to call for this candidate
 */
export async function resolveCandidateRunSmoke({
  candidatePath, runSmoke, installedRunSmoke, log = console,
  exists = existsSync, load = (url) => import(url),
}) {
  if (runSmoke !== installedRunSmoke) return runSmoke; // injected: caller owns it
  const file = join(candidatePath, CANDIDATE_SMOKE_REL);
  if (!exists(file)) return runSmoke;
  try {
    const mod = await load(pathToFileURL(file).href);
    if (typeof mod?.runLiveSmokeWithRetry === 'function') return mod.runLiveSmokeWithRetry;
    log.error?.(`daemon-rebuild: candidate smoke ${file} exports no runLiveSmokeWithRetry; using the installed runner`);
  } catch (e) {
    log.error?.(`daemon-rebuild: candidate smoke ${file} failed to load (${String(e?.message ?? e).split('\n')[0]}); using the installed runner`);
  }
  return runSmoke;
}
