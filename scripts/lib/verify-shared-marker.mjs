/**
 * verify-shared-marker.mjs — the SHARED per-sha verify marker store (VERIFY-MARKER-PER-SHA).
 *
 * The lane marker lives in one clone's `.git/`, so a green verified in lane A was refused as unverified by open-pr from
 * lane B at the same sha. This store keys a record on repo + exact 40-hex sha + gate (`<dir>/<repo>/<gate>/<sha>.json`).
 *
 * FAIL CLOSED, in four layers:
 *  1. RUN GENERATION. Every verify run has a generation (`newSharedGeneration`). A run START writes a `running` tombstone
 *     carrying it (`withdrawSharedVerifyMarker`), which supersedes whatever green was there; only the run whose tombstone
 *     is still in place may publish (`publishSharedVerifyMarker`), so an older finisher can never overwrite a newer run.
 *  2. WHAT IT VOUCHES FOR. A published record stores the executed gate, suites, policy key, `gateExplicit: false`,
 *     `local: false`. The reader accepts only a finished exit-0 green whose policy key equals the consumer's and whose tree
 *     hash equals the hash the READER recomputed.
 *  3. THE FILE ITSELF. Any stat/read error other than ENOENT on the leaf is `{ corrupt: true }`; the leaf and every parent
 *     up to the store root must be owner-only, owned by this user and not symlinks; the leaf is opened with O_NOFOLLOW and
 *     validated on the opened descriptor.
 *  4. Anything unrecognised returns `{ corrupt: true }` or the stored `running` record, which the delivery gate refuses.
 */
import { mkdirSync, writeFileSync, renameSync, lstatSync, openSync, fstatSync, readFileSync, closeSync, unlinkSync, constants } from 'node:fs';
import { join, dirname } from 'node:path';

const SHA_RE = /^[0-9a-f]{40}$/;
const KEY_PART_RE = /^[A-Za-z0-9._-]+$/;

