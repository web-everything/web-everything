/** Round-robin cursor for the per-tick prevention drain: one small non-JSON-named record beside the batch states. */
import { accessSync, constants, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const drainCursorPath = stateDir => join(stateDir, 'prevention-drain-cursor.state');

// A cursor that could not be persisted lives here for the rest of the process, so a refused card still goes behind the
// others on the next tick instead of being retried at the head forever.
const memory = new Map();
let ticks = 0;

export function readDrainCursor(path) {
  const held = memory.get(path);
  if (held && !held.persisted) return held.value;
  try { const value = JSON.parse(readFileSync(path, 'utf8')); return value && typeof value === 'object' ? value : {}; } catch { return held?.value ?? {}; }
}

/** Merge `patch` into the cursor. Best-effort: a failed write keeps the cursor in memory, never raises. Returns whether it persisted. */
export function writeDrainCursor(path, patch) {
  const value = { ...readDrainCursor(path), ...patch };
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`);
    renameSync(temporary, path);
    memory.set(path, { value, persisted: true });
    return true;
  } catch {
    try { rmSync(temporary, { force: true }); } catch { /* nothing more to clean */ }
    memory.set(path, { value, persisted: false });
    return false;
  }
}

/** Test seam: forget the in-memory cursors. */
export const resetDrainCursorMemory = () => { memory.clear(); ticks = 0; };

/**
 * Start offset for a drain that has NO cursor value to resume from while the cursor cannot be persisted (the first tick of
 * a process, or an unwritable directory). It hashes the pid with a process-local tick count, so it does not align with the
 * tick period; a persistable cursor needs no seed (head-first, then it advances).
 */
export function cursorSeed(path) {
  const held = memory.get(path);
  let writable = true;
  try { accessSync(dirname(path), constants.W_OK); } catch { writable = false; }
  if (writable && !(held && !held.persisted)) return undefined;
  return createHash('sha256').update(`${process.pid}:${++ticks}`).digest().readUInt32BE(0);
}

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
