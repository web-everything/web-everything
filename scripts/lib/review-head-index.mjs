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
import { createHash } from 'node:crypto';
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

/** Sibling of the shared runs dir: <operations>/review-head-index. */
export function defaultHeadIndexDir(env = process.env) { return join(dirname(resolveCoordinationRoot({ env })), 'review-head-index'); }
export function headIndexPaths(dir) { return { log: join(dir, 'log.jsonl'), map: join(dir, 'map.json'), lock: join(dir, 'lock'), tmp: join(dir, 'map.json.tmp') }; }

/** Standard -> platform -> tool via the policy cascade; no env override. */
export function resolveHeadIndexSettings({ file = readSettings(), platform, env = process.env, log } = {}) {
  const pick = v => (v && typeof v === 'object' ? { ...(v.keepPerPr === undefined ? {} : { keepPerPr: v.keepPerPr }),
    ...(v.logMaxLines === undefined ? {} : { logMaxLines: v.logMaxLines }) } : {});
  return cascadePolicy('reviewHeadIndex', pick(file?.reviewHeadIndex), { standard: { ...HEAD_INDEX_STANDARD }, platform, env, log,
    valid: { keepPerPr: posInt, logMaxLines: posInt } });
}

/** Net-patch identity: sha256 of the merge-base plus the exact net diff. A rebase changes the base, so it is a new key. */
export function netPatchKey({ exec, cwd, sha, mainRef = 'origin/main' } = {}) {
  try {
    if (!SHA.test(sha ?? '')) throw Error('invalid head');
    const git = args => String(exec('git', args, { cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
    const base = git(['merge-base', mainRef, sha]).trim();
    if (!SHA.test(base)) throw Error('unreadable merge-base');
    const diff = git(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--binary', base, sha, '--']);
    if (!diff.trim()) throw Error('empty net patch');
    const located = diff.split('\n').filter(l => !/^index [0-9a-f]+\.\.[0-9a-f]+(?: \d+)?$/.test(l)).join('\n');
    return { ok: true, key: createHash('sha256').update(`${base}\0${located}`).digest('hex'), base };
  } catch (error) { return { ok: false, reason: `net-patch-unreadable: ${String(error?.message ?? error).slice(0, 120)}` }; }
}

const NOKEY = 'head:';
const prKey = (repo, pr) => `${repo}#${Number(pr)}`;
const validRecord = r => r && typeof r.repo === 'string' && r.repo && Number.isSafeInteger(Number(r.pr)) && SHA.test(r.head ?? '')
  && typeof r.verdict === 'string' && r.verdict && Number.isFinite(Date.parse(r.at));

/** PURE: fold one record into the map and keep only the latest `keepPerPr` history entries for that PR. */
export function applyRecord(map, rec, keepPerPr) {
  const key = prKey(rec.repo, rec.pr);
  const prev = map[key] ?? { history: {} };
  const history = { ...prev.history };
  // A review without a net-patch key is kept under a head-scoped key so compaction never drops it; it can never be carried.
  history[rec.netPatchHash ?? `${NOKEY}${rec.head}`] = { head: rec.head, verdict: rec.verdict, at: rec.at };
  const kept = Object.entries(history).sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at) || (a[0] < b[0] ? -1 : 1)).slice(0, keepPerPr);
  map[key] = { lastReviewedHead: rec.head, netPatchHash: rec.netPatchHash ?? null, verdict: rec.verdict, at: rec.at, history: Object.fromEntries(kept) };
  return map;
}

const validEntry = e => e && SHA.test(e.lastReviewedHead ?? '') && typeof e.verdict === 'string' && e.verdict && Number.isFinite(Date.parse(e.at))
  && e.history && typeof e.history === 'object' && Object.values(e.history).every(h => h && SHA.test(h.head ?? '') && typeof h.verdict === 'string' && h.verdict && Number.isFinite(Date.parse(h.at)));
const validMap = m => m && typeof m === 'object' && Object.values(m).every(validEntry);
const parseLog = text => {
  const lines = text.split('\n').filter(l => l.trim());
  const map = {};
  for (const l of lines) {
    const rec = JSON.parse(l);
    if (!validRecord(rec)) throw Error('invalid log record');
    applyRecord(map, rec, Infinity);
  }
  return { map, lines: lines.length };
};
const hashText = text => createHash('sha256').update(text).digest('hex');
const size = (fs, p) => { try { return fs.statSync(p).size; } catch (e) { if (e?.code === 'ENOENT') return null; throw e; } };

/** Read the index. Uses the cached map only when its log content hash matches; rebuilds from the log otherwise. Never throws. */
export function readHeadIndex({ dir = defaultHeadIndexDir(), fs = nodeFs } = {}) {
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
    const text = fs.readFileSync(log, 'utf8');
    const logHash = hashText(text);
    if (stored && stored.map && typeof stored.map === 'object' && stored.version === MAP_VERSION && stored.logHash === logHash && validMap(stored.map)) return { ok: true, map: stored.map };
    return { ok: true, map: parseLog(text).map, rebuilt: true };
  } catch { return { ok: false, reason: 'index-unreadable' }; }
}
const existsSafe = (fs, p) => { try { fs.statSync(p); return true; } catch { return false; } };

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
  const holder = () => { try { return JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { return null; } };
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
      const dead = held ? Number.isInteger(held.pid) && !pidAlive(held.pid) : age > staleMs; // no readable owner: only after the grace
      if (dead) {
        // Move the stale lock aside atomically; only one contender wins the rename. What we moved is compared with what we
        // judged dead BEFORE anything is decided: a lock that changed (its owner re-created it between our read and the
        // rename) is a live owner's, so it is linked back. If a newer lock already exists, that newer holder wins and its
        // lock is left alone. Only `aside` is ever unlinked here, never `lock`.
        const aside = `${lock}.stale.${token}`;
        let renamed = false;
        try { fs.renameSync(lock, aside); renamed = true; } catch { /* another contender moved it */ }
        if (renamed) {
          let moved = null; try { moved = JSON.parse(fs.readFileSync(aside, 'utf8')); } catch { /* unreadable */ }
          const changed = held ? moved?.token !== held.token : moved !== null; // unreadable then is only "same" when we saw nothing readable either
          if (changed) { try { fs.linkSync(aside, lock); } catch { /* EEXIST: a newer holder exists and wins; never unlink `lock` */ } }
          try { fs.unlinkSync(aside); } catch { /* best effort */ }
        }
        continue;
      }
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
  const rec = { repo, pr: Number(pr), head, netPatchHash, verdict, at };
  if (!validRecord(rec)) throw Error(`review-head-index: invalid record (repo/pr/head/verdict/at): head=${String(head).slice(0, 12)} verdict=${String(verdict)}`);
  if (!posInt(keepPerPr) || !posInt(logMaxLines)) throw Error('review-head-index: invalid keepPerPr/logMaxLines');
  fs.mkdirSync(dir, { recursive: true });
  return withHeadIndexLock(dir, fence => {  // read, append, compact and publish are ONE transaction
    const { log, map: mapPath, tmp } = headIndexPaths(dir);
    const current = readHeadIndex({ dir, fs });
    if (!current.ok) throw Error('review-head-index: existing index unreadable; refusing to write');
    fence();
    durable(fs, log, 'a', `${JSON.stringify(rec)}\n`);            // 1. durable log line (fsynced)
    const map = applyRecord(current.map, rec, keepPerPr);       // 2. compacted map, temp then rename
    let lines = fs.readFileSync(log, 'utf8').split('\n').filter(l => l.trim()).length;
    if (lines > logMaxLines) { // 3. bound growth: rewrite the log from the compacted map, atomically, then the map
      const compact = Object.entries(map).flatMap(([k, v]) => {
        const [r, p] = [k.slice(0, k.lastIndexOf('#')), Number(k.slice(k.lastIndexOf('#') + 1))];
        const row = (hash, h) => ({ repo: r, pr: p, head: h.head, netPatchHash: hash.startsWith(NOKEY) ? null : hash, verdict: h.verdict, at: h.at });
        const older = Object.entries(v.history).sort((a, b) => Date.parse(a[1].at) - Date.parse(b[1].at)).map(([hash, h]) => row(hash, h));
        // The PR's current record goes LAST so a rebuild restores lastReviewedHead and its verdict exactly.
        return [...older, { repo: r, pr: p, head: v.lastReviewedHead, netPatchHash: v.netPatchHash, verdict: v.verdict, at: v.at }];
      });
      const text = compact.map(c => `${JSON.stringify(c)}\n`).join('');
      fence();
      atomicWrite(fs, log, `${log}.tmp`, text);
      lines = compact.length;
    }
    fence();
    atomicWrite(fs, mapPath, tmp, JSON.stringify({ version: MAP_VERSION, logHash: hashText(fs.readFileSync(log, 'utf8')), map }));
    return { ok: true, lines };
  }, { fs });
}

/**
 * Is a review owed for this PR head? Pure. `seed` (from seedFromReviewComments) stands in for a missing record. `index` is the result of readHeadIndex.
 * owed:null + held:true means unknown (fail closed): hold the PR, do not treat it as nothing-owed.
 */
const ACCEPT_HEAD = /^✅ review — accepted\r?\n/, CHANGES_HEAD = /^(?:🔁 )?(?:human )?review — changes requested\r?\n/;
// Any other trusted daemon/operator control comment (re-arm, stand-down, escalation, hold, pause, load-flake, supersede, or an
// unknown future hold): a symbol/emoji-led first line naming one of those. A later one withdraws an earlier accept.
const CONTROL_HEAD = /^(?:[^\p{L}\p{N}\s]️?\s*)+[^\r\n]*?(?:conveyor|re-?armed?|stood down|stand[- ]?down|escalat|\bhold\b|\bheld\b|\bpaus|supersed)/iu;
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
    else if (CONTROL_HEAD.test(body)) latest = { kind: 'control', body }; // re-arm / stand-down / escalation / hold: not an accept
  }
  if (latest?.kind !== 'accept') return null;
  let open = null, found = null; // open = { ch, len } of the fence we are inside
  for (const line of latest.body.split(/\r?\n/).slice(0, 12)) {
    const f = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (open) {
      // Close only on the same fence char, at least as long as the opener, with nothing after it but whitespace.
      if (f && f[1][0] === open.ch && f[1].length >= open.len && f[2].trim() === '') open = null;
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
