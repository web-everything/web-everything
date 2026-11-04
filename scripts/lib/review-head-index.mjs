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

const SHA = /^[0-9a-f]{40}$/;
export const HEAD_INDEX_STANDARD = Object.freeze({ keepPerPr: 20, logMaxLines: 2000 });
const posInt = v => Number.isSafeInteger(v) && v > 0;

/** Sibling of the shared runs dir: <operations>/review-head-index. */
export function defaultHeadIndexDir(env = process.env) { return join(dirname(resolveCoordinationRoot({ env })), 'review-head-index'); }
export function headIndexPaths(dir) { return { log: join(dir, 'log.jsonl'), map: join(dir, 'map.json'), tmp: join(dir, 'map.json.tmp') }; }

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

const prKey = (repo, pr) => `${repo}#${Number(pr)}`;
const validRecord = r => r && typeof r.repo === 'string' && r.repo && Number.isSafeInteger(Number(r.pr)) && SHA.test(r.head ?? '')
  && typeof r.verdict === 'string' && r.verdict && Number.isFinite(Date.parse(r.at));

/** PURE: fold one record into the map and keep only the latest `keepPerPr` history entries for that PR. */
export function applyRecord(map, rec, keepPerPr) {
  const key = prKey(rec.repo, rec.pr);
  const prev = map[key] ?? { history: {} };
  const history = { ...prev.history };
  if (rec.netPatchHash) history[rec.netPatchHash] = { head: rec.head, verdict: rec.verdict, at: rec.at };
  const kept = Object.entries(history).sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at) || (a[0] < b[0] ? -1 : 1)).slice(0, keepPerPr);
  map[key] = { lastReviewedHead: rec.head, netPatchHash: rec.netPatchHash ?? null, verdict: rec.verdict, at: rec.at, history: Object.fromEntries(kept) };
  return map;
}

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
const size = (fs, p) => { try { return fs.statSync(p).size; } catch (e) { if (e?.code === 'ENOENT') return null; throw e; } };

/** Read the index. O(1) when the map matches the log size; rebuilds from the log otherwise. Never throws. */
export function readHeadIndex({ dir = defaultHeadIndexDir(), fs = nodeFs } = {}) {
  try {
    const { log, map: mapPath } = headIndexPaths(dir);
    const logSize = size(fs, log);
    let stored = null;
    try { stored = JSON.parse(fs.readFileSync(mapPath, 'utf8')); } catch (e) { if (e?.code !== 'ENOENT') stored = null; }
    if (logSize === null) {
      if (!existsSafe(fs, mapPath)) return { ok: true, map: {} };
      return { ok: false, reason: 'index-unreadable' }; // a map with no log is not a state we write
    }
    if (stored && stored.map && typeof stored.map === 'object' && stored.logBytes === logSize) return { ok: true, map: stored.map };
    return { ok: true, map: parseLog(fs.readFileSync(log, 'utf8')).map, rebuilt: true };
  } catch { return { ok: false, reason: 'index-unreadable' }; }
}
const existsSafe = (fs, p) => { try { fs.statSync(p); return true; } catch { return false; } };

const atomicWrite = (fs, path, tmp, text) => { fs.writeFileSync(tmp, text); fs.renameSync(tmp, path); };

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
  const { log, map: mapPath, tmp } = headIndexPaths(dir);
  const current = readHeadIndex({ dir, fs });
  if (!current.ok) throw Error('review-head-index: existing index unreadable; refusing to write');
  fs.appendFileSync(log, `${JSON.stringify(rec)}\n`);          // 1. durable log line
  const map = applyRecord(current.map, rec, keepPerPr);       // 2. compacted map, temp then rename
  let lines = fs.readFileSync(log, 'utf8').split('\n').filter(l => l.trim()).length;
  if (lines > logMaxLines) { // 3. bound growth: rewrite the log from the compacted map, atomically, then the map
    const compact = Object.entries(map).flatMap(([k, v]) => {
      const [r, p] = [k.slice(0, k.lastIndexOf('#')), Number(k.slice(k.lastIndexOf('#') + 1))];
      return Object.entries(v.history).sort((a, b) => Date.parse(a[1].at) - Date.parse(b[1].at))
        .map(([hash, h]) => ({ repo: r, pr: p, head: h.head, netPatchHash: hash, verdict: h.verdict, at: h.at }));
    });
    const text = compact.map(c => `${JSON.stringify(c)}\n`).join('');
    atomicWrite(fs, log, `${log}.tmp`, text);
    lines = compact.length;
  }
  atomicWrite(fs, mapPath, tmp, JSON.stringify({ logBytes: size(fs, log), map }));
  return { ok: true, lines };
}

/**
 * Is a review owed for this PR head? Pure. `index` is the result of readHeadIndex.
 * owed:null + held:true means unknown (fail closed): hold the PR, do not treat it as nothing-owed.
 */
export function headReviewOwed({ index, repo, pr, head, netPatchHash = null } = {}) {
  if (!index || index.ok !== true || !index.map) return { owed: null, held: true, reason: 'index-unreadable' };
  if (!SHA.test(head ?? '')) return { owed: null, held: true, reason: 'head-unreadable' };
  const r = index.map[prKey(repo, pr)];
  if (!r) return { owed: true, reason: 'no-record' };
  if (r.lastReviewedHead === head) return { owed: false, reason: 'same-head', verdict: r.verdict };
  const prior = netPatchHash ? r.history?.[netPatchHash] : null;
  if (prior) return { owed: false, carried: true, reason: 'same-net-patch', verdict: prior.verdict, fromHead: prior.head };
  return { owed: true, reason: 'new-head', lastReviewedHead: r.lastReviewedHead };
}
