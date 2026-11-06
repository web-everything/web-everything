/**
 * @file scripts/lib/review-head-index.mjs
 * @description R554 durable per-head review index. One record per PR: {lastReviewedHead, netPatchHash, verdict, at}
 * plus a history keyed by netPatchHash (latest N kept). Stored as an append-only JSONL log (source of truth) and a
 * compacted map (O(1) read), both under one directory beside the runs dir (.operations/review-head-index).
 *
 * - A review is OWED whenever the PR's current head differs from lastReviewedHead, however old the record is or
 *   how many run records exist. It does not depend on any run scan cap.
 * - A verdict already given on the same net patch (same merge-base + exact diff) is carried, not re-reviewed.
 * - Fail closed: an unreadable index answers `{owed:null, held:true}`; it is never read as "nothing owed".
 * - Write order: append the log line (fsync) FIRST, then write the map to a temp file and rename it. A crash in
 *   between leaves a log ahead of the map; the reader detects that (map.logBytes != log size) and rebuilds from the log.
 * Nothing calls this module yet; wiring (review-job hook, planRedTeamOnSkip read) follows separately.
 */
import * as nodeFs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { cascadePolicy } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { REVIEWED_SHA_MARKER } from './review-escalation.mjs';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';

const SHA = /^[0-9a-f]{40}$/;
export const HEAD_INDEX_STANDARD = Object.freeze({ keepPerPr: 20, logMaxLines: 2000 });
export const MAP_VERSION = 2;
export const LOCK_STALE_MS = 30_000, LOCK_WAIT_MS = 15_000;
const posInt = v => Number.isSafeInteger(v) && v > 0;

/**
 * A SIBLING of the coordination root (not inside it, not inside <root>/runs): <dirname(root)>/review-head-index. The default
 * root is <home>/workspace/.operations/coordination, so the index is <home>/workspace/.operations/review-head-index. A root
 * overridden through WE_COORDINATION_ROOT moves the index with it (<dirname(override)>/review-head-index).
 */
export function defaultHeadIndexDir(env = process.env) { return join(dirname(resolveCoordinationRoot({ env })), 'review-head-index'); }
export function headIndexPaths(dir) { return { log: join(dir, 'log.jsonl'), map: join(dir, 'map.json'), lock: join(dir, 'lock'), tmp: join(dir, 'map.json.tmp') }; }

/** Standard -> platform -> tool via the policy cascade; no env override. */
export function resolveHeadIndexSettings({ file = readSettings(), platform, env = process.env, log } = {}) {
  const pick = v => (v && typeof v === 'object' ? { ...(v.keepPerPr === undefined ? {} : { keepPerPr: v.keepPerPr }),
    ...(v.logMaxLines === undefined ? {} : { logMaxLines: v.logMaxLines }) } : {});
  return cascadePolicy('reviewHeadIndex', pick(file?.reviewHeadIndex), { standard: { ...HEAD_INDEX_STANDARD }, platform, env, log,
    valid: { keepPerPr: posInt, logMaxLines: posInt } });
}

/**
 * Net-patch identity: sha256 of the merge-base plus the exact net diff. A rebase changes the base, so it is a new key.
 * git output is read as 'latin1' (one char per byte, lossless) and hashed back as latin1, so the key covers the raw diff
 * bytes: patches differing only in invalid UTF-8 bytes (which a UTF-8 decode would all turn into U+FFFD) get different keys.
 */
