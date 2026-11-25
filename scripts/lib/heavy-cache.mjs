/** Validated, provenance-bound heavy PR entries. Only this module constructs or persists them. */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LISTED_FILES_CAP } from './red-main-quarantine.mjs';
import { prSnapshotDir, prSnapshotEnabled, latestDirtyMs } from './pr-snapshot-store.mjs';
import { withFileLock, writeJsonAtomic } from './atomic-json-file.mjs';

export const IDENTITY = Object.freeze(['number', 'headRefOid', 'baseRefOid', 'baseRefName', 'updatedAt']);
export const HEAVY = Object.freeze(['body', 'files']);
const MADE = new WeakSet(), BOUNDS = new WeakSet();
const oid = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const plain = value => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export function identityOf(x) {
  if (!x || !Number.isInteger(x.number) || x.number <= 0 || !oid(x.headRefOid) || !oid(x.baseRefOid)
    || typeof x.baseRefName !== 'string' || !x.baseRefName.length
    || typeof x.updatedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(x.updatedAt)
    || !Number.isFinite(Date.parse(x.updatedAt))) return null;
  return Object.freeze(Object.fromEntries(IDENTITY.map(key => [key, x[key]])));
}

export function validHeavy(h) {
  return !!h && typeof h.body === 'string' && Array.isArray(h.files) && h.files.length < LISTED_FILES_CAP
    && Array.from(h.files).every(file => plain(file) && typeof file.path === 'string' && file.path.length > 0);
}

export function makeEntry(row, heavy, fetchedAtMs) {
  const identity = identityOf(row);
  if (!identity || !validHeavy(heavy) || !Number.isSafeInteger(fetchedAtMs)) throw new TypeError('invalid heavy-cache entry');
  const entry = Object.freeze({ ...identity, fetchedAtMs, body: heavy.body,
    files: Object.freeze(heavy.files.map(file => Object.freeze({ ...file }))) });
  MADE.add(entry);
  return entry;
}

export function loadBounds(paging) {
  const backstop = paging?.heavyBackstopSeconds, settle = paging?.heavySettleSeconds;
  if (!Number.isInteger(backstop) || backstop < 0 || backstop > 604800
    || !Number.isInteger(settle) || settle < 1 || settle > 300) return null;
  const bounds = Object.freeze({ backstopMs: backstop * 1000, settleMs: settle * 1000 });
  BOUNDS.add(bounds);
  return bounds;
}

export function whyNotReuse(entry, liveRow, nowMs, bounds) {
  if (!BOUNDS.has(bounds)) return 'bounds';
  if (!MADE.has(entry)) return 'new';
  const identity = identityOf(liveRow);
  if (!identity) return 'row-invalid';
  const changed = IDENTITY.filter(key => entry[key] !== identity[key]);
  if (changed.length) return changed.length === 1 && changed[0] === 'baseRefOid' ? 'base-only' : 'identity';
  if (liveRow.labelsComplete !== true) return 'labels';
  const age = nowMs - entry.fetchedAtMs;
  if (!Number.isSafeInteger(nowMs) || age < 0 || age >= bounds.backstopMs) return 'age';
  if (entry.fetchedAtMs - Date.parse(entry.updatedAt) < bounds.settleMs) return 'unsettled';
  return null;
}
export const mayReuse = (entry, row, nowMs, bounds) => whyNotReuse(entry, row, nowMs, bounds) === null;

export class HeavyReadError extends Error {
  constructor(reason, cause) { super(reason, { cause }); this.name = 'HeavyReadError'; this.reason = reason; }
}
export function readHeavyPinned(row, ghStdout, fetchedAtMs) {
  let data;
  try { data = JSON.parse(String(ghStdout)); } catch (cause) { throw new HeavyReadError('malformed', cause); }
  if (!identityOf(data) || !validHeavy(data)) throw new HeavyReadError('malformed');
  const live = identityOf(row);
  if (!live || IDENTITY.some(key => data[key] !== live[key])) throw new HeavyReadError('moved');
  return makeEntry(row, data, fetchedAtMs);
}

function storePath(repo, dir) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new TypeError('repo must be an owner/name slug');
  return join(dir, `heavy-${createHash('sha256').update(repo.toLowerCase()).digest('hex')}.json`);
}
export function loadHeavyStore({ repo, dir = prSnapshotDir() }) {
  const entries = new Map();
  if (!prSnapshotEnabled()) return { entries, dropped: 0 };
  const path = storePath(repo, dir);
  let data;
  try { data = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { entries, dropped: 0 };
    // Unreadable evidence is a cache miss, never reusable evidence.
    return { entries, dropped: 1 };
  }
  if (!Array.isArray(data?.entries)) return { entries, dropped: 1 };
  const dirtyMs = latestDirtyMs(dir, repo);
  if (dirtyMs > 0 && data.entries.some(record => record?.fetchedAtMs <= dirtyMs)) {
    return { entries, dropped: data.entries.length };
  }
  let dropped = 0;
  for (const record of data.entries) {
    if (record?.repo !== repo.toLowerCase()) { dropped++; continue; }
    try { const entry = makeEntry(record, record, record?.fetchedAtMs); entries.set(entry.number, entry); }
    catch { dropped++; }
  }
  return { entries, dropped };
}
export function saveHeavyStore({ repo, dir = prSnapshotDir(), entries }) {
  if (!prSnapshotEnabled()) return;
  const path = storePath(repo, dir);
  const records = [...entries.values()];
  if (records.some(entry => !MADE.has(entry))) throw new TypeError('cannot save an unvalidated heavy entry');
  mkdirSync(dir, { recursive: true });
  withFileLock(`${path}.lock`, () => writeJsonAtomic(path, { entries: records.map(entry => ({ ...entry, repo: repo.toLowerCase() })) }));
}