export function sharedMarkerPath({ dir, repo, gate = 'default', sha }) {
  const repoKey = String(repo ?? '').replace(/\//g, '__');
  if (!dir || !SHA_RE.test(String(sha)) || !KEY_PART_RE.test(repoKey) || !KEY_PART_RE.test(String(gate ?? ''))) return null;
  return join(dir, repoKey, gate, `${sha}.json`);
}

/** A run generation: sortable (zero-padded ms clock) and unique per process. */
export function newSharedGeneration(now = Date.now(), pid = process.pid) {
  return `${String(now).padStart(16, '0')}-${String(pid).padStart(8, '0')}`;
}

const ownerOnly = (st, uid) => (uid === undefined || st.uid === uid) && (st.mode & 0o077) === 0;

function writeRecord(file, record) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Raw, unvalidated read of the current record (writer side only: it decides ordering, never acceptance). */
function readRaw(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Run START (and any later non-green result): replace the shared record with a `running` tombstone for this generation.
 * Refused (`superseded`) when a NEWER generation already owns the file. A tombstone that cannot be written falls back to
 * removing the file. Returns `'written' | 'superseded' | 'failed'`; never throws. NOT limited to pool lanes: a failure in
 * any checkout must invalidate a stale green.
 */
export function withdrawSharedVerifyMarker({ dir, repo, gate = 'default', sha, generation, reason = 'running' }) {
  const file = sharedMarkerPath({ dir, repo, gate, sha });
  if (!file || typeof generation !== 'string') return 'failed';
  const cur = readRaw(file);
  if (cur && typeof cur.generation === 'string' && cur.generation > generation) return 'superseded';
  try { writeRecord(file, { sha, status: 'running', treeHash: null, generation, reason }); return 'written'; } catch { /* try removal */ }
  try { unlinkSync(file); return 'written'; } catch (e) { return e?.code === 'ENOENT' ? 'written' : 'failed'; }
}

/** Publish a finished green for this run. Only the run whose own `running` tombstone is still current may publish. */
export function publishSharedVerifyMarker({ dir, repo, gate = 'default', sha, generation, record, lane = null, nowIso = new Date().toISOString() }) {
  const file = sharedMarkerPath({ dir, repo, gate, sha });
  if (!file || !record || record.sha !== sha || typeof generation !== 'string') return false;
  if (record.status !== 'green' || record.exitCode !== 0 || record.skipped || record.gateExplicit || record.local) return false;
  if (typeof record.treeHash !== 'string' || !record.treeHash || typeof record.policyKey !== 'string') return false;
  const cur = readRaw(file);
  if (!cur || cur.status !== 'running' || cur.generation !== generation) return false;
  try {
    writeRecord(file, { ...record, gateExplicit: false, local: false, generation, sharedFrom: { lane, at: nowIso } });
    return true;
  } catch { return false; }
}

/** Test/low-level writer: store a record as-is (no ownership check). Prefer withdraw + publish in production. */
export function writeSharedVerifyMarker({ dir, repo, gate = 'default', record, lane = null, nowIso = new Date().toISOString() }) {
  const file = sharedMarkerPath({ dir, repo, gate, sha: record?.sha });
  if (!file || !record || typeof record.treeHash !== 'string' || !record.treeHash) return false;
  try { writeRecord(file, { ...record, sharedFrom: { lane, at: nowIso } }); return true; } catch { return false; }
}

/**
 * Read the shared record for exactly `sha`. `treeHash` and `policyKey` are the READER's own values. Returns null only when
 * the leaf (or a parent) genuinely does not exist; every other problem is `{ corrupt: true }`.
 */
export function readSharedVerifyMarker({ dir, repo, gate = 'default', sha, treeHash, policyKey, uid = process.getuid?.() }) {
  const file = sharedMarkerPath({ dir, repo, gate, sha });
  if (!file) return null;
  const corrupt = { corrupt: true };
  try {
    // Validate every directory from the store root down to the leaf's parent: owner-only, not a symlink.
    const chain = [];
    for (let p = dirname(file); ; p = dirname(p)) { chain.unshift(p); if (p === dir || p === dirname(p)) break; }
    for (const p of chain) {
      let st;
      try { st = lstatSync(p); } catch (e) { if (e?.code === 'ENOENT') return null; return corrupt; }
      if (st.isSymbolicLink() || !st.isDirectory() || !ownerOnly(st, uid)) return corrupt;
    }
    let fd;
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (e) { if (e?.code === 'ENOENT') return null; return corrupt; }
    let text;
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || !ownerOnly(st, uid)) return corrupt;
      text = readFileSync(fd, 'utf8');
    } finally { closeSync(fd); }
    const rec = JSON.parse(text);
    if (!rec || typeof rec !== 'object' || Array.isArray(rec) || rec.sha !== sha) return corrupt;
    if (rec.status === 'running') return rec;
    // Only a finished, genuinely green default-gate record of this policy, at this exact tree, is usable.
    if (rec.status !== 'green' || rec.exitCode !== 0 || rec.skipped || rec.gateExplicit !== false || rec.local !== false) return corrupt;
    if (typeof rec.generation !== 'string' || typeof rec.suites !== 'string' || typeof rec.policyKey !== 'string') return corrupt;
    if (typeof policyKey !== 'string' || !policyKey || rec.policyKey !== policyKey) return corrupt;
    if (typeof treeHash !== 'string' || !treeHash || rec.treeHash !== treeHash) return corrupt;
    return rec;
  } catch { return corrupt; }
}

/** The marker a gate should judge: the lane's own marker when it is for `headSha`; a lane-local running/red/corrupt record
 *  is never replaced by the shared copy. Only an absent marker, or a stale GREEN for another sha, yields to a shared green. */
export function resolveMarkerWithShared({ local, headSha, readShared }) {
  if (local && !local.corrupt && local.sha === headSha) return local;
  if (local && (local.corrupt || local.status !== 'green')) return local;
  const shared = readShared();
  return shared ?? local;
}