export function netPatchKey({ exec, cwd, sha, mainRef = 'origin/main' } = {}) {
  try {
    if (!SHA.test(sha ?? '')) throw Error('invalid head');
    const git = args => String(exec('git', args, { cwd, encoding: 'latin1', timeout: 10000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
    const base = git(['merge-base', mainRef, sha]).trim();
    if (!SHA.test(base)) throw Error('unreadable merge-base');
    const diff = git(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--binary', base, sha, '--']);
    if (!diff.trim()) throw Error('empty net patch');
    const located = diff.split('\n').filter(l => !/^index [0-9a-f]+\.\.[0-9a-f]+(?: \d+)?$/.test(l)).join('\n'); // ASCII-only header lines: safe to filter on latin1 text
    return { ok: true, key: createHash('sha256').update(`${base}\0`, 'latin1').update(located, 'latin1').digest('hex'), base };
  } catch (error) { return { ok: false, reason: `net-patch-unreadable: ${String(error?.message ?? error).slice(0, 120)}` }; }
}

const NOKEY = 'head:';
const prKey = (repo, pr) => `${repo}#${Number(pr)}`;
const TXN = /^[\w-]{1,64}$/;
// pr must already BE a positive safe integer: Number() coercion would accept null, '', true and '7' as PR numbers.
const validRecord = r => r && typeof r.repo === 'string' && r.repo && Number.isSafeInteger(r.pr) && r.pr > 0 && typeof r.head === 'string' && SHA.test(r.head)
  && typeof r.verdict === 'string' && r.verdict && typeof r.at === 'string' && Number.isFinite(Date.parse(r.at)) && (r.txn === undefined || (typeof r.txn === 'string' && TXN.test(r.txn)));

/** PURE: fold one record into the map and keep only the latest `keepPerPr` history entries for that PR. */
export function applyRecord(map, rec, keepPerPr) {
  const key = prKey(rec.repo, rec.pr);
  const prev = map[key] ?? { history: {} };
  const history = { ...prev.history };
  // A review without a net-patch key is kept under a head-scoped key so compaction never drops it; it can never be carried.
  // The writer's txn rides along with every kept entry, so compaction can write it back and a retraction still finds its row.
  const txn = rec.txn === undefined ? {} : { txn: rec.txn };
  history[rec.netPatchHash ?? `${NOKEY}${rec.head}`] = { head: rec.head, verdict: rec.verdict, at: rec.at, ...txn };
  const kept = Object.entries(history).sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at) || (a[0] < b[0] ? -1 : 1)).slice(0, keepPerPr);
  map[key] = { lastReviewedHead: rec.head, netPatchHash: rec.netPatchHash ?? null, verdict: rec.verdict, at: rec.at, ...txn, history: Object.fromEntries(kept) };
  return map;
}

const validEntry = e => e && SHA.test(e.lastReviewedHead ?? '') && typeof e.verdict === 'string' && e.verdict && Number.isFinite(Date.parse(e.at))
  && e.history && typeof e.history === 'object' && Object.values(e.history).every(h => h && SHA.test(h.head ?? '') && typeof h.verdict === 'string' && h.verdict && Number.isFinite(Date.parse(h.at)));
const validMap = m => m && typeof m === 'object' && Object.values(m).every(validEntry);
// Replay applies the SAME keepPerPr the writer used, so a rebuilt map equals the published one: evicted history is not
// resurrected, and a compacted log (older rows then the PR's current record last, keyed or keyless) replays to the same map.
// A rejected writer (it lost the lock after appending) never writes to the log again: a live holder may be appending to it or
// replacing it by rename, which would swallow the write. It creates a marker file `retract.<txn>` (O_EXCL, a name of its own, so
// no rewrite of the log can lose it) naming its row by the txn every row carries and compaction preserves. Replay drops every row
// whose txn has a marker. Markers are removed only by the compaction that folded them in.
const hashText = text => createHash('sha256').update(text).digest('hex');
const RETRACT = /^retract\.([\w-]{1,64})$/;
const retractPath = (dir, txn) => join(dir, `retract.${txn}`);
// A writer names its transaction BEFORE its row exists: `pending.<txn>` is created (O_EXCL, durable) first and removed only when the
// transaction is accepted (the map is published and the lock is still ours). Replay and readers treat a row whose txn is pending OR
// retracted as invisible, so a row is never readable before its retraction can exist: it is hidden from the instant it is appended
// until the instant it is accepted. A rejected writer leaves its marker (and converts it to `retract.<txn>` when it can). Whoever
// next holds the lock turns every foreign pending marker into a retraction: once the lock has changed hands the old holder fails
// its fence, so that transaction can never be accepted, and compaction therefore never folds an uncommitted row.
const PENDING = /^pending\.([\w-]{1,64})$/;
const pendingPath = (dir, txn) => join(dir, `pending.${txn}`);
/** Retraction and pending markers present now, sorted. Always listed BEFORE the log is read (see readHeadIndex). ENOENT means no directory yet. */
const listMarkers = (fs, dir) => {
  try { const names = fs.readdirSync(dir); const pick = re => names.map(n => re.exec(n)?.[1]).filter(Boolean).sort(); return { retract: pick(RETRACT), pending: pick(PENDING) }; } catch (e) { if (e?.code === 'ENOENT') return { retract: [], pending: [] }; throw e; }
};
/** The cache key: the raw log bytes plus the set of markers, so a marker that appears (or goes) after the map was published invalidates it. */
const stateHash = (raw, retractions, pending = []) => {
  const tail = `${retractions.length ? `\0retract:${retractions.join(',')}` : ''}${pending.length ? `\0pending:${pending.join(',')}` : ''}`;
  return tail ? hashText(Buffer.concat([raw, Buffer.from(tail)])) : hashText(raw);
};
const parseLog = (text, keepPerPr, retractions = []) => {
  const lines = text.split('\n').filter(l => l.trim());
  const gone = new Set(retractions);
  const map = {}, seen = new Set(); // seen = every txn that has a row in this text, retracted or not
  for (const l of lines) {
    const rec = JSON.parse(l);
    if (!validRecord(rec)) throw Error('invalid log record');
    if (typeof rec.txn === 'string') seen.add(rec.txn);
    if (typeof rec.txn === 'string' && gone.has(rec.txn)) continue; // retracted by its writer
    applyRecord(map, rec, keepPerPr);
  }
  return { map, lines: lines.length, seen };
};
/** keepPerPr for a rebuild: explicit option, else the value the last published map recorded, else the resolved setting (`.value`). */
const rebuildKeep = (explicit, stored, settingsFile) => {
  if (posInt(explicit)) return explicit;
  if (posInt(stored?.keepPerPr)) return stored.keepPerPr;
  try { const k = resolveHeadIndexSettings(settingsFile === undefined ? {} : { file: settingsFile }).value?.keepPerPr; if (posInt(k)) return k; } catch { /* fall through to the standard */ }
  return HEAD_INDEX_STANDARD.keepPerPr;
};
const size = (fs, p) => { try { return fs.statSync(p).size; } catch (e) { if (e?.code === 'ENOENT') return null; throw e; } };

/** Read the index. Uses the cached map only when its log content hash matches; rebuilds from the log otherwise. Never throws. */
export function readHeadIndex({ dir = defaultHeadIndexDir(), fs = nodeFs, keepPerPr, settingsFile } = {}) {
  try {
    const { log, map: mapPath } = headIndexPaths(dir);
    const logSize = size(fs, log);
    let stored = null;
    try { stored = JSON.parse(fs.readFileSync(mapPath, 'utf8')); } catch { stored = null; }
    if (logSize === null) {
      if (!existsSafe(fs, mapPath)) return { ok: true, map: {} };
      return { ok: false, reason: 'index-unreadable' }; // a map with no log is not a state we write
    }
    // An unreadable log throws here and fails closed. The cache is trusted only when the log's content hash matches.
    // Markers are listed BEFORE the log is read and AGAIN after it, and the UNION is used. Before: a compaction renames the new log
    // into place and only then deletes the markers it folded, so a marker missing from the first listing was already folded into the
    // log we read next. After: a writer names its transaction (or a rejection lands) between our first listing and our read, so its
    // row is in the bytes we read but not in the first listing; the second listing sees the marker and hides it. A marker only in the
    // second listing is never wrong to apply (its row is either in our bytes and must be hidden, or not in them), and one only in
    // the first belongs to a row that is now committed or folded: hiding it costs one conservative rebuild, never a rejected row.
    const first = listMarkers(fs, dir);
    const raw = fs.readFileSync(log); // the cache key is the digest of the RAW bytes: a UTF-8 decode would alias distinct corrupt logs
    const second = listMarkers(fs, dir);
    const union = (a, b) => [...new Set([...a, ...b])].sort();
    const retract = union(first.retract, second.retract), pending = union(first.pending, second.pending);
    const text = raw.toString('utf8');
    const logHash = stateHash(raw, retract, pending);
    if (stored && stored.map && typeof stored.map === 'object' && stored.version === MAP_VERSION && stored.logHash === logHash && validMap(stored.map)) return { ok: true, map: stored.map };
    return { ok: true, map: parseLog(text, rebuildKeep(keepPerPr, stored, settingsFile), [...retract, ...pending]).map, rebuilt: true };
  } catch { return { ok: false, reason: 'index-unreadable' }; }
}
// Only ENOENT means absent; any other stat failure (EACCES, EIO, ...) throws so the caller fails closed instead of reading an empty index.
const existsSafe = (fs, p) => { try { fs.statSync(p); return true; } catch (e) { if (e?.code === 'ENOENT') return false; throw e; } };

// Durable: write, fsync, close. The rename happens only after the temp file is flushed.
const durable = (fs, path, flag, text) => {
  const fd = fs.openSync(path, flag);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
const atomicWrite = (fs, path, tmp, text) => { durable(fs, tmp, 'w', text); fs.renameSync(tmp, path); };

const sleepMs = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };

/**
 * Exclusive lock file (O_EXCL) holding {pid, token, at}. A lock is taken over ONLY when its owner pid is dead (or, for a
 * holder file that never got written, after staleMs). A live owner is never displaced, however old the lock. `fn` gets a
 * `fence()` that throws unless the lock file still carries OUR token; call it before every publish.
 */
export function withHeadIndexLock(dir, fn, { fs = nodeFs, staleMs = LOCK_STALE_MS, waitMs = LOCK_WAIT_MS, now = Date.now, pid = process.pid } = {}) {
  const { lock } = headIndexPaths(dir);
  const token = `${pid}-${now()}-${Math.random().toString(36).slice(2)}`;
  const deadline = now() + waitMs;
  const holder = () => { try { const v = JSON.parse(fs.readFileSync(lock, 'utf8')); return v && typeof v === 'object' ? v : null; } catch { return null; } }; // a non-object body (0, false, 5) is as unreadable as garbage
  const takeover = `${lock}.takeover`;
  /**
   * Take over a lock judged dead (`deadHolder` = the holder we read, or null for an unreadable one). Takeovers are serialised by a
   * separate O_EXCL `<lock>.takeover` file. Under it the holder is re-read and the lock is replaced ONLY if it is still the
   * dead one: our lock is written to a temp file and rename()d over `lock` (atomic replace, so there is never a moment without
   * a lock), and `lock` itself is never unlinked here. A live owner that re-created the lock keeps it. Returns true if we hold it.
   */
  const takeOver = deadHolder => {
    let tfd;
    try {
      tfd = fs.openSync(takeover, 'wx');
      try { fs.writeSync(tfd, JSON.stringify({ pid, token, at: now() })); } finally { fs.closeSync(tfd); }
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      // Another contender is taking over. Clear its file only if its owner is dead (or it is unreadable and past the grace).
      let other = null; try { other = JSON.parse(fs.readFileSync(takeover, 'utf8')); } catch { /* unreadable */ }
      let otherAge = 0; try { otherAge = now() - fs.statSync(takeover).mtimeMs; } catch { return false; }
      // A file with no integer pid is treated like an unreadable one (cleared by age), so a malformed one cannot block forever.
      // Two cleaners racing here can at worst let two contenders rename over the lock; the loser's post-rename token check or its
      // first fence() fails closed, so the lock never has two publishing holders.
      if (Number.isInteger(other?.pid) ? !pidAlive(other.pid) : otherAge > staleMs) { try { fs.unlinkSync(takeover); } catch { /* gone */ } }
      return false;
    }
    const fresh = `${lock}.new.${token}`;
    try {
      const cur = holder();
      let curAge; try { curAge = now() - fs.statSync(lock).mtimeMs; } catch { return false; } // vanished: let the normal path create it
      const ownerless = !Number.isInteger(cur?.pid); // the grace applies to an ownerless lock at the re-read too
      if (deadHolder ? cur?.token !== deadHolder.token || (ownerless && curAge <= staleMs) : cur !== null || curAge <= staleMs) return false; // changed hands: a live owner's lock
      durable(fs, fresh, 'w', JSON.stringify({ pid, token, at: now() }));
      fs.renameSync(fresh, lock);
      return holder()?.token === token;
    } finally {
      try { fs.unlinkSync(fresh); } catch { /* consumed by the rename, or never written */ }
      try { fs.unlinkSync(takeover); } catch { /* best effort */ }
    }
  };
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      try { fs.writeSync(fd, JSON.stringify({ pid, token, at: now() })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      break;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      const held = holder();
      let age = Infinity;
      try { age = now() - fs.statSync(lock).mtimeMs; } catch { continue; } // vanished: retry
      // No integer pid (unreadable file, or JSON without an owner pid): no owner to probe, so only after the grace, like the takeover file.
      const dead = Number.isInteger(held?.pid) ? !pidAlive(held.pid) : age > staleMs;
      if (dead && takeOver(held)) break; // took the lock over; otherwise wait like any other contender
      if (now() >= deadline) throw Error('review-head-index: lock busy (holder pid ' + (held?.pid ?? '?') + ')');
      sleepMs(10 + Math.floor(Math.random() * 20));
    }
  }
  const fence = () => { if (holder()?.token !== token) throw Error('review-head-index: lock lost (fencing token mismatch); refusing to publish'); };
  try { return fn(fence); } finally {
    try { if (holder()?.token === token) fs.unlinkSync(lock); } catch { /* not ours or gone */ }
  }
}

/**
 * Record a durable review verdict. Call only after the verdict itself is durable (its run record exists).
 * Throws on a malformed record or an unreadable existing index (never overwrites what it cannot read).
 */
export function recordReview({ dir = defaultHeadIndexDir(), repo, pr, head, netPatchHash = null, verdict, at = new Date().toISOString(),
  keepPerPr = HEAD_INDEX_STANDARD.keepPerPr, logMaxLines = HEAD_INDEX_STANDARD.logMaxLines, fs = nodeFs } = {}) {
  // A PR number is a number or a plain decimal string. Number() alone would turn null, '' and true into 0 or 1.
  const rec = { repo, pr: typeof pr === 'string' && /^[1-9]\d*$/.test(pr) ? Number(pr) : pr, head, netPatchHash, verdict, at };
  if (!validRecord(rec)) throw Error(`review-head-index: invalid record (repo/pr/head/verdict/at): head=${String(head).slice(0, 12)} verdict=${String(verdict)}`);
  if (!posInt(keepPerPr) || !posInt(logMaxLines)) throw Error('review-head-index: invalid keepPerPr/logMaxLines');
  fs.mkdirSync(dir, { recursive: true });
  return withHeadIndexLock(dir, fence => {  // read, append, compact and publish are ONE transaction
    const { log, map: mapPath, tmp } = headIndexPaths(dir);
    // We hold the lock, so any pending marker that is not ours belongs to a writer whose lock was taken over: it will fail its fence
    // and can never be accepted. Reject it for good (retraction first, then drop the pending marker); never leave it to be folded.
    // A marker that cannot be turned into a retraction fails this write closed rather than risk folding an uncommitted row.
    // The conversion is ONE atomic rename (pending.<t> -> retract.<t>), so it races a stale writer's commit (its unlink of the same
    // pending marker) with exactly one winner: either the writer's commit finds the marker gone and fails, or the rename finds it
    // gone (ENOENT: the writer committed first) and the row stays accepted. The retraction is never created beside a live marker.
    for (const t of listMarkers(fs, dir).pending) {
      try { fs.renameSync(pendingPath(dir, t), retractPath(dir, t)); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
    }
    const current = readHeadIndex({ dir, fs, keepPerPr });
    if (!current.ok) throw Error('review-head-index: existing index unreadable; refusing to write');
    fence();
    const txn = randomUUID();                                   // names OUR row for its whole life, through compaction
    const line = `${JSON.stringify({ ...rec, txn })}\n`;
    // Our transaction is named before its row exists. If the marker cannot be written nothing has been appended and we fail closed.
    durable(fs, pendingPath(dir, txn), 'wx', `${JSON.stringify({ txn, pid: process.pid, at: Date.now() })}\n`);
    // fsync the directory too, so the marker's NAME survives a power loss together with the row it hides (best effort: a platform
    // that cannot fsync a directory just skips it).
    try { const dfd = fs.openSync(dir, 'r'); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch { /* unsupported */ }
    // Our row is hidden by that marker from the instant it is appended until we accept it. A lost lock (or any failure before the
    // commit) rejects it: we never touch the log again to say so (a live holder may be appending to it or renaming a new one over
    // it, which would swallow our write); we create the marker file `retract.<txn>` and drop the pending marker.
    const lineBytes = Buffer.from(line);
    let rolledBack = false, rollbackFailed = false, committed = false;
    const rollback = () => {
      if (rolledBack) return;                                   // idempotent
      rolledBack = true;
      let marked = false;
      for (let attempt = 0; attempt < 2 && !marked; attempt++) { // one retry; EEXIST means the marker is already there
        try { durable(fs, retractPath(dir, txn), 'wx', `${JSON.stringify({ txn })}\n`); marked = true; } catch (e) { if (e?.code === 'EEXIST') marked = true; }
      }
      if (marked) { try { fs.unlinkSync(pendingPath(dir, txn)); } catch { /* the next writer clears it */ } } else rollbackFailed = true; // the pending marker still hides the row
    };
    const tag = e => { if (rollbackFailed && e instanceof Error && !e.message.includes('rollback-failed')) e.message += ' (rollback-failed: could not write the retraction marker; the row stays hidden by its pending marker until the next writer rejects it)'; return e; };
    const fenced = () => { try { fence(); } catch (e) { rollback(); throw tag(e); } };
    try {
    durable(fs, log, 'a', line);                                // 1. durable log line (fsynced, hidden by our pending marker); a failed fsync after the write rejects it too
    fenced();                                                   //    lock lost during the append: roll the line back, no publish
    // 2. Everything below is derived from ONE snapshot of the log taken after our append (markers listed first, as readers do), not
    // from `current.map` (read before it): a retraction made in between is applied by the replay.
    const { retract: folded, pending: pendingNow } = listMarkers(fs, dir);
    const snapshot = fs.readFileSync(log);
    if (!snapshot.includes(lineBytes)) throw Error('review-head-index: appended row missing from the log; refusing to publish'); // never report ok for a lost append
    // Our pending marker hides our row here, so `parsed.map` is the committed state WITHOUT it. Only committed rows are ever folded.
    const parsed = parseLog(snapshot.toString('utf8'), keepPerPr, [...folded, ...pendingNow, txn]);
    let lines = parsed.lines;
    if (lines > logMaxLines) { // 3. bound growth: rewrite the log from the compacted map, atomically, then the map
      // The rewrite is derived from the committed map WITHOUT our row, and our own line is kept verbatim as the last row. Our row can
      // replace a same-patch predecessor or evict the oldest entry in the map; compacting that map would make those losses permanent,
      // so a later retraction of our row could not bring them back. Replay applies our row last either way, so the result is the same.
      const prior = parsed.map;
      const compact = Object.entries(prior).flatMap(([k, v]) => {
        const [r, p] = [k.slice(0, k.lastIndexOf('#')), Number(k.slice(k.lastIndexOf('#') + 1))];
        const tx = h => (h.txn === undefined ? {} : { txn: h.txn }); // every row keeps its writer's txn, so a later retraction still finds it
        const row = (hash, h) => ({ repo: r, pr: p, head: h.head, netPatchHash: hash.startsWith(NOKEY) ? null : hash, verdict: h.verdict, at: h.at, ...tx(h) });
        const cur = v.netPatchHash ?? `${NOKEY}${v.lastReviewedHead}`; // the current record's own history entry is emitted once, as the LAST row
        const older = Object.entries(v.history).filter(([hash]) => hash !== cur).sort((a, b) => Date.parse(a[1].at) - Date.parse(b[1].at)).map(([hash, h]) => row(hash, h));
        // The PR's current record goes LAST so a rebuild restores lastReviewedHead and its verdict exactly.
        return [...older, { repo: r, pr: p, head: v.lastReviewedHead, netPatchHash: v.netPatchHash, verdict: v.verdict, at: v.at, ...tx(v) }];
      });
      const text = compact.map(c => `${JSON.stringify(c)}\n`).join('') + line;
      if (!snapshot.subarray(Math.max(0, snapshot.length - lineBytes.length)).equals(lineBytes)) { rollback(); throw tag(Error('review-head-index: log changed under the lock; refusing to compact')); }
      fenced();
      // The rewrite replaces the file, so it must replace exactly the bytes the compaction was derived from. A rejected writer's
      // retraction is a separate marker file, so nothing it does can be lost to this rename.
      if (!fs.readFileSync(log).equals(snapshot)) { rollback(); throw tag(Error('review-head-index: log changed under the lock; refusing to compact')); }
      atomicWrite(fs, log, `${log}.tmp`, text);
      fenced();                                                 // lock lost during the rewrite: the compacted log replays to the same map, so it stays; our row is retracted
      // Delete only a marker whose row this compaction actually saw (and so dropped from the new log). A marker whose row is not in
      // the snapshot belongs to a rejected writer that has not appended yet (it named its transaction, then lost the lock): its row
      // can still land in the new log, and the marker is the only thing hiding it. Such markers are never aged out (a paused writer
      // may append arbitrarily late), so they can pile up; that is the price of never showing a rejected review.
      for (const t of folded) { if (parsed.seen.has(t)) { try { fs.unlinkSync(retractPath(dir, t)); } catch { /* gone */ } } } // later markers are not in `folded` and stay
      lines = compact.length + 1;
    }
    fenced();
    // The map and its hash describe the state AFTER our commit (our pending marker gone), from the SAME markers and bytes. Until the
    // commit a reader's hash still includes our marker, so it rebuilds without our row; a marker made after this listing changes the
    // hash too, so readers rebuild instead of trusting this map.
    const { retract: live, pending: allPending } = listMarkers(fs, dir);
    const after = allPending.filter(t => t !== txn);
    const raw = fs.readFileSync(log);
    if (!raw.includes(lineBytes)) throw Error('review-head-index: appended row missing from the log at commit; refusing to accept'); // a stale rename swallowed it: never report ok for a lost row
    const published = JSON.stringify({ version: MAP_VERSION, logHash: stateHash(raw, live, after), keepPerPr, map: parseLog(raw.toString('utf8'), keepPerPr, [...live, ...after]).map });
    fenced();                                                   // still the holder: accept. A thief after this finds our row accepted.
    fs.unlinkSync(pendingPath(dir, txn));                       // COMMIT: the row becomes visible. A missing marker means a new holder already rejected us: fail.
    committed = true;                                           // past this point the row stays: a failed map write only leaves the cache behind the log
    atomicWrite(fs, mapPath, tmp, published);
    return { ok: true, lines };
    } catch (e) { if (!committed) rollback(); throw tag(e); }        // any failure before the commit rejects our row (it is already hidden); after it, readers rebuild from the log
  }, { fs });
}

/**
 * Is a review owed for this PR head? Pure. `seed` (from seedFromReviewComments) stands in for a missing record. `index` is the result of readHeadIndex.
 * owed:null + held:true means unknown (fail closed): hold the PR, do not treat it as nothing-owed.
 */
const ACCEPT_HEAD = /^✅ review — accepted\r?\n/, CHANGES_HEAD = /^(?:🔁 )?(?:human )?review — changes requested\r?\n/;
// Any other trusted daemon/operator control comment (re-arm, stand-down, escalation, hold, pause, load-flake, supersede, or an
// unknown future hold): a symbol/emoji-led first line naming one of those. A later one withdraws an earlier accept.
// The first non-empty line (BOM / zero-width / leading markdown emphasis stripped) is tested for the keywords; a wider net only
// errs toward "review owed", which is the safe direction. It no longer requires a leading symbol (`review paused:`, `ℹ️ conveyor`).
const CONTROL_KEYWORDS = /conveyor|re[-\s]?armed?|stood[-\s]+down|stand[-\s]*down|escalat|\bhold(?:ing)?\b|\bheld\b|\bpaus|supersed|\bruling\b|exhausted|\bblock(?:ed|ing)?\b|(?:do not|don'?t)\s+merge|withdr[ae]w|revok|reject|declin|not\s+(?:accepted|approved)|needs?\s+(?:more\s+)?(?:work|rework|changes)|\bfail(?:ed|s|ure)\b/iu;
// The first three non-empty lines are tested (a leading HTML-comment-only or horizontal-rule line must not hide the keyword).
// Input contract: comments arrive in chronological order and are known to be COMPLETE (a paged/capped list that dropped a later
// control comment would leave an accept standing; the caller owns that completeness check).
// Leading whitespace, zero-width characters (U+200B..U+200D), BOM (U+FEFF) and markdown emphasis/quote/heading marks. Built from
// code points so the source carries no invisible characters.
const LEAD_NOISE = new RegExp('^[\\s' + String.fromCharCode(0x200b) + '-' + String.fromCharCode(0x200d, 0xfeff) + '*_>#]+', 'u');
// A denylist alone fails open on a heading nobody listed. Daemon and verdict comments are symbol-led (an emoji or mark, never a
// letter or digit), so a trusted comment whose first meaningful line is NOT led by a letter or digit counts as a control comment
// whatever it says: an unknown later heading withdraws the accept. Plain prose from a trusted author is still judged by the keywords.
const SYMBOL_LED = /^[^\p{L}\p{N}]/u;
const isControlComment = body => {
  const lines = body.split(/\r?\n/).map(l => l.replace(LEAD_NOISE, '')).filter(l => l && !(l.startsWith('<!--') && l.endsWith('-->')) && !/^[-_*=]{3,}$/.test(l)).slice(0, 3);
  return lines.length > 0 && (SYMBOL_LED.test(lines[0]) || lines.some(l => CONTROL_KEYWORDS.test(l)));
};
const MARKER_LINE = new RegExp(`^<!-- ${REVIEWED_SHA_MARKER}: ([0-9a-f]{40}) -->$`);
/**
 * Seed for a pre-index PR: the latest trusted VERDICT comment, and only if it is accept-shaped (heading at byte 0) with a
 * whole-line full-sha marker among its first lines, outside quotes and code fences. A later changes-requested verdict,
 * an untrusted author, a quoted/fenced/short/prose marker, or no verdict at all gives null, which means owed.
 */
export function seedFromReviewComments(comments) {
  let latest = null;
  for (const c of Array.isArray(comments) ? comments : []) {
    if (!isTrustedMarkerAuthor(c)) continue;
    const body = typeof c?.body === 'string' ? c.body : '';
    if (ACCEPT_HEAD.test(body)) latest = { kind: 'accept', body };
    else if (CHANGES_HEAD.test(body)) latest = { kind: 'changes', body };
    else if (isControlComment(body)) latest = { kind: 'control', body }; // re-arm / stand-down / escalation / hold: not an accept
  }
  if (latest?.kind !== 'accept') return null;
  let open = null, found = null; // open = { ch, len } of the fence we are inside
  for (const line of latest.body.split(/\r?\n/).slice(0, 12)) {
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line); // CommonMark: at most 3 spaces of indent (4+ is an indented code block, not a fence)
    if (open) {
      // Close only on the same fence char, at least as long as the opener, with nothing after it but whitespace.
      if (f && f[1][0] === open.ch && f[1].length >= open.len && /^[ \t]*$/.test(f[2])) open = null; // CommonMark: only spaces/tabs may follow a closer (not U+00A0)
      continue;
    }
    // A backtick fence's info string cannot contain a backtick (that is inline code, not a fence).
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) { open = { ch: f[1][0], len: f[1].length }; continue; }
    if (/^\s*>/.test(line)) continue;
    const m = MARKER_LINE.exec(line);
    if (m) found = m[1];
  }
  return found ? { lastReviewedHead: found, verdict: 'marker', source: 'reviewed-sha-marker' } : null;
}

export function headReviewOwed({ index, repo, pr, head, netPatchHash = null, seed = null } = {}) {
  if (!index || index.ok !== true || !index.map) return { owed: null, held: true, reason: 'index-unreadable' };
  if (!SHA.test(head ?? '')) return { owed: null, held: true, reason: 'head-unreadable' };
  const r = index.map[prKey(repo, pr)];
  if (!r) {
    // Pre-index PR: seed from the latest trusted reviewed-sha marker. No marker (or no seed given) is owed, never nothing-owed.
    if (seed && SHA.test(seed.lastReviewedHead ?? '')) {
      return seed.lastReviewedHead === head ? { owed: false, reason: 'same-head', seeded: true, verdict: seed.verdict }
        : { owed: true, reason: 'new-head', seeded: true, lastReviewedHead: seed.lastReviewedHead };
    }
    return { owed: true, reason: 'no-record' };
  }
  if (r.lastReviewedHead === head) return { owed: false, reason: 'same-head', verdict: r.verdict };
  const prior = netPatchHash ? r.history?.[netPatchHash] : null;
  if (prior) return { owed: false, carried: true, reason: 'same-net-patch', verdict: prior.verdict, fromHead: prior.head };
  return { owed: true, reason: 'new-head', lastReviewedHead: r.lastReviewedHead };
}
