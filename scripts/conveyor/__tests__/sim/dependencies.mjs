/** Seed a simulator lane with the test runner's installed dependencies, without npm or network IO. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, symlinkSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function seedLaneDependencies(lane, nodeModules, {
  exists = existsSync, read = readFileSync, link = symlinkSync,
  append = appendFileSync, write = writeFileSync,
} = {}) {
  if (!exists(nodeModules)) throw new Error('simulator: test runner dependencies are missing');
  const lock = join(lane, 'package-lock.json');
  const manifest = exists(lock) ? lock : join(lane, 'package.json');
  if (!exists(manifest)) throw new Error('simulator: lane dependency manifest is missing');
  const hash = createHash('sha256').update(read(manifest)).digest('hex');
  // A directory-only node_modules/ ignore rule does not ignore a symlink. Keep acquire's git clean
  // from deleting it, and keep the real lane cleanliness checks enabled.
  append(join(lane, '.git', 'info', 'exclude'), '\nnode_modules\n');
  if (!exists(join(lane, 'node_modules'))) link(nodeModules, join(lane, 'node_modules'), 'dir');
  // Same marker and hash as lane-pool's depsReady: an ordinary smoke acquire must never run npm ci.
  write(join(lane, '.git', '.lane-pool-deps'), hash);
}
