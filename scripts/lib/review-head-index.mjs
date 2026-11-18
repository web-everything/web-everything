/**
 * @file scripts/lib/review-head-index.mjs
 * @description R554 durable per-head review index. One record per PR: {lastReviewedHead, netPatchHash, verdict, at}
 * plus a history keyed by netPatchHash (latest N kept). Stored as a JSONL log (source of truth) and a
 * cached map, both under one directory beside the runs dir (.operations/review-head-index).
 *
 * - A review is OWED whenever the PR's current head differs from lastReviewedHead, however old the record is or
 *   how many run records exist. It does not depend on any run scan cap.
 * - A verdict already given on the same net patch (same merge-base + exact diff) is carried, not re-reviewed.
 * - Fail closed: an unreadable index answers `{owed:null, held:true}`; it is never read as "nothing owed".
 * - One shared withFileLock hold serialises every writer: read, prepare/compact in memory, fsync a temp log,
 *   rename over the log (the sole acceptance point), atomically publish the map, then fsync the directory.
 *   Automatic stale takeover is disabled: validation plus rename requires uninterrupted exclusion.
 *   Abandoned locks require an operator to stop index writers, remove the lock, then retry.
 *   Unique per-writer temps and a final byte comparison also detect changes during candidate preparation.
 *   Before acceptance failures leave the old log byte-identical; after acceptance readers recover from the log.
 *   The directory is synced after acceptance even if map publication fails.
 * - Readers stay lock-free and trust the map only when its logHash matches the complete log bytes they read.
 */
import * as nodeFs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { withFileLock } from './atomic-json-file.mjs';
import { cascadePolicy } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { REVIEWED_SHA_MARKER } from './review-escalation.mjs';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';

const SHA = /^[0-9a-f]{40}$/;
// SHA.test() coerces its argument to a string, so an array [sha] or a String object would pass it. Every untrusted sha goes through isSha.
const isSha = v => typeof v === 'string' && SHA.test(v);
export const HEAD_INDEX_STANDARD = Object.freeze({ keepPerPr: 20, logMaxLines: 2000 });
export const MAP_VERSION = 2;
const posInt = v => Number.isSafeInteger(v) && v > 0;

/**
 * A SIBLING of the coordination root (not inside it, not inside <root>/runs): <dirname(root)>/review-head-index. The default
 * root is <home>/workspace/.operations/coordination, so the index is <home>/workspace/.operations/review-head-index. A root
 * overridden through WE_COORDINATION_ROOT moves the index with it (<dirname(override)>/review-head-index).
 */
export function defaultHeadIndexDir(env = process.env) { return join(dirname(resolveCoordinationRoot({ env })), 'review-head-index'); }
export function headIndexPaths(dir) { return { log: join(dir, 'log.jsonl'), map: join(dir, 'map.json'), lock: join(dir, 'lock') }; }

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
    if (!isSha(sha)) throw Error('invalid head');
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
// A net-patch key names a property of the history object, so it must be a plain token: it starts with a letter or digit, which
// refuses `__proto__` (it would set the object's prototype instead of a key). Real keys are sha256 hex. Lookups also use hasOwn.
// It must also never start with NOKEY ('head:'): that prefix is the keyless-history namespace, so such a key would collide with
// a keyless review's slot, compact to a null hash and let a keyless review be carried as if it had a patch key.
const PATCH_KEY = /^(?!head:)[A-Za-z0-9][\w.:-]{0,127}$/;
const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
// pr must already BE a positive safe integer: Number() coercion would accept null, '', true and '7' as PR numbers.
const validRecord = r => r && typeof r.repo === 'string' && r.repo && Number.isSafeInteger(r.pr) && r.pr > 0 && typeof r.head === 'string' && SHA.test(r.head)
  && (r.netPatchHash == null || (typeof r.netPatchHash === 'string' && PATCH_KEY.test(r.netPatchHash)))
  && typeof r.verdict === 'string' && r.verdict && typeof r.at === 'string' && Number.isFinite(Date.parse(r.at)) && (r.txn === undefined || (typeof r.txn === 'string' && TXN.test(r.txn)));

