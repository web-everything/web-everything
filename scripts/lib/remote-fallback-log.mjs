/**
 * @file scripts/lib/remote-fallback-log.mjs
 * @description Best-effort row in `<lockRoot>/remote-fallbacks.jsonl` when verify-lane takes a LOCAL heavy slot, so
 *   the heavy report no longer shows "NO FALLBACK LOGGED". Same row shape as heavy-admission's recorder
 *   (ts, reason, detail, lane, kind). Logging only: never throws, changes no routing decision.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const MAX_BYTES = 512 * 1024;
const bounded = value => String(value).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, '?').slice(0, 4096);

export function recordLocalSlotFallback({ lockRoot, reason, detail, repo, kind, now = () => Date.now() } = {}) {
  try {
    const file = join(lockRoot, 'remote-fallbacks.jsonl');
    const row = { ts: new Date(now()).toISOString(), reason: bounded(reason ?? 'unknown'), detail: detail == null ? null : bounded(detail), lane: basename(String(repo)), kind: kind == null ? null : bounded(kind) };
    mkdirSync(lockRoot, { recursive: true });
    // Append (atomic for one small write); trim only when oversized, so concurrent writers never rewrite each other.
    if (existsSync(file) && statSync(file).size > MAX_BYTES) writeFileSync(file, readFileSync(file, 'utf8').slice(-MAX_BYTES / 2), 'utf8');
    appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
    return row;
  } catch { return null; }
}
