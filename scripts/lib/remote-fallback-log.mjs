/**
 * @file scripts/lib/remote-fallback-log.mjs
 * @description Best-effort row in `<lockRoot>/remote-fallbacks.jsonl` when verify-lane takes a LOCAL heavy slot, so
 *   the heavy report no longer shows "NO FALLBACK LOGGED". Same row shape as heavy-admission's recorder
 *   (ts, reason, detail, lane, kind). Logging only: never throws, changes no routing decision.
 *   Also reads JSONL and summarizes real fallback causes separately from advisory warnings.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const MAX_BYTES = 512 * 1024;
const bounded = value => String(value).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, '?').slice(0, 4096);

export const ADVISORY_REASONS = new Set(['credential-warn']);
/** R830/R823: the exact reasons heavy-admission logs for a run that is local by design. Each is a reason, not a failed
 *  remote attempt. Any other reason (a failed load read, an unrouted run, an unknown `local-*`) stays a visible real cause. */
export const LOCAL_BY_DESIGN_REASONS = new Set(['local-flag', 'local-container', 'local-remote-disabled', 'local-below-threshold']);
export const isLocalByDesignReason = reason => LOCAL_BY_DESIGN_REASONS.has(reason);

/** Pure aggregation. Unknown reasons remain real; ties keep the first encountered cause. */
export function summarize(rows) {
  const realCounts = new Map();
  const advisoryCounts = new Map();
  let total = 0;
  let advisory = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const reason = typeof row.reason === 'string' && row.reason ? row.reason : 'unknown';
    const isAdvisory = ADVISORY_REASONS.has(reason) || isLocalByDesignReason(reason);
    const counts = isAdvisory ? advisoryCounts : realCounts;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
    total++;
    if (isAdvisory) advisory++;
  }
  let topReal = null;
  for (const [reason, count] of realCounts) {
    if (!topReal || count > topReal.count) topReal = { reason, count };
  }
  return { total, advisory, real: total - advisory, byReason: Object.fromEntries(realCounts),
    advisoryByReason: Object.fromEntries(advisoryCounts), topReal };
}

/** IO boundary: expose missing/corrupt evidence and count an interrupted final append separately. */
export function readFallbackLog(file) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return { rows: [], invalid: 0, missing: true, partial: 0 };
    throw error;
  }
  const rows = [];
  let invalid = 0;
  let partial = 0;
  const lines = raw.split('\n');
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch {
      if (index === lines.length - 1 && !raw.endsWith('\n')) partial++;
      else invalid++;
      continue;
    }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) invalid++;
    else rows.push(row);
  }
  return { rows, invalid, missing: false, partial };
}

/** Compatibility view for callers that only need valid rows. */
export function readFallbackRows(file) {
  return readFallbackLog(file).rows;
}

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