/** PURE: fold one record into the map and keep only the latest `keepPerPr` history entries for that PR. */
export function applyRecord(map, rec, keepPerPr) {
  const key = prKey(rec.repo, rec.pr);
  const prev = map[key] ?? { history: {} };
  const history = { ...prev.history };
  // A review without a net-patch key is kept under a head-scoped key so compaction never drops it; it can never be carried.
  // The writer's txn rides along with every kept entry so compaction preserves the row's identity.
  const txn = rec.txn === undefined ? {} : { txn: rec.txn };
  // The latest verdict for a head supersedes every earlier entry for that same head, whatever its key: otherwise a later
  // keyless reject leaves the keyed accept for the head in place and a later head with that patch key carries the superseded accept.
  for (const [k, entry] of Object.entries(history)) if (entry.head === rec.head) delete history[k];
  history[rec.netPatchHash ?? `${NOKEY}${rec.head}`] = { head: rec.head, verdict: rec.verdict, at: rec.at, ...txn };
  const kept = Object.entries(history).sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at) || (a[0] < b[0] ? -1 : 1)).slice(0, keepPerPr);
  map[key] = { lastReviewedHead: rec.head, netPatchHash: rec.netPatchHash ?? null, verdict: rec.verdict, at: rec.at, ...txn, history: Object.fromEntries(kept) };
  return map;
}

// typeof string first: SHA.test()/Date.parse() coerce an array like [sha] to its string form and would accept it.
const validEntry = e => e && typeof e.lastReviewedHead === 'string' && SHA.test(e.lastReviewedHead) && typeof e.verdict === 'string' && e.verdict
  && typeof e.at === 'string' && Number.isFinite(Date.parse(e.at))
  && e.history && typeof e.history === 'object' && Object.values(e.history).every(h => h && typeof h.head === 'string' && SHA.test(h.head)
    && typeof h.verdict === 'string' && h.verdict && typeof h.at === 'string' && Number.isFinite(Date.parse(h.at)));
const validMap = m => m && typeof m === 'object' && Object.values(m).every(validEntry);
// Replay applies the SAME keepPerPr the writer used, so a rebuilt map equals the published one: evicted history is not
// resurrected, and a compacted log (older rows then the PR's current record last, keyed or keyless) replays to the same map.
const hashText = text => createHash('sha256').update(text).digest('hex');
const parseLog = (text, keepPerPr) => {
  const allRows = text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  const map = {}, rows = [];
  for (const rec of allRows) {
    if (!validRecord(rec)) throw Error('invalid log record');
    rows.push(rec);
    applyRecord(map, rec, keepPerPr);
  }
  return { map, rows, lines: rows.length };
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
    const raw = fs.readFileSync(log); // hash raw bytes, never a lossy UTF-8 decode
    const logHash = hashText(raw);
    if (stored && stored.map && typeof stored.map === 'object' && stored.version === MAP_VERSION && stored.logHash === logHash && validMap(stored.map)) return { ok: true, map: stored.map };
    return { ok: true, map: parseLog(raw.toString('utf8'), rebuildKeep(keepPerPr, stored, settingsFile)).map, rebuilt: true };
  } catch { return { ok: false, reason: 'index-unreadable' }; }
}
// Only ENOENT means absent; any other stat failure (EACCES, EIO, ...) throws so the caller fails closed instead of reading an empty index.
const existsSafe = (fs, p) => { try { fs.statSync(p); return true; } catch (e) { if (e?.code === 'ENOENT') return false; throw e; } };

