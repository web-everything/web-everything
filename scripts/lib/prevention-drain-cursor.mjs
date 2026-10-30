/** Round-robin cursor for the per-tick prevention drain: one small non-JSON-named record beside the batch states. */
import { accessSync, constants, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const drainCursorPath = stateDir => join(stateDir, 'prevention-drain-cursor.state');

// A cursor that cannot be written beside the batch states falls back to a file in the OS temp dir (keyed by the primary
// path), which the NEXT tick's fresh process reads; the process-local copy covers an unwritable temp dir too. Each value
// carries a monotonic `at`, and a read takes whichever of the three copies is newest, so a stale readable primary never
// wins over a newer fallback.
const memory = new Map();
let ticks = 0;
export const fallbackCursorPath = path => join(tmpdir(), `we-drain-cursor-${createHash('sha256').update(path).digest('hex').slice(0, 24)}.state`);

const parse = file => { try { const value = JSON.parse(readFileSync(file, 'utf8')); return value && typeof value === 'object' ? value : undefined; } catch { return undefined; } };

export function readDrainCursor(path) {
  const candidates = [parse(path), parse(fallbackCursorPath(path)), memory.get(path)?.value].filter(Boolean);
  return candidates.reduce((best, value) => (Number(value.at) || 0) >= (Number(best.at) || 0) ? value : best, {});
}

function persist(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, `${JSON.stringify(value)}\n`); renameSync(temporary, file); return true; }
  catch { try { rmSync(temporary, { force: true }); } catch { /* nothing more to clean */ } return false; }
}

/** Merge `patch` into the cursor. Best-effort, never raises. Returns whether it persisted beside the batch states. */
export function writeDrainCursor(path, patch) {
  const previous = readDrainCursor(path);
  const value = { ...previous, ...patch, at: Math.max((Number(previous.at) || 0) + 1, Date.now()) };
  memory.set(path, { value });
  if (persist(path, value)) return true;
  persist(fallbackCursorPath(path), value);
  return false;
}

/** Test seam: forget the in-memory cursors. */
export const resetDrainCursorMemory = () => { memory.clear(); ticks = 0; };

/**
 * Start offset for a drain that has NO cursor value to resume from while the cursor cannot be persisted (the first tick of
 * a process, or an unwritable directory). It hashes the pid with a process-local tick count, so it does not align with the
 * tick period; a persistable cursor needs no seed (head-first, then it advances).
 */
export function cursorSeed(path) {
  let writable = true;
  try { accessSync(dirname(path), constants.W_OK); } catch { writable = false; }
  if (writable && !memory.get(path)) return undefined;
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
