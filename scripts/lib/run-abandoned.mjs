/**
 * R755: abandonment is a sidecar; never rewrite a run record.
 * A record mtime NEWER than its tombstone wins (alive); equal or older means abandoned.
 * Version-bound tombstones additionally require the exact observed record stat identity; a mismatch is alive.
 * Unreadable/malformed evidence fails closed toward alive. Creation is exclusive; only a STALE sidecar (one that
 * no longer abandons its record) is replaced, atomically — never a valid one.
 */
import * as nodeFs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { runPath, resolveRunsDir } from '../operations/run-store.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonRejecting = ['accept', 'accepted', 'prevention-outstanding', 'needs-human', 'abstain', 'review:accepted', 'review:pending', 'clear-human', 'rearm'];
const decisionKeys = new Set(['to', 'target', 'addLabel', 'label', 'verdict', 'outcome', 'decision']);
function rejectingPayload(payload, depth = 0) {
  if (!object(payload) || depth > 16) return true;
  for (const [key, value] of Object.entries(payload)) {
    if (decisionKeys.has(key) && (typeof value !== 'string' || !nonRejecting.includes(value))) return true;
    if (key === 'notice' && (typeof value !== 'string' || !/^PR .+ — human review accepted(?: by .+)?\.$/.test(value))) return true;
    if (object(value) && rejectingPayload(value, depth + 1)) return true;
    if (Array.isArray(value) && value.some(item => object(item) && rejectingPayload(item, depth + 1))) return true;
  }
  return false;
}

/** All rejection sources share one fail-closed check. Unknown present evidence must never erase a send-back. */
export function hasRejectingReviewVerdict(run) {
  if (!object(run)) return true;
  if (run.verdict != null) {
    const verdict = typeof run.verdict === 'string' ? run.verdict : run.verdict?.verdict;
    if (!['accept', 'prevention-outstanding', 'needs-human'].includes(verdict)) return true;
  }
  if (run.findings != null && !object(run.findings)) return true;
  if (run.findings?.confirm != null && !['accept', 'abstain'].includes(run.findings.confirm)) return true;
  // Missing effects occur in historical records; a present unreadable list is never proof of safety.
  if (run.effects === undefined) return false;
  if (!Array.isArray(run.effects)) return true;
  return run.effects.some(effect => {
    if (!object(effect) || typeof effect.status !== 'string' || typeof effect.type !== 'string') return true;
    if (['applied', 'failed', 'skipped'].includes(effect.status)) return false;
    if (!['declared', 'pending', 'in-flight', 'refused'].includes(effect.status)) return true;
    // Historical effect records omit payloads. Absence carries no rejection evidence;
    // a present malformed payload still fails closed below.
    if (effect.payload === undefined) return false;
    if (rejectingPayload(effect.payload)) return true;
    if (['review.label-swap', 'review.notice'].includes(effect.type)) {
      if (!object(effect.payload)) return true;
      return effect.type === 'review.label-swap'
        ? !['to', 'target', 'addLabel', 'label', 'verdict'].some(key => Object.hasOwn(effect.payload, key))
        : !['notice', 'to', 'target', 'verdict', 'outcome'].some(key => Object.hasOwn(effect.payload, key));
    }
    return false;
  });
}

export function abandonedPath(id, dir = resolveRunsDir()) {
  // Validate with the same grammar as the record, and derive from the resolved/overridden runs dir.
  runPath(id, dir);
  return join(dirname(dir), 'run-tombstones', `${id}.json`);
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
  if (isRunAbandoned(id, dir, { fs })) return { written: false, alreadyAbandoned: true };
  fs.mkdirSync(dirname(path), { recursive: true });
  let fd;
  try { fd = fs.openSync(path, 'wx'); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (isRunAbandoned(id, dir, { fs })) return { written: false, alreadyAbandoned: true };
    // A poisoned sidecar (a directory, EACCES, ENOSPC) must not abort a whole sweep: report it so the caller keeps this id.
    try { replaceStaleTombstone(fs, path, body); }
    catch (err) { return { written: false, alreadyAbandoned: false, staleUnreplaceable: String(err?.code ?? err?.message ?? 'unknown') }; }
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

/** Read a valid version/mtime-bound tombstone, including read-only legacy sidecars. */
export function readRunAbandonment(id, dir, { fs = nodeFs } = {}) {
  let paths;
  try {
    paths = [abandonedPath(id, dir), runPath(id, dir).replace(/\.json$/, '.abandoned.json')];
  } catch { return null; }
  for (const path of paths) {
    const tombstone = readTombstone(path, id, dir, fs);
    if (tombstone) return tombstone;
  }
  return null;
}

function readTombstone(path, id, dir, fs) {
  try {
    const t = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (!t || typeof t !== 'object' || Array.isArray(t) || typeof t.at !== 'string'
      || !Number.isFinite(Date.parse(t.at)) || typeof t.reason !== 'string' || !t.reason
      || typeof t.by !== 'string' || !t.by || !t.probes || typeof t.probes !== 'object' || Array.isArray(t.probes)) return null;
    const recordStat = fs.statSync(runPath(id, dir));
    // Older, unbound sidecars retain the original mtime rule. A present but invalid binding fails closed.
    if (Object.hasOwn(t.probes, 'recordVersion') && (typeof t.probes.recordVersion !== 'string'
      || t.probes.recordVersion !== runRecordVersion(recordStat))) return null;
    return isAbandonedGivenStats(fs.statSync(path).mtimeMs, recordStat.mtimeMs) ? t : null;
  } catch { return null; }
}

export function isRunAbandoned(id, dir, options) {
  return readRunAbandonment(id, dir, options) !== null;
}

export function isRunTerminalOrAbandoned(record, id, dir, isTerminal) {
  return !!isTerminal(record) || isRunAbandoned(id, dir);
}
