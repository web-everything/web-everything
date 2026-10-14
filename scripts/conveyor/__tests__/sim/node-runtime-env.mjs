import { join } from 'node:path';

/** Share compiled modules between a world's short-lived Node children. Keep the cache outside the Git
 * checkouts: rebuild smoke must see a clean tree, and world cleanup must remove every cache artifact.
 * Node keys its cache by source content, so a main move at the same module path still loads the new code.
 * Older Node versions ignore this variable and keep the uncached behavior.
 */
export function nodeRuntimeEnv(root) {
  return { NODE_COMPILE_CACHE: join(root, 'node-compile-cache') };
}
