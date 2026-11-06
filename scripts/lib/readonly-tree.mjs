import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** chmod -R a-w / u+w without following package/workspace symlinks outside the owned tree.
 * Setting directories first permits traversal/removal after a partial freeze or a killed build.
 */
export function setTreeWritable(path, writable) {
  let entry;
  try { entry = lstatSync(path); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  if (entry.isSymbolicLink()) return;
  chmodSync(path, writable ? entry.mode | 0o200 : entry.mode & ~0o222);
  if (entry.isDirectory()) for (const name of readdirSync(path)) setTreeWritable(join(path, name), writable);
}

/** Remove an owned tree, including frozen stores, without thawing symlink targets. */
export function removeReadonlyTree(dir) {
  setTreeWritable(dir, true);
  rmSync(dir, { recursive: true, force: true });
}
