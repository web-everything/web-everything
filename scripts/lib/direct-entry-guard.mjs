/**
 * @file scripts/lib/direct-entry-guard.mjs
 * @description One change point for operation library modules that have no direct entry. When such a
 * module is run as `node <file>` it used to exit 0 with no output (it only defines exports). The guard
 * prints a named refusal and exits 2, so an operator never mistakes silence for a posted result.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAllSync } from './write-all-sync.mjs';

/** The refusal line; `useCmd` is the supported command, e.g. `run.mjs extend-rounds`. */
export function directEntryRefusal(opName, useCmd) {
  return `refused: ${opName} has no direct entry; use ${useCmd}\n`;
}

/** True when `metaUrl` is the file node was started with. Unknown or missing argv means false (no-op). */
export function isDirectEntry(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try { return realpathSync(resolve(argv1)) === realpathSync(resolve(fileURLToPath(metaUrl))); } catch { return false; }
}

/** When run directly: print the refusal and exit 2. Injected `write`/`exit` keep it testable. */
export function refuseDirectEntry(metaUrl, opName, useCmd, { argv1 = process.argv[1], write = (s) => writeAllSync(1, s), exit = (c) => process.exit(c) } = {}) {
  if (!isDirectEntry(metaUrl, argv1)) return false;
  write(directEntryRefusal(opName, useCmd));
  exit(2);
  return true;
}
