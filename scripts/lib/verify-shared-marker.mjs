/**
 * Write-once greens at <coordRoot>/verify-shared/<repo>/<sha>/<policyKey>.json.
 * No revocation or tooling deletion: equivalent greens for the same commit and policy coexist through EEXIST.
 * Manual escape: `rm <coordRoot>/verify-shared/<repo>/<sha>/<policyKey>.json` forces re-verification.
 * A crashed writer can leave a temp file; readers only open the exact final path.
 */
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, linkSync, unlinkSync, lstatSync, fstatSync, readFileSync, constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const SHA = /^[0-9a-f]{40}$/;
const POLICY = /^[0-9a-f]{64}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const FIELDS = ['v', 'writer', 'repo', 'sha', 'policyKey', 'status', 'exitCode', 'executedGate', 'selectionMode', 'deltaBase', 'finishedAt', 'lane'].sort();
const ownerOnly = (st, uid) => Number.isInteger(uid) && st.uid === uid && (st.mode & 0o077) === 0;

export function sharedMarkerPath({ coordRoot, repo, sha, policyKey }) {
  if (typeof coordRoot !== 'string' || !coordRoot || typeof repo !== 'string' || !REPO.test(repo)
    || typeof sha !== 'string' || !SHA.test(sha) || typeof policyKey !== 'string' || !POLICY.test(policyKey)) return null;
  return join(resolve(coordRoot), 'verify-shared', repo.replace(/\//g, '__'), sha, `${policyKey}.json`);
}

function directories(file, coordRoot) {
  const root = join(resolve(coordRoot), 'verify-shared'), chain = [];
  for (let p = dirname(file); ; p = dirname(p)) { chain.unshift(p); if (p === root) return chain; }
}

function validRecord(rec, { repo, sha, policyKey }, nowMs) {
  return rec && typeof rec === 'object' && !Array.isArray(rec)
    && JSON.stringify(Object.keys(rec).sort()) === JSON.stringify(FIELDS)
    && rec.v === 1 && rec.writer === 'verify-lane' && rec.repo === repo && rec.sha === sha && rec.policyKey === policyKey
    && rec.status === 'green' && rec.exitCode === 0
    && typeof rec.executedGate === 'string' && rec.executedGate.trim().length > 0
    && ['pr', 'full', 'since-last-green'].includes(rec.selectionMode)
    && (rec.selectionMode === 'since-last-green' ? typeof rec.deltaBase === 'string' && SHA.test(rec.deltaBase) : rec.deltaBase === null)
    && typeof rec.finishedAt === 'string' && Number.isFinite(Date.parse(rec.finishedAt)) && Date.parse(rec.finishedAt) <= nowMs + 5 * 60_000
    && typeof rec.lane === 'string' && rec.lane.trim().length > 0;
}

/** Only the publish site in verify-lane calls this writer. Never replaces an existing final record. */
export function publishGreen({ coordRoot, repo, sha, policyKey, record }) {
  const file = sharedMarkerPath({ coordRoot, repo, sha, policyKey });
  if (!file || !validRecord(record, { repo, sha, policyKey }, Date.now())) return false;
  let tmp, fd;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    for (const p of directories(file, coordRoot)) {
      const st = lstatSync(p);
      if (!st.isDirectory() || st.isSymbolicLink() || !ownerOnly(st, process.getuid?.())) return false;
    }
    tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    try { linkSync(tmp, file); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    return true;
  } catch { return false; }
  finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* failed publication cannot grant reuse */ } }
    // Only this writer's scratch file is ever removed. The final record is immutable.
    if (tmp) { try { unlinkSync(tmp); } catch { /* abandoned temp files are ignored */ } }
  }
}

/** Absence is null; every untrusted/unreadable/incomplete record is corrupt and refuses admission. */
export function readSharedGreen({ coordRoot, repo, sha, policyKey, uid = process.getuid?.(), nowMs = Date.now() }) {
  const file = sharedMarkerPath({ coordRoot, repo, sha, policyKey });
  if (!file) return { corrupt: true };
  try {
    for (const p of directories(file, coordRoot)) {
      const st = lstatSync(p, { throwIfNoEntry: false });
      if (!st) return null;
      if (!st.isDirectory() || st.isSymbolicLink() || !ownerOnly(st, uid)) return { corrupt: true };
    }
    if (!lstatSync(file, { throwIfNoEntry: false })) return null;
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let rec;
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || !ownerOnly(st, uid)) return { corrupt: true };
      rec = JSON.parse(readFileSync(fd, 'utf8'));
    } finally { closeSync(fd); }
    if (!validRecord(rec, { repo, sha, policyKey }, nowMs)) return { corrupt: true };
    return { sha, status: 'green', suites: rec.executedGate, sharedFrom: { lane: rec.lane, at: rec.finishedAt } };
  } catch { return { corrupt: true }; }
}

/** Exact local evidence decides first; shared evidence is never eligible for carry-forward. Pure. */
export function resolveMarkerWithShared({ local, shared, headSha }) {
  if (local && (local.sha === headSha || local.corrupt)) return local;
  if (shared?.corrupt) return shared;
  if (shared?.status === 'green' && shared.sha === headSha) return shared;
  return local;
}
