/**
 * Catch-up round snapshot: one open-PR seed shared by every single-PR fast drain of the same catch-up round.
 *
 * Each catch-up fast drain used to read the host-shared open-PR snapshot on its own (`listing.snapshot`), and
 * that read often refreshed it (20–40 s), because the shared snapshot's short TTL and dirty marks expire between
 * drains. The round now names one file (`WE_DRAIN_ROUND_SNAPSHOT`). The first drain that misses writes the rows it
 * read there with a captured-at time; later drains of the round reuse them while younger than
 * drain.roundSnapshotMaxAgeSec (standard 120; 0 disables; env WE_DRAIN_ROUND_SNAPSHOT_MAX_AGE_SEC).
 *
 * What this does NOT change: the rows only SEED the fast drain. The drain still re-reads its target PR live
 * (`listing.target`: head, labels, checks, mergeability, state) and merges it over the seed, and it still lists the
 * live open set (`listing.pages`), where a seed row is used only when its updatedAt and head sha match the live
 * row. Every merge-gating per-PR fact is therefore read live. Any unreadable, foreign, too-old or field-short file
 * is ignored and the drain reads the shared snapshot as before.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cascadePolicy } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { writeJsonAtomic } from './atomic-json-file.mjs';

export const ROUND_SNAPSHOT_ENV = 'WE_DRAIN_ROUND_SNAPSHOT';
const VERSION = 1;

export function readRoundSnapshotSetting({ env = process.env, tool, platform, log } = {}) {
  const raw = env.WE_DRAIN_ROUND_SNAPSHOT_MAX_AGE_SEC;
  const r = cascadePolicy('drain', tool ?? (env.VITEST || env.WE_UNDER_TEST ? {} : readSettings().drain), {
    env, platform, ...(log ? { log } : {}),
    standard: { roundSnapshotMaxAgeSec: 120 },
    valid: { roundSnapshotMaxAgeSec: v => Number.isInteger(v) && v >= 0 && v <= 600 },
    envValues: { roundSnapshotMaxAgeSec: raw === undefined ? undefined : Number(raw) },
  });
  return { maxAgeSec: r.value.roundSnapshotMaxAgeSec, source: r.sources?.roundSnapshotMaxAgeSec ?? 'standard' };
}

const fieldList = fields => (Array.isArray(fields) ? fields : String(fields ?? '').split(','))
  .map(f => String(f).trim()).filter(Boolean);

/**
 * The round's rows, or `{ rows: null, why }`. Reuse needs the same repo, every wanted field, a valid captured-at
 * no later than now, and an age under the max age.
 */
export function readRoundSnapshot({ path, repo, fields, maxAgeSec, now = Date.now(), readFile = readFileSync }) {
  if (!path) return { rows: null, why: 'no round snapshot' };
  if (!(maxAgeSec > 0)) return { rows: null, why: 'disabled' };
  let snap;
  try { snap = JSON.parse(readFile(path, 'utf8')); } catch { return { rows: null, why: 'not written yet' }; }
  if (snap?.version !== VERSION || snap.repo !== repo || !Array.isArray(snap.rows) || !Array.isArray(snap.fields)) {
    return { rows: null, why: 'unusable file' };
  }
  const age = typeof snap.capturedAtMs === 'number' ? now - snap.capturedAtMs : NaN;
  if (!Number.isFinite(age) || age < 0) return { rows: null, why: 'bad captured-at' };
  if (age >= maxAgeSec * 1000) return { rows: null, why: `stale (${Math.round(age / 1000)}s >= ${maxAgeSec}s)` };
  const missing = fieldList(fields).filter(f => !snap.fields.includes(f));
  if (missing.length) return { rows: null, why: `missing fields ${missing.join(',')}` };
  return { rows: snap.rows, ageMs: age };
}

/** Best effort: a failed write only means later drains read the shared snapshot themselves. */
export function writeRoundSnapshot({ path, repo, fields, rows, now = Date.now() }) {
  if (!path || !Array.isArray(rows)) return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeJsonAtomic(path, { version: VERSION, repo, fields: fieldList(fields), capturedAtMs: now, rows });
    return true;
  } catch { return false; }
}

/** The round file path; old files of this directory (over an hour) are removed best effort. */
export function roundSnapshotPath({ dir, repo, round, pid = process.pid, now = Date.now() }) {
  const key = String(repo || 'cwd').replace(/[^A-Za-z0-9_.-]+/g, '_');
  try {
    for (const name of readdirSync(dir)) {
      if (!/-\d+-r\d+\.json$/.test(name)) continue; // only round files this module names
      const p = join(dir, name);
      try { if (now - statSync(p).mtimeMs > 3_600_000) unlinkSync(p); } catch { /* best effort */ }
    }
  } catch { /* no directory yet */ }
  return join(dir, `${key}-${pid}-r${round}.json`);
}