// Durable: write, fsync, close. The rename happens only after the temp file is flushed.
const durable = (fs, path, flag, text) => {
  const fd = fs.openSync(path, flag);
  try { const buf = Buffer.from(text); let off = 0; while (off < buf.length) { const n = fs.writeSync(fd, buf, off, buf.length - off); if (!(n > 0)) throw Error('review-head-index: short write'); off += n; } fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
// Persist the renamed names too. Skip only platforms that do not support directory fsync.
const syncDir = (fs, dir) => {
  try { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  catch (e) { if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(e?.code)) throw e; }
};
const atomicWrite =(fs, path, tmp, text) => { durable(fs, tmp, 'wx', text); fs.renameSync(tmp, path); };
// The shared helper moves a stale lock before verifying its holder. Another writer
// could enter that gap, including between our final read and log rename. Keep the
// same exclusive lock, but never reclaim it automatically; timeout fails closed.
const withHeadIndexLock = (lock, fn) => {
  try { return withFileLock(lock, fn, { staleMs: Infinity }); }
  catch (e) {
    if (String(e?.message).startsWith(`withFileLock: timed out waiting for ${lock} `)) {
      throw Error(`review-head-index: lock acquisition timed out; stop all index writers, remove the abandoned lock at ${lock}, then retry`, { cause: e });
    }
    throw e;
  }
};

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
  const { log, map: mapPath, lock } = headIndexPaths(dir);
  return withHeadIndexLock(lock, () => {
    let raw, logPresent = true;
    try { raw = fs.readFileSync(log); }
    catch (e) {
      let mapPresent = true;
      if (e?.code === 'ENOENT') { try { mapPresent = existsSafe(fs, mapPath); } catch { mapPresent = true; } }
      if (e?.code !== 'ENOENT' || mapPresent) throw Error('review-head-index: existing index unreadable; refusing to write', { cause: e });
      logPresent = false;
      raw = Buffer.alloc(0);
    }
    let parsed;
    try { parsed = parseLog(raw.toString('utf8'), keepPerPr); }
    catch (e) { throw Error('review-head-index: existing index unreadable; refusing to write', { cause: e }); }
    const row = { ...rec, txn: randomUUID() };
    const line = `${JSON.stringify(row)}\n`;
    let text = Buffer.concat([raw, Buffer.from((raw.length && raw.at(-1) !== 10 ? '\n' : '') + line)]);
    let lines = parsed.lines + 1;
    if (lines > logMaxLines) {
      // Compact ONLY the committed snapshot. Select original rows so txn and all writer fields survive.
      // The candidate remains last and is never folded into the committed history before acceptance.
      const compact = Object.entries(parsed.map).flatMap(([key, value]) => {
        const repo = key.slice(0, key.lastIndexOf('#')), pr = Number(key.slice(key.lastIndexOf('#') + 1));
        const original = (hash, entry) => {
          const source = parsed.rows.findLast(r => r.repo === repo && r.pr === pr &&
            (entry.txn === undefined || r.txn === entry.txn) && r.head === entry.head &&
            (r.netPatchHash ?? null) === hash && r.at === entry.at && r.verdict === entry.verdict);
          return { ...source };
        };
        const current = value.netPatchHash ?? `${NOKEY}${value.lastReviewedHead}`;
        const older = Object.entries(value.history).filter(([hash]) => hash !== current)
          .sort((a, b) => Date.parse(a[1].at) - Date.parse(b[1].at))
          .map(([hash, entry]) => original(hash.startsWith(NOKEY) ? null : hash, entry));
        return [...older, original(value.netPatchHash, { ...value, head: value.lastReviewedHead })];
      });
      text = compact.map(r => `${JSON.stringify(r)}\n`).join('') + line;
      lines = compact.length + 1;
    }
    const published = JSON.stringify({ version: MAP_VERSION, logHash: hashText(text), keepPerPr,
      map: parseLog(text.toString('utf8'), keepPerPr).map });
    const suffix = `${process.pid}.${row.txn}.tmp`;
    const logTmp = `${log}.${suffix}`, mapTmp = `${mapPath}.${suffix}`;
    try {
      durable(fs, logTmp, 'wx', text);
      // Refuse to replace a log changed outside this lock while the candidate
      // was prepared. Exclusion, rather than this comparison, protects publication.
      let current;
      try { current = fs.readFileSync(log); }
      catch (e) {
        if (e?.code !== 'ENOENT') throw Error('review-head-index: log changed or unreadable; refusing to write', { cause: e });
        current = null;
      }
      if (current === null ? logPresent : !logPresent || !current.equals(raw)) {
        throw Error('review-head-index: log changed; refusing to write');
      }
      fs.renameSync(logTmp, log); // ACCEPT: no readable candidate exists before this rename
      try { atomicWrite(fs, mapPath, mapTmp, published); }
      finally { syncDir(fs, dir); }
      return { ok: true, lines };
    } finally {
      // Cleanup never changes committed state, including after a failed cache publication.
      for (const path of [logTmp, mapTmp]) { try { fs.unlinkSync(path); } catch { /* absent or cleanup unavailable */ } }
    }
  });
}

/**
 * Is a review owed for this PR head? Pure. `seed` (from seedFromReviewComments) stands in for a missing record. `index` is the result of readHeadIndex.
 * owed:null + held:true means unknown (fail closed): hold the PR, do not treat it as nothing-owed.
 */
const ACCEPT_HEAD = /^✅ review — accepted(?:\r?\n|$)/, CHANGES_HEAD = /^(?:🔁 )?(?:human )?review — changes requested(?:\r?\n|$)/;
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
  let open = null, found = null; const stack = []; // open = { ch, len } of the fence we are inside; stack = open HTML container tag names
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
    // HTML blockquotes and raw-text/code containers (pre, code, script, style, textarea) quote like Markdown ones: a marker inside one (stack non-empty) is quoted text, and the tag lines themselves never carry a marker.
    // Tags are counted in order, case-insensitively, several per line; a stray closer never goes below 0, an unclosed opener quotes the rest.
    let tagLine = false;
    // A closer pops only back to its own matching opener; a closer with no matching open tag is ignored (fail closed: it can never end another container's quote).
    for (const t of line.matchAll(/<(\/?)(blockquote|pre|code|script|style|textarea)(?=[\s/>]|$)/gi)) {
      tagLine = true;
      const name = t[2].toLowerCase();
      if (!t[1]) stack.push(name);
      else { const i = stack.lastIndexOf(name); if (i >= 0) stack.length = i; }
    }
    if (tagLine || stack.length > 0) continue;
    const m = MARKER_LINE.exec(line);
    if (m) found = m[1];
  }
  return found ? { lastReviewedHead: found, verdict: 'marker', source: 'reviewed-sha-marker' } : null;
}

