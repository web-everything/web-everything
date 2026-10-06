/**
 * @file scripts/lib/daemon-clone-layout.mjs
 * @description Card 89 S1 — stable clone identity across daemon version folders.
 * Path mapping is pure; only canonicalCloneRoot probes the filesystem. No daemon imports.
 */
import { realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export const CLONES_DIR_NAME = '.daemon-clones';

/** Map the outermost `<ws>/.daemon-clones/<name>/...` to `<ws>/<name>`. */
export function logicalCloneRoot(path) {
  const absolute = resolve(path);
  const marker = `${sep}${CLONES_DIR_NAME}${sep}`;
  const index = absolute.indexOf(marker);
  if (index < 0) return absolute;
  const name = absolute.slice(index + marker.length).split(sep)[0];
  return name ? join(absolute.slice(0, index) || sep, name) : absolute;
}

/** IO helper: preserve realpath-or-resolve, then collapse any resolved version folder. */
export function canonicalCloneRoot(root) {
  let canonical;
  try { canonical = realpathSync(root); } catch { canonical = resolve(root); }
  return logicalCloneRoot(canonical);
}
