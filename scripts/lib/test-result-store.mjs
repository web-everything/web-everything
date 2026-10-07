/**
 * @file scripts/lib/test-result-store.mjs
 * @description prepare-124 S2 — the shared on-disk store for the test-result cache: one small JSON file per key, one
 * shadow-log file per run, one quarantine marker per test file. No read-modify-write anywhere, so many lanes never race
 * on a shared map. Every write is `<name>.<pid>.<random>.tmp` then `rename` (atomic on one volume); a reader treats a
 * missing or unparsable file as a miss. Nothing here decides anything — see test-cache-shadow.mjs.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

const sha = (s) => createHash('sha256').update(s).digest('hex');

/** Write `text` to `path` atomically (creates parent dirs). */
export function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export const entryPath = (dir, key) => join(dir, 'entries', key.slice(0, 2), `${key}.json`);
export const quarantinePath = (dir, file) => join(dir, 'quarantine', `${sha(file)}.json`);
export const shadowLogPath = (dir, runId, date = new Date()) => join(dir, 'shadow', date.toISOString().slice(0, 10), `${runId}.jsonl`);

/** The stored result for a key, or null (missing / unparsable / a different key inside). */
export function readEntry(dir, key) {
  const entry = readJson(entryPath(dir, key));
  return entry && entry.key === key ? entry : null;
}

/** Store a result. Last writer wins: two lanes writing one key write the same meaning. */
export function writeEntry(dir, key, entry) {
  atomicWrite(entryPath(dir, key), `${JSON.stringify({ ...entry, key })}\n`);
}

/** Quarantine record for a test file path, or null. */
export function readQuarantine(dir, file) {
  const q = readJson(quarantinePath(dir, file));
  return q && q.file === file ? q : null;
}

export function writeQuarantine(dir, file, info) {
  atomicWrite(quarantinePath(dir, file), `${JSON.stringify({ ...info, file })}\n`);
}

export function isQuarantined(dir, file) {
  return existsSync(quarantinePath(dir, file)) && readQuarantine(dir, file) !== null;
}

/** One shadow-log file per run (lines never interleave across runs). */
export function writeShadowLog(dir, runId, records, date = new Date()) {
  const path = shadowLogPath(dir, runId, date);
  atomicWrite(path, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
  return path;
}
