/**
 * R755: abandonment is a sidecar; never rewrite a run record.
 * A record mtime NEWER than its tombstone wins (alive); equal or older means abandoned.
 * Version-bound tombstones additionally require the exact observed record stat identity; a mismatch is alive.
 * Unreadable/malformed evidence fails closed toward alive. Creation is exclusive; only a STALE sidecar (one that
 * no longer abandons its record) is replaced, atomically — never a valid one.
 */
import * as nodeFs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runPath, resolveRunsDir } from '../operations/run-store.mjs';

export function abandonedPath(id, dir = resolveRunsDir()) {
  return runPath(id, dir).replace(/\.json$/, '.abandoned.json');
}

/**
 * Creation is exclusive. An existing sidecar that is still a VALID tombstone for the current record (a concurrent
 * reaper's) is kept: `alreadyAbandoned`. One that no longer abandons the record is STALE: a resumed run whose record
 * version or mtime moved, or an empty/partial file left by a crash between open and write. Left in place it would make
 * the run permanently un-reapable, so it is replaced atomically (temp file + rename, never a partial overwrite).
 */
export function markRunAbandoned({ id, dir, reason, probes, by, now = Date.now(), fs = nodeFs }) {
  const body = JSON.stringify({ at: new Date(now).toISOString(), reason, probes, by }) + '\n';
  const path = abandonedPath(id, dir);
  let fd;
  try { fd = fs.openSync(path, 'wx'); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (isRunAbandoned(id, dir, { fs })) return { written: false, alreadyAbandoned: true };
    replaceStaleTombstone(fs, path, body);
    return { written: true, alreadyAbandoned: false, replacedStale: true };
  }
  try { fs.writeFileSync(fd, body, 'utf8'); }
  finally { fs.closeSync(fd); }
  return { written: true, alreadyAbandoned: false };
}

function replaceStaleTombstone(fs, path, body) {
  // The suffix keeps the temp out of listRunIds and out of the reaper's `<id>.json.<pid>.<x>.tmp` writer match.
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, body, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmp, path);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort; the original error is what matters */ }
    throw e;
  }
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
