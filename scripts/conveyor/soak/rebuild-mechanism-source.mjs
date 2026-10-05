/**
 * @file rebuild-mechanism-source.mjs — #4075 daemon soak harness. The source text of the daemon rebuild
 * mechanism on the tree at `root`: the entry `scripts/lib/daemon-rebuild.mjs` plus every module under
 * `scripts/lib/daemon-rebuild/` (the move-only split put the code there). Breaks' `fixPresent` probes grep THIS,
 * so a probe keeps finding its fix whichever file the code lives in. Throws when the entry file is missing —
 * every caller already treats a throw as "fix absent".
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** @param {string} root @returns {string} */
export function rebuildMechanismSource(root) {
  const parts = [readFileSync(join(root, 'scripts/lib/daemon-rebuild.mjs'), 'utf8')];
  const dir = join(root, 'scripts/lib/daemon-rebuild');
  if (existsSync(dir)) {
    for (const rel of readdirSync(dir, { recursive: true }).map(String).sort()) {
      if (rel.endsWith('.mjs') && !rel.split(/[\\/]/).includes('__tests__')) parts.push(readFileSync(join(dir, rel), 'utf8'));
    }
  }
  return parts.join('\n');
}
