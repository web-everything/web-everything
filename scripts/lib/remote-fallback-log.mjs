/**
 * @file scripts/lib/remote-fallback-log.mjs
 * @description Best-effort attribution row when verify-lane takes a LOCAL heavy slot, so
 *   the heavy report no longer shows "NO FALLBACK LOGGED". Same row shape as heavy-admission's recorder
 *   (ts, reason, detail, lane, kind). Logging only: never throws, changes no routing decision.
 *   Local decisions go to separate heavy-attribution/ history without creating pool directories.
 *   Also reads both JSONL histories and summarizes real fallback causes separately from advisory warnings.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

const MAX_BYTES = 512 * 1024;
const bounded = value => String(value).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, '?').slice(0, 4096);

/** Prefer the lock-root sibling; an absent pool must not be created just to log a bypass.
 * Keep all three locations readable after a later run creates the pool/admission parent. */
export const attributionLogPaths = lockRoot => {
  const root = resolve(lockRoot);
  const poolId = `${basename(root).replace(/[^a-zA-Z0-9_-]/g, '_')}-${createHash('sha256').update(root).digest('hex')}`;
  const parent = dirname(root);
  const parents = [parent, dirname(parent), dirname(dirname(parent))];
  return [...new Set(parents)].map(root => join(root, 'heavy-attribution', poolId, 'local-decisions.jsonl'));
};
export const attributionLogPath = lockRoot => attributionLogPaths(lockRoot)
  .find(file => existsSync(dirname(dirname(dirname(file))))) ?? attributionLogPaths(lockRoot)[0];

/** Create only attribution directories; never recursively create a missing pool ancestor. */
export function prepareAttributionLog(file) {
  for (const dir of [dirname(dirname(file)), dirname(file)]) {
    try { mkdirSync(dir); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

export const ADVISORY_REASONS = new Set(['credential-warn']);

/** Match the admission wrapper's canonical reason without changing its routing decision. */
export const localDecisionLogReason = decision => decision.needsGit ? 'needs-git' : decision.reason;

/** Recognize only local decision strings produced by heavy-admission and verify-lane, not unknown failures. */
export function isLocalDecisionReason(reason) {
  if (typeof reason !== 'string') return false;
  if (['explicit-local', 'explicit-container', 'admission-off', 'ci-bypass', 'admission-bypass', 'no-pool', 'held', 'raw-command', 'vitest-related-local-only', 'no-checkout-admission-wrapper', 'base-comparison-rerun'].includes(reason)) return true;
  if (/^remote\.enabled=false \([^()\r\n]+\)$/.test(reason)) return true;
  const match = /^remote\.enabled=true \([^()\r\n]+\); (.+)$/.exec(reason);
  if (!match) return false;
  if (match[1] === 'load-unreadable') return true;
  const number = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?';
  const load = new RegExp(`^loadPerCore=(${number}) <= (${number})$`).exec(match[1]);
  return !!load && Number.isFinite(Number(load[1])) && Number.isFinite(Number(load[2]))
    && Number(load[1]) <= Number(load[2]);
}

/** Pure aggregation. Unknown reasons remain real; ties keep the first encountered cause. */
export function summarize(rows) {
  const realCounts = new Map();
  const advisoryCounts = new Map();
  let total = 0;
  let advisory = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const reason = typeof row.reason === 'string' && row.reason ? row.reason : 'unknown';
    const isAdvisory = ADVISORY_REASONS.has(reason) || isLocalDecisionReason(reason);
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
  const primary = readOneLog(file);
  if (basename(file) !== 'remote-fallbacks.jsonl') return primary;
  return attributionLogPaths(dirname(file)).map(readOneLog).reduce((all, log) => ({
    rows: [...all.rows, ...log.rows], invalid: all.invalid + log.invalid,
    partial: all.partial + log.partial, missing: all.missing && log.missing,
  }), primary);
}

function readOneLog(file) {
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
    // Storage describes the producer, independently of advisory/failure classification.
    const file = attributionLogPath(lockRoot);
    const row = { ts: new Date(now()).toISOString(), reason: bounded(reason ?? 'unknown'), detail: detail == null ? null : bounded(detail), lane: basename(String(repo)), kind: kind == null ? null : bounded(kind) };
    prepareAttributionLog(file);
    // Append (atomic for one small write); trim only when oversized, so concurrent writers never rewrite each other.
    if (existsSync(file) && statSync(file).size > MAX_BYTES) writeFileSync(file, readFileSync(file, 'utf8').slice(-MAX_BYTES / 2), 'utf8');
    appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
    return row;
  } catch { return null; }
}