export function headReviewOwed({ index, repo, pr, head, netPatchHash = null, seed = null } = {}) {
  if (!index || index.ok !== true || !index.map) return { owed: null, held: true, reason: 'index-unreadable' };
  if (!isSha(head)) return { owed: null, held: true, reason: 'head-unreadable' };
  const r = hasOwn(index.map, prKey(repo, pr)) ? index.map[prKey(repo, pr)] : null;
  if (!r) {
    // Pre-index PR: seed from the latest trusted reviewed-sha marker. No marker (or no seed given) is owed, never nothing-owed.
    if (seed && isSha(seed.lastReviewedHead)) {
      return seed.lastReviewedHead === head ? { owed: false, reason: 'same-head', seeded: true, verdict: seed.verdict }
        : { owed: true, reason: 'new-head', seeded: true, lastReviewedHead: seed.lastReviewedHead };
    }
    return { owed: true, reason: 'no-record' };
  }
  if (r.lastReviewedHead === head) return { owed: false, reason: 'same-head', verdict: r.verdict };
  // Own keys only: a caller-supplied `__proto__` or `constructor` must not resolve to an inherited value and read as a carried review.
  // A key in the keyless namespace ('head:...') is not a patch key, so it never reads a keyless slot.
  const prior = typeof netPatchHash === 'string' && PATCH_KEY.test(netPatchHash) && hasOwn(r.history, netPatchHash) ? r.history[netPatchHash] : null;
  if (prior) return { owed: false, carried: true, reason: 'same-net-patch', verdict: prior.verdict, fromHead: prior.head };
  return { owed: true, reason: 'new-head', lastReviewedHead: r.lastReviewedHead };
}
