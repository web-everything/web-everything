/** @file Identity-verified, crash-recoverable single-writer lock for the live-owner pass. */
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { pidIdentity, pidIdentityStamp, pidNamespace } from '../lib/pid-alive.mjs';
import { writeJsonAtomic } from '../lib/atomic-json-file.mjs';

const held = () => Error('watch pass lock held or identity unknown; operator must inspect holder before removing lock');
const missing = error => error.code === 'ENOENT';

/**
 * Each acquisition has an immutable, uniquely named owner record. Only the contender that unlinks that
 * exact record may remove the empty directory. A delayed second reclaimer cannot unlink a successor's
 * record or remove its initializing directory. No recursive deletion, age-only takeover, or PID-only reuse.
 * Legacy owner.json records can recover on proven process death; a living legacy PID stays held because
 * its original birth stamp is unavailable. Unreadable/foreign/incomplete ownership always fails closed.
 */
export function acquireLiveOwnerWatchLock(dir, {
  pid = process.pid, host = hostname(), namespace = pidNamespace(),
  stamp = pidIdentityStamp, identity = pidIdentity,
} = {}) {
  const birth = stamp(pid);
  if (!birth?.runnerStart) throw held();
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'pass.lock'), token = randomUUID(), name = `owner-${token}.json`;
  const owner = { pid, host, namespace, runnerStart: birth.runnerStart, token, at: new Date().toISOString() };
  const dead = (record, legacy) => {
    if (!Number.isSafeInteger(record?.pid) || record.pid <= 0 || !Number.isFinite(Date.parse(record.at))) return false;
    if ((!legacy && (record.host !== host || record.namespace !== namespace || !record.runnerStart))
      || (legacy && ((record.host != null && record.host !== host)
        || (record.namespace != null && record.namespace !== namespace)))) return false;
    const verdict = identity(record.pid, { expectStart: legacy ? null : record.runnerStart });
    return verdict?.alive === false && (!legacy || ['gone', 'zombie'].includes(verdict.reason));
  };
  const readOwner = () => {
    const names = readdirSync(lock);
    if (names.length !== 1 || !/^(?:owner\.json|owner-[a-f0-9-]{36}\.json)$/.test(names[0])) throw held();
    const path = join(lock, names[0]);
    if (statSync(path).size > 16 * 1024) throw held();
    const bytes = readFileSync(path, 'utf8'), record = JSON.parse(bytes), legacy = names[0] === 'owner.json';
    if (!legacy && names[0] !== `owner-${record.token}.json`) throw held();
    return { path, bytes, record, legacy };
  };
  const remove = path => {
    // A missing unique record means another contender already won: do NOT rmdir the successor's directory.
    try { unlinkSync(path); } catch (e) { if (missing(e)) return false; throw e; }
    try { rmdirSync(lock); } catch (e) { if (!missing(e)) throw held(); }
    return true;
  };
  try { mkdirSync(lock); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try {
      const previous = readOwner();
      if (!dead(previous.record, previous.legacy)) throw held();
      // Recheck immutable bytes and identity after the probe, before consuming this generation's record.
      if (readFileSync(previous.path, 'utf8') !== previous.bytes || !dead(previous.record, previous.legacy)) throw held();
      if (!remove(previous.path)) throw held();
      mkdirSync(lock); // Another contender can win here; EEXIST holds this pass, never retries or deletes it.
    } catch { throw held(); }
  }
  const path = join(lock, name);
  try { writeJsonAtomic(path, owner); }
  catch (e) {
    // Preserve any unexpected metadata. An acquisition that failed never owns a recursive cleanup.
    try { rmdirSync(lock); } catch { /* incomplete evidence stays held for operator inspection */ }
    throw e;
  }
  return () => {
    try {
      if (JSON.parse(readFileSync(path, 'utf8')).token !== token) throw held();
      remove(path);
    } catch (e) { if (!missing(e)) throw e; }
  };
}
