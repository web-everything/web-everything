// Read-only view of the durable drop-intent record retire/replace write (see scripts/daemon-overlay.mjs). Kept in a
// light module so the rebuild libraries can check it without importing the whole daemon-overlay CLI.
import { readFileSync } from 'node:fs';
import { overlayFilePath } from './daemon-overlays.mjs';

// No `.json` suffix: `pruneStaleOverlayRecords` deletes every clone-less `*.json` in the overlay dir.
export const pendingPath = (root, env) => `${overlayFilePath(root, env)}.drop-pending`;
export function readPendingDrops(root, env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(pendingPath(root, env), 'utf8'));
    if (!Array.isArray(parsed?.pending)) throw new Error('bad shape');
    return parsed.pending;
  } catch (e) {
    if (e?.code === 'ENOENT') return [];
    throw new Error(`drop-intent record ${pendingPath(root, env)} is unreadable — refusing to drop anything until it is fixed`);
  }
}
