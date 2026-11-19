/** Durable successful freeze reads; expiry uses the fetch timestamp, never file mtime. */
import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';

export function resolveFreezeLastGoodPath(env = process.env) {
  if (env.WE_RED_MAIN_FREEZE) return `${env.WE_RED_MAIN_FREEZE}.last-good.json`;
  // Hermetic callers inject a file; never share operator evidence with a unit test.
  if ((env.VITEST || env.WE_UNDER_TEST) && !env.WE_COORDINATION_ROOT) return null;
  return join(resolveCoordinationRoot({ env }), 'red-main-freeze.last-good.json');
}

export const goodFreezeRead = result => result != null && !result.error && typeof result.frozen === 'boolean';

// A failed replacement must never make older, contradictory evidence reusable.
const failedWrites = new Set();

export function readFreezeLastGood(file, { now, ttlMin, source } = {}) {
  if (!file || failedWrites.has(file) || !Number.isFinite(ttlMin) || ttlMin <= 0) return null;
  try {
    const cached = JSON.parse(readFileSync(file, 'utf8'));
    const ageMs = now - cached.fetchedAt;
    if (!Number.isFinite(cached.fetchedAt) || !Number.isFinite(ageMs) || ageMs < 0 || ageMs >= ttlMin * 60_000 ||
        !goodFreezeRead(cached.result) || (source != null && cached.result.source !== source)) return null;
    return { result: cached.result, ageMs };
  } catch { return null; }
}

export function writeFreezeLastGood(file, result, fetchedAt) {
  if (!file || !goodFreezeRead(result)) return;
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temp, JSON.stringify({ fetchedAt, result }) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temp, file);
    failedWrites.delete(file);
  } catch {
    failedWrites.add(file);
    // Remove stale evidence for future processes too; keep this process closed if removal also fails.
    try { rmSync(file, { force: true }); } catch { /* Reuse stays blocked until a successful write. */ }
  }
  finally { try { rmSync(temp, { force: true }); } catch { /* best effort */ } }
}
