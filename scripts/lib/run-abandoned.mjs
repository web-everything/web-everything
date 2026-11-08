/**
 * R755: abandonment is a sidecar; never rewrite a run record.
 * A record mtime NEWER than its tombstone wins (alive); equal or older means abandoned.
 * Version-bound tombstones additionally require the exact observed record stat identity; a mismatch is alive.
 * Unreadable/malformed evidence fails closed toward alive. Creation is exclusive, never replacement.
 */
import * as nodeFs from 'node:fs';
import { runPath, resolveRunsDir } from '../operations/run-store.mjs';

export function abandonedPath(id, dir = resolveRunsDir()) {
  return runPath(id, dir).replace(/\.json$/, '.abandoned.json');
}

export function markRunAbandoned({ id, dir, reason, probes, by, now = Date.now(), fs = nodeFs }) {
  const body = JSON.stringify({ at: new Date(now).toISOString(), reason, probes, by }) + '\n';
  let fd;
  try { fd = fs.openSync(abandonedPath(id, dir), 'wx'); }
  catch (e) {
    if (e.code === 'EEXIST') return { written: false, alreadyAbandoned: true };
    throw e;
  }
  try { fs.writeFileSync(fd, body, 'utf8'); }
  finally { fs.closeSync(fd); }
  return { written: true, alreadyAbandoned: false };
}

export function isAbandonedGivenStats(tombstoneMtimeMs, recordMtimeMs) {
  return Number.isFinite(tombstoneMtimeMs) && Number.isFinite(recordMtimeMs)
    && recordMtimeMs <= tombstoneMtimeMs;
}

/** Shared record identity for the reaper snapshot and tombstone reader (including atomic replacements). */
export function runRecordVersion(stat) {
  const fields = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
  if (!fields.every(Number.isFinite)) throw new TypeError('unreadable run record version');
  return JSON.stringify(fields);
}

export function isRunAbandoned(id, dir, { fs = nodeFs } = {}) {
  try {
    const path = abandonedPath(id, dir);
    const t = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (!t || typeof t !== 'object' || Array.isArray(t) || typeof t.at !== 'string'
      || !Number.isFinite(Date.parse(t.at)) || typeof t.reason !== 'string' || !t.reason
      || typeof t.by !== 'string' || !t.by || !t.probes || typeof t.probes !== 'object' || Array.isArray(t.probes)) return false;
    const recordStat = fs.statSync(runPath(id, dir));
    // Older, unbound sidecars retain the original mtime rule. A present but invalid binding fails closed.
    if (Object.hasOwn(t.probes, 'recordVersion') && (typeof t.probes.recordVersion !== 'string'
      || t.probes.recordVersion !== runRecordVersion(recordStat))) return false;
    return isAbandonedGivenStats(fs.statSync(path).mtimeMs, recordStat.mtimeMs);
  } catch { return false; }
}

export function isRunTerminalOrAbandoned(record, id, dir, isTerminal) {
  return !!isTerminal(record) || isRunAbandoned(id, dir);
}
