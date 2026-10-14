/**
 * Card 311 — incrementally index detached-wrapper pairs by run-file mtime and size.
 * WE_LEASE_REAPER_RUN_SCAN=full opts out and keeps the original full scan.
 * WE_LEASE_REAPER_RUN_SCAN_MAX_AGE_MS limits file age; 0 keeps runs of every age.
 * The sibling JSON index is disposable: corrupt caches rebuild, and failed writes
 * never prevent a sweep. Records themselves are never changed by this reader.
 */
import * as nodeFs from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { createFileRunStore, isValidRunId, listRunIds, runPath } from '../operations/run-store.mjs';
import { detachedWrapperPidsBySession } from './lease-reaper.mjs';

const STANDARD = Object.freeze({ mode: 'index', maxAgeMs: 0 });

/** Resolve card 311's scan policy through the shared cascade. Never throws. */
export function resolveRunScanSettings(env = process.env) {
  try {
    const value = env?.WE_LEASE_REAPER_RUN_SCAN_MAX_AGE_MS;
    const n = Number(value);
    const r = cascadePolicy('leaseReaperRunScan', undefined, {
      env, standard: STANDARD,
      envValues: {
        mode: env?.WE_LEASE_REAPER_RUN_SCAN,
        maxAgeMs: value != null && value !== '' && Number.isInteger(n) && n >= 0 ? n : undefined,
      },
      valid: {
        mode: (v) => v === 'index' || v === 'full',
        maxAgeMs: (v) => Number.isInteger(v) && v >= 0,
      },
    });
    return { ...STANDARD, ...(r.value || {}), source: r.sources || {} };
  } catch { return { ...STANDARD, source: { mode: 'standard', maxAgeMs: 'standard' } }; }
}

function validIndex(index) {
  return index !== null && typeof index === 'object' && !Array.isArray(index)
    && Object.entries(index).every(([id, e]) => isValidRunId(id)
      && e !== null && typeof e === 'object'
      && Number.isFinite(e.m) && Number.isFinite(e.s) && e.s >= 0
      && Array.isArray(e.p) && e.p.every((pair) => Array.isArray(pair) && pair.length === 2
        && typeof pair[0] === 'string' && pair[0].trim() !== ''
        && Number.isInteger(pair[1]) && pair[1] > 0));
}

/**
 * Read one record at a time on cache misses; unchanged files require only a stat.
 * Merge in the store's sorted id order, preserving the full reader's last-wins semantics.
 * Directory-listing failures propagate so the pass shell can fall back to full mode.
 */
export function readDetachedWrapperPidsIndexed({
  dir, indexPath = join(dirname(dir), 'lease-reaper-run-index.json'),
  maxAgeMs = 0, nowMs = Date.now(), fs = nodeFs, read = createFileRunStore(dir).read,
}) {
  const started = Date.now();
  const stats = { listed: 0, statted: 0, parsed: 0, reused: 0, skippedOld: 0, ms: 0 };
  let index = {};
  try {
    const cached = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (validIndex(cached)) index = cached;
  } catch { /* missing/unreadable/corrupt index: rebuild */ }

  // Use the canonical listing normally; injected fs mirrors its exact filename filter and order.
  const ids = fs === nodeFs ? listRunIds(dir) : (fs.existsSync(dir) ? fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter(isValidRunId).sort() : []);
  stats.listed = ids.length;
  const next = Object.create(null);
  const bySession = new Map();
  for (const id of ids) {
    let entry;
    try {
      stats.statted++;
      const { mtimeMs: m, size: s } = fs.statSync(runPath(id, dir));
      if (maxAgeMs > 0 && nowMs - m > maxAgeMs) { stats.skippedOld++; continue; }
      const cached = Object.hasOwn(index, id) ? index[id] : null;
      if (cached && cached.m === m && cached.s === s) {
        entry = cached;
        stats.reused++;
      } else {
        stats.parsed++;
        const record = read(id);
        if (!record) continue; // disappeared mid-sweep: never cache absence
        entry = { m, s, p: [...detachedWrapperPidsBySession([record])] };
      }
    } catch { continue; /* one unreadable/corrupt run never blocks or enters the cache */ }
    next[id] = entry;
    for (const [session, pid] of entry.p) bySession.set(session, pid);
  }

  const serialized = JSON.stringify(next);
  if (serialized !== JSON.stringify(index)) {
    const tmp = `${indexPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, serialized, 'utf8');
      fs.renameSync(tmp, indexPath);
    } catch { /* cache persistence is best-effort */ }
    finally { try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ } }
  }
  stats.ms = Date.now() - started;
  return { bySession, stats };
}
