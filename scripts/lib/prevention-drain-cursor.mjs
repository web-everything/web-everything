/** Round-robin cursor for the per-tick prevention drain: one small non-JSON-named record beside the batch states. */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const drainCursorPath = stateDir => join(stateDir, 'prevention-drain-cursor.state');

export function readDrainCursor(path) {
  try { const value = JSON.parse(readFileSync(path, 'utf8')); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}

/** Merge `patch` into the cursor. Best-effort: an unwritable cursor degrades to head-first order, never to an error. */
export function writeDrainCursor(path, patch) {
  try {
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ ...readDrainCursor(path), ...patch })}\n`);
    renameSync(temporary, path);
  } catch { /* head-first order next tick */ }
}

/** Sorted `names` resumed after `last`: everything after it first, then the already-handled ones behind. */
export function rotateAfter(names, last) {
  if (typeof last !== 'string') return names;
  return [...names.filter(name => name > last), ...names.filter(name => name <= last)];
}
