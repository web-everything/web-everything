/** Round-robin cursor for the per-tick prevention drain: one small non-JSON-named record beside the batch states. */
import { accessSync, constants, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

/** Can the cursor be persisted at all? When it cannot, fairness falls back to a time-seeded start (see {@link rotateAfter}). */
export function cursorUsable(path) {
  try { accessSync(dirname(path), constants.W_OK); return true; } catch { return false; }
}
/** Minute-granular seed for the unpersistable-cursor fallback: successive ticks start at different cards. */
export const cursorSeed = (path, now = Date.now) => cursorUsable(path) ? undefined : Math.floor(now() / 60_000);

/**
 * Sorted `names` resumed after `last`: everything after it first, then the already-handled ones behind. With no
 * cursor to resume from, `seed` (only given when the cursor cannot be persisted) rotates the start so a refused head
 * cannot be retried forever ahead of the others; no seed keeps the head-first order.
 */
export function rotateAfter(names, last, seed) {
  if (typeof last !== 'string') {
    if (!Number.isInteger(seed) || names.length === 0) return names;
    const at = seed % names.length;
    return [...names.slice(at), ...names.slice(0, at)];
  }
  return [...names.filter(name => name > last), ...names.filter(name => name <= last)];
}
