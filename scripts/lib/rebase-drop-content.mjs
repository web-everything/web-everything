/**
 * rebase-drop-content.mjs — #2371, the "safe-content" extension of the drain's rebase-drop (#2198) beyond the
 * manifest-only case: any provably-safe content conflict, i.e. a `git merge-tree` conflict where EVERY hunk is
 * NON-OVERLAPPING (the two sides changed disjoint base-line ranges — classic append/append, or edits to
 * different regions). This is a WIDENING of the deterministic-vs-judgment band (#51) by exactly one step: an
 * overlapping hunk (both sides touched the SAME base lines) is genuine semantic divergence and is left, as
 * before, for `/finish`. See `backlog/2371-safe-content-rebase-drop-auto-resolve-non-overlapping-hunk-c.md`.
 *
 * WHY THIS IS NOT `git merge-file`: git's own line-based 3-way merge treats two pure appends to the SAME file
 * tail as a conflict too (both insertions anchor at the identical position, so it cannot order them) — exactly
 * the observed 2026-07-09 storm (~5 `/slice` PRs each appending a verdict to one report file, all CONFLICTING).
 * That is precisely the case this item wants auto-resolved: neither side touched any EXISTING base line, so
 * there is nothing to arbitrate — both appends are kept (deterministic order: the `base` arg's side first, then
 * the lane's). The hunk model here is therefore base-line-RANGE overlap, not merge-file's stricter anchor-based
 * conflict detection: `diffLines` computes each side's changed base-line ranges independently (base→ours,
 * base→theirs); two hunks overlap only if their base ranges truly intersect. Two zero-width insertions at the
 * SAME position (the append/append case) never intersect by construction, so they compose safely.
 *
 * PLUMBING: reuses `parseMergeTree` (rebase-drop-manifest.mjs) for the tree-OID + conflicted-path list, adds
 * `parseConflictStages` to pull each conflicted path's THREE blob OIDs (stage 1=common ancestor, 2=`base`-arg
 * side, 3=lane side) straight off the same `git merge-tree --write-tree` output — no extra git calls needed to
 * learn WHAT conflicts. Reading blob CONTENT (`cat-file -p <oid>`) and writing a resolved blob back
 * (`hash-object -w --stdin` + `update-index --cacheinfo`) is the same no-checkout, temp-index pattern
 * `rebase-drop-manifest.mjs` and `nnn-collision-heal.mjs` already use — this file adds no new transport, only a
 * new (still pure, still injectable-`run`) classification + resolution step.
 *
 * SCOPE GUARD: only a path with ALL THREE stages present, all mode `100644` (a regular file, not a rename/
 * delete/mode conflict), and safely-decodable UTF-8 text content is even attempted — anything else is `real`
 * (skip). "Safe text" here means the raw blob bytes carry NO NUL byte AND round-trip losslessly through a
 * UTF-8 decode+encode: blobs are read as raw `Buffer`s (never utf8-decoded at the git boundary), so a NUL-free
 * but non-UTF-8 blob (latin-1 / other 8-bit text / an invalid byte sequence) is caught here instead of being
 * lossily coerced to U+FFFD and hashed back altered — that would defeat the byte-exact guarantee. A file too
 * large to diff safely (either side over `MAX_DIFF_LINES`) is also `real` — this stays a PROVABLY-safe
 * resolver, never a best-effort guess on a giant/binary/non-UTF-8 blob.
 */

import { loadCardRebaseSettings, cardTreeOnly, pinCardInputs, cardSquashRebuild } from './card-squash-rebuild.mjs';
import { gitRun as gitRunner, hashObjectVerified, verifyTreeBlob, ensureFullHistory } from './git-run.mjs';
import { LANE_MANIFEST, parseMergeTree } from './rebase-drop-manifest.mjs';
import { refuseHeldPush } from '../conveyor/fix-procedure.mjs';

export { LANE_MANIFEST };

/** DP diff is O(n·m) time AND space; a two-sided 3000×3000 int32 table is ~36MB, generous for any real report/
 *  doc file and cheap insurance against a pathological huge blob hanging the drain. Beyond this, `diffLines`
 *  returns null and the path is treated as unsafe (skip → `/finish`), never a slow/best-effort guess. */
export const MAX_DIFF_LINES = 3000;

// ── pure line diff/merge ─────────────────────────────────────────────────────────────────────────────────

/** Split text into lines that RETAIN their trailing `\n` (the final line keeps none if the text doesn't end in
 *  one) — so re-joining with `.join('')` reproduces the exact original bytes, no reconstruction ambiguity. */
export function splitLinesKeepEnds(text) {
  if (text === '') return [];
  return String(text).match(/[^\n]*\n|[^\n]+$/g) || [];
}

/**
 * Line-based LCS diff from `a` to `b`. Pure. Returns hunks — contiguous non-equal runs, each
 * `{ aStart, aEnd, bStart, bEnd }` (end exclusive) marking a base range REPLACED (aEnd>aStart AND bEnd>bStart),
 * DELETED (bEnd===bStart), or INSERTED (aEnd===aStart) with `b[bStart:bEnd]`. Returns `null` if either side
 * exceeds `MAX_DIFF_LINES` (too large to diff safely — the caller treats that as unsafe/real).
 */
export function diffLines(a, b) {
  const n = a.length, m = b.length;
  if (n > MAX_DIFF_LINES || m > MAX_DIFF_LINES) return null;
  // dp[i][j] = LCS length of a[i:], b[j:]. Built bottom-up (Int32Array rows keep this cheap).
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Int32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const hunks = [];
  let i = 0, j = 0, cur = null;
  const flush = () => { if (cur) { hunks.push(cur); cur = null; } };
  while (i < n && j < m) {
    if (a[i] === b[j]) { flush(); i++; j++; continue; }
    if (dp[i + 1][j] >= dp[i][j + 1]) {
      if (!cur) cur = { aStart: i, aEnd: i, bStart: j, bEnd: j };
      cur.aEnd = i + 1; i++;
    } else {
      if (!cur) cur = { aStart: i, aEnd: i, bStart: j, bEnd: j };
      cur.bEnd = j + 1; j++;
    }
  }
  while (i < n) { if (!cur) cur = { aStart: i, aEnd: i, bStart: j, bEnd: j }; cur.aEnd = i + 1; i++; }
  while (j < m) { if (!cur) cur = { aStart: i, aEnd: i, bStart: j, bEnd: j }; cur.bEnd = j + 1; j++; }
  flush();
  return hunks;
}

/** Do two hunks (base-line-range `[aStart,aEnd)`) truly intersect? Pure. Two ZERO-WIDTH insertions at the same
 *  position (`aStart === aEnd` for both, same value) do NOT overlap by this definition — the append/append
 *  case this item exists to unblock. */
export function hunksOverlap(h1, h2) {
  return !(h1.aEnd <= h2.aStart || h2.aEnd <= h1.aStart);
}

/**
 * Merge `oursHunks` + `theirsHunks` (both diffed against the SAME `baseLines`) into one line array, given they
 * are already known non-overlapping. Pure. At a shared insertion point, `ours` composes before `theirs`
 * (deterministic, stable order — not a judgment call, just a tie-break for zero-width ties).
 */
export function unionMerge(baseLines, oursHunks, theirsHunks, oursLines, theirsLines) {
  const tagged = [
    ...oursHunks.map((h) => ({ ...h, side: 0, lines: oursLines.slice(h.bStart, h.bEnd) })),
    ...theirsHunks.map((h) => ({ ...h, side: 1, lines: theirsLines.slice(h.bStart, h.bEnd) })),
  ].sort((x, y) => x.aStart - y.aStart || x.side - y.side);
  const out = [];
  let pos = 0;
  for (const h of tagged) {
    if (h.aStart > pos) { out.push(...baseLines.slice(pos, h.aStart)); pos = h.aStart; }
    out.push(...h.lines);
    pos = Math.max(pos, h.aEnd);
  }
  out.push(...baseLines.slice(pos));
  return out;
}

/**
 * The core decision: can `baseLines`/`oursLines`/`theirsLines` merge with NO judgment call? Pure.
 * @returns {{ok:true, lines:string[]}|{ok:false, reason:string}}
 */
export function threeWayMergeLines(baseLines, oursLines, theirsLines) {
  const oursHunks = diffLines(baseLines, oursLines);
  const theirsHunks = diffLines(baseLines, theirsLines);
  if (!oursHunks || !theirsHunks) return { ok: false, reason: 'file too large to diff safely' };
  for (const h1 of oursHunks) for (const h2 of theirsHunks) {
    if (hunksOverlap(h1, h2)) return { ok: false, reason: 'overlapping hunk (both sides changed the same lines)' };
  }
  return { ok: true, lines: unionMerge(baseLines, oursHunks, theirsHunks, oursLines, theirsLines) };
}

/** Text-level wrapper around `threeWayMergeLines` — the unit the git plumbing actually reads/writes. Pure.
 *  Refuses binary content (a NUL byte anywhere) outright; a binary diff has no "line" to reason about. */
export function mergeTextThreeWay(baseText, oursText, theirsText) {
  if (baseText.includes('\0') || oursText.includes('\0') || theirsText.includes('\0')) {
    return { ok: false, reason: 'binary content' };
  }
  const r = threeWayMergeLines(splitLinesKeepEnds(baseText), splitLinesKeepEnds(oursText), splitLinesKeepEnds(theirsText));
  if (!r.ok) return r;
  return { ok: true, text: r.lines.join('') };
}

/**
 * Decode RAW blob bytes to text ONLY when they are safe, lossless text — the byte-exactness guard. Pure.
 * Returns the decoded string, or `null` when the content must NOT be touched: it holds a NUL byte (binary), or
 * it does NOT round-trip through a UTF-8 decode+encode (latin-1 / other 8-bit text / an invalid UTF-8 byte
 * sequence). Without this, `git cat-file -p`'s utf8 decode would lossily coerce such bytes to U+FFFD *before*
 * the NUL check, and hashing that back would land ALTERED content on main. A NUL byte is itself valid UTF-8
 * (round-trips fine), so it needs its own explicit check. Accepts a `Buffer` (the real git path) or a `string`
 * (already-safe text, e.g. an injected test blob) — a string is normalized through UTF-8 and always passes.
 */
export function decodeBlobTextStrict(raw) {
  if (raw == null) return null;
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  if (bytes.includes(0)) return null; // NUL byte → binary, not line-mergeable text
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return null; // lossy decode (non-UTF-8) → would corrupt on write-back
  return text;
}

/**
 * The shrink floor: what fraction of the SMALLER surviving side a merge must retain to count as a merge. Pure
 * union-merging two non-overlapping edits normally yields something at least as large as the smaller side; a
 * result far below it means the composition ate content it should have kept. 0.5 is deliberately loose — this
 * is a last-resort tripwire for a resolver gone wrong, not a style rule. Falling below it parks the lane for
 * `/finish`, which is always safe: the worst case is a human merges by hand. */
export const MIN_MERGE_RETENTION = 0.5;

/**
 * Belt-and-braces sanity on a computed merge, INDEPENDENT of content type (#2923). "Auto-resolved" must mean
 * merged — never "silently dropped". A backlog card that lands empty is caught by its schema validator; an
 * emptied doc, report or source file has NO such tripwire, so the resolver itself has to refuse. Pure.
 *
 * Refuses when:
 *   - the merge is EMPTY but some side had content (nothing legitimately merges two real files into nothing);
 *   - the merge retained less than `MIN_MERGE_RETENTION` of the smaller non-empty side.
 * A genuinely empty result from genuinely empty inputs is fine and passes.
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function checkMergeSanity(baseText, oursText, theirsText, mergedText) {
  const size = (t) => Buffer.byteLength(String(t ?? ''), 'utf8');
  const merged = size(mergedText);
  const ours = size(oursText);
  const theirs = size(theirsText);
  const biggestInput = Math.max(size(baseText), ours, theirs);
  if (biggestInput === 0) return { ok: true }; // all sides empty — an empty merge is the correct answer
  if (merged === 0) {
    return { ok: false, reason: `merge produced an EMPTY result from non-empty inputs (base ${size(baseText)}B, ours ${ours}B, theirs ${theirs}B) — refusing to stage a zero-byte file` };
  }
  const smallestSide = Math.min(ours || Infinity, theirs || Infinity);
  if (Number.isFinite(smallestSide) && merged < smallestSide * MIN_MERGE_RETENTION) {
    return { ok: false, reason: `merge result (${merged}B) is drastically smaller than both sides (ours ${ours}B, theirs ${theirs}B) — content was lost, not merged` };
  }
  return { ok: true };
}

// ── merge-tree conflict-stage parsing ────────────────────────────────────────────────────────────────────

/**
 * Parse `git merge-tree --write-tree`'s "Conflicted file info" block into per-path, per-stage blob info. Pure.
 * Stage 1 = common ancestor, 2 = the FIRST tree arg's side (`base` in this repo's call convention), 3 = the
 * SECOND tree arg's side (the lane ref). A path missing a stage means it didn't exist on that side (add/add or
 * delete conflict) — never content-mergeable; the caller's scope guard requires all three.
 * @returns {Object<string, {1?:{mode,oid}, 2?:{mode,oid}, 3?:{mode,oid}}>}
 */
export function parseConflictStages(stdout, exitCode) {
  const byPath = {};
  if (Number(exitCode) === 0) return byPath;
  const lines = String(stdout ?? '').split('\n');
  for (const line of lines.slice(1)) {
    if (line.trim() === '') break;
    const m = line.match(/^(\d{6}) ([0-9a-f]+) ([1-3])\t(.+)$/);
    if (!m) continue;
    const [, mode, oid, stage, path] = m;
    byPath[path] = byPath[path] || {};
    byPath[path][stage] = { mode, oid };
  }
  return byPath;
}

/**
 * Given the non-manifest conflicting paths + their parsed stage info, decide whether EVERY one is a safe
 * non-overlapping 3-way content merge. Pure, given an injected `readBlob(oid) -> Buffer|string|null` — RAW blob
 * bytes (the only I/O); each is strictly decoded via `decodeBlobTextStrict`, so a NUL-free but non-UTF-8 blob
 * is rejected as unsafe rather than lossily coerced to U+FFFD and hashed back altered.
 * Short-circuits on the FIRST unsafe path (order = input order) — a single overlapping/unsafe path means the
 * whole PR stays a skip, so there is nothing to gain from planning the rest.
 * @returns {{ok:true, merges:Object<string,string>}|{ok:false, reason:string, path:string}}
 */
export function planContentMerges(paths, stages, readBlob) {
  const merges = {};
  for (const path of paths) {
    const st = stages[path] || {};
    if (!st['1'] || !st['2'] || !st['3']) return { ok: false, reason: 'add/delete or rename conflict (no common-ancestor stage)', path };
    if (st['1'].mode !== '100644' || st['2'].mode !== '100644' || st['3'].mode !== '100644') {
      return { ok: false, reason: 'non-regular-file mode conflict', path };
    }
    const baseRaw = readBlob(st['1'].oid);
    const oursRaw = readBlob(st['2'].oid);
    const theirsRaw = readBlob(st['3'].oid);
    if (baseRaw == null || oursRaw == null || theirsRaw == null) return { ok: false, reason: 'could not read blob content', path };
    const base = decodeBlobTextStrict(baseRaw);
    const ours = decodeBlobTextStrict(oursRaw);
    const theirs = decodeBlobTextStrict(theirsRaw);
    if (base == null || ours == null || theirs == null) return { ok: false, reason: 'binary or non-UTF-8 content (not safe to round-trip as text)', path };
    const merged = mergeTextThreeWay(base, ours, theirs);
    if (!merged.ok) return { ok: false, reason: merged.reason, path };
    // #2923 — a content-type-agnostic refusal to emit a degenerate result. Skipping here parks the lane as a
    // real conflict for `/finish`, which is the safe direction; committing a silently-emptied file is not.
    const sane = checkMergeSanity(base, ours, theirs, merged.text);
    if (!sane.ok) return { ok: false, reason: sane.reason, path };
    merges[path] = merged.text;
  }
  return { ok: true, merges };
}

// ── imperative git boundary ──────────────────────────────────────────────────────────────────────────────

const firstLine = (s) => String(s || '').split('\n')[0];

/** The default real git runner — now the ONE shared runner (`scripts/lib/git-run.mjs`), re-exported under the
 *  historical name. #2923: this file used to define its own full-contract `gitRunner` while
 *  `rebase-drop-manifest.mjs` exported a WEAKER function of the same name, and `merge-ai-prs.mjs` injected the
 *  weak one here — silently dropping the `input` that carries the merged text to `hash-object --stdin`. */
export { gitRunner };

/**
 * Rebuild a lane PR's tip onto `<base>`, auto-resolving every conflicting NON-manifest path via a safe
 * non-overlapping 3-way content merge (dropping the manifest too, if it also conflicts). Does NOT merge (the
 * caller does) — mirrors `rebaseDropManifest`'s contract exactly, one step wider. Returns one of:
 *   { action:'rebased', newCommit, mergedPaths, droppedManifest, base, laneRef } — pushed a resolved tip.
 *   { action:'skip',  reason, conflictPaths }  — clean/manifest-only (nothing for THIS resolver to do — the
 *                                                caller should have already tried `rebaseDropManifest`), or a
 *                                                real (overlapping/unsafe) conflict found while planning.
 *   { action:'error', reason }                 — a plumbing step failed.
 *
 * @param {object} o
 * @param {string} o.laneRef
 * @param {string} [o.base='origin/main']
 * @param {string} [o.remote='origin']
 * @param {string} [o.readRef]
 * @param {boolean}[o.fetch=true]
 * @param {string} [o.manifest='.lane-manifest.json']
 * @param {string} [o.message]
 * @param {string} [o.tmpIndex]
 * @param {string} [o.cwd]           run every git invocation in THIS directory (a sibling clone), #2263-style.
 * @param {(cmd:string,args:string[],opts?:object)=>{status:number,stdout:string,stderr:string}} [o.run]
 */
export function rebaseDropContent({
  laneRef,
  base = 'origin/main',
  remote = 'origin',
  readRef,
  fetch = true,
  manifest = LANE_MANIFEST,
  message,
  tmpIndex = '.git/rebase-drop-content-index',
  cardRebaseSettings = loadCardRebaseSettings(),
  dryRun = false,
  cwd,
  run = gitRunner,
} = {}) {
  if (!laneRef) return { action: 'error', reason: 'no laneRef given' };
  const mergeRef = readRef || `${remote}/${laneRef}`;

  if (fetch) {
    const f = run('git', ['fetch', remote, laneRef], { cwd });
    if (f.status !== 0) return { action: 'error', reason: `fetch ${laneRef} failed (${firstLine(f.stderr)})` };
  }

  const mt = run('git', ['merge-tree', '--write-tree', base, mergeRef], { cwd });
  let parsed = parseMergeTree(mt.stdout, mt.status);
  if (!parsed.tree) {
    const firstErr = firstLine(mt.stderr);
    // #x8pcbf3 (live incident, PR #2752) — FIX AND RETRY, not a bare error: see `we:scripts/lib/rebase-drop-
    // manifest.mjs#rebaseDropManifest`'s own copy of this comment (the SAME live incident, the SAME plumbing
    // shape) and `we:scripts/lib/git-run.mjs#ensureFullHistory`'s own header for the full story and evidence.
    if (/unrelated histories/i.test(firstErr)) {
      const history = ensureFullHistory(run, { cwd, remote });
      if (history.ok && history.unshallowed) {
        const retryMt = run('git', ['merge-tree', '--write-tree', base, mergeRef], { cwd });
        const retryParsed = parseMergeTree(retryMt.stdout, retryMt.status);
        if (retryParsed.tree) {
          parsed = retryParsed;
        } else {
          const retryErr = firstLine(retryMt.stderr);
          return {
            action: 'error',
            reason: `merge-tree produced no tree (${retryErr}) — checkout was shallow, was unshallowed, and the merge STILL failed; `
              + 'this looks like a genuinely unrelated-history pair, not a checkout defect',
          };
        }
      } else {
        const why = history.ok ? 'checkout is not shallow' : `checkout is shallow and could not be unshallowed (${history.reason})`;
        return { action: 'error', reason: `merge-tree produced no tree (${firstErr}) — ${why}` };
      }
    } else {
      return { action: 'error', reason: `merge-tree produced no tree (${firstErr})` };
    }
  }
  if (parsed.clean || parsed.conflictPaths.length === 0) {
    return { action: 'skip', reason: 'no conflict — not a content-rebase-drop candidate', conflictPaths: [] };
  }

  const nonManifest = parsed.conflictPaths.filter((p) => p !== manifest);
  if (nonManifest.length === 0) {
    return { action: 'skip', reason: 'manifest-only conflict — use rebaseDropManifest', conflictPaths: parsed.conflictPaths };
  }

  const stages = parseConflictStages(mt.stdout, mt.status);
  // Read blob content as RAW bytes (encoding:'buffer') — never utf8-decoded at the git boundary — so
  // `decodeBlobTextStrict` (in planContentMerges) can reject NUL-free non-UTF-8 blobs instead of corrupting them.
  const readBlob = (oid) => {
    const cat = run('git', ['cat-file', '-p', oid], { cwd, encoding: 'buffer' });
    return cat.status === 0 ? cat.stdout : null;
  };
  const plan = planContentMerges(nonManifest, stages, readBlob);
  if (!plan.ok) {
    return { action: 'skip', reason: `overlapping/unsafe conflict in ${plan.path} (${plan.reason})`, conflictPaths: parsed.conflictPaths };
  }

  // Build the resolved tree in a TEMP index — never touches HEAD or the working tree (mirrors rebase-drop-manifest).
  const env = { GIT_INDEX_FILE: tmpIndex };
  const read = run('git', ['read-tree', parsed.tree], { env, cwd });
  if (read.status !== 0) return { action: 'error', reason: `read-tree failed (${firstLine(read.stderr)})` };
  const droppedManifest = parsed.conflictPaths.includes(manifest);
  if (droppedManifest) run('git', ['rm', '--cached', '--ignore-unmatch', manifest], { env, cwd });
  // #2923 — the WRITE-BACK is where the merged text used to die. `git hash-object -w --stdin` exits 0 on an
  // EMPTY stdin and returns git's empty blob, so a `status !== 0` check cannot tell "wrote 6788 bytes" from
  // "wrote nothing". `hashObjectVerified` compares git's answer against the object id computed in-process from
  // the very string the merge produced, so the write is proven, not assumed.
  const stagedOids = new Map();
  for (const [path, text] of Object.entries(plan.merges)) {
    const written = hashObjectVerified(run, text, { env, cwd, label: path });
    if (!written.ok) return { action: 'error', reason: written.reason };
    const up = run('git', ['update-index', '--cacheinfo', `100644,${written.oid},${path}`], { env, cwd });
    if (up.status !== 0) return { action: 'error', reason: `update-index ${path} failed (${firstLine(up.stderr)})` };
    stagedOids.set(path, written.oid);
  }
  const wt = run('git', ['write-tree'], { env, cwd });
  const resolvedTree = String(wt.stdout || '').trim();
  if (wt.status !== 0 || !resolvedTree) return { action: 'error', reason: `write-tree failed (${firstLine(wt.stderr)})` };

  // #2923 — and prove the TREE we are about to commit really carries those blobs. This closes the rest of the
  // path: an `update-index` that did not take, a staged path that differs from the written one, a temp index
  // resolved in the wrong `cwd`. ABORT (never commit, never push) on any mismatch — the lane is left for
  // `/finish`, exactly as an unsafe conflict would be. "Auto-resolved" may only be reported once verified.
  for (const [path, oid] of stagedOids) {
    const v = verifyTreeBlob(run, resolvedTree, path, oid, { cwd });
    if (!v.ok) return { action: 'error', reason: `write-back verification failed: ${v.reason}` };
  }

  const cardRebaseSetting = { value: cardRebaseSettings.value.squashToSingleCommit, source: cardRebaseSettings.sources.squashToSingleCommit };
  const squash = cardRebaseSetting.value && cardTreeOnly({ run, cwd, base, tree: resolvedTree });
  if (squash) {
    const pinned = pinCardInputs({ run, cwd, base, mergeRef });
    if (!pinned) return { action: 'error', reason: 'cannot pin card squash inputs' };
    if (base !== pinned[0] || mergeRef !== pinned[1]) return rebaseDropContent({ laneRef, base: pinned[0], readRef: pinned[1],
      remote, fetch: false, manifest, tmpIndex, cardRebaseSettings, dryRun, cwd, run,
      message: message || `drain: rebase ${laneRef} onto ${base}, auto-resolve non-overlapping content conflict(s) in ${Object.keys(plan.merges).join(', ')}${droppedManifest ? `, drop transient ${manifest}` : ''}` });
  }
  const mergedPaths = Object.keys(plan.merges);
  const msg = message || `drain: rebase ${laneRef} onto ${base}, auto-resolve non-overlapping content conflict(s) in ${mergedPaths.join(', ')}${droppedManifest ? `, drop transient ${manifest}` : ''}`;
  const built = squash ? cardSquashRebuild({ run, cwd, base, mergeRef, tree: resolvedTree, message: msg }) : null;
  if (built?.action === 'error') return built;
  const ct = built ? { status: 0, stdout: built.newCommit } : run('git', ['commit-tree', resolvedTree, '-p', base, '-p', mergeRef, '-m', msg], { cwd });
  const newCommit = String(ct.stdout || '').trim();
  if (ct.status !== 0 || !newCommit) return { action: 'error', reason: `commit-tree failed (${firstLine(ct.stderr)})` };

  if (dryRun) return { action: 'dry-run', newCommit, oldHead: mergeRef, base, laneRef, proof: built?.proof,
    wouldPush: squash ? 'lease' : 'fast-forward', cardRebaseSetting };

  // #4293 — refuse this mechanical push too if another fixer holds the LIVE fix claim on the PR this laneRef
  // belongs to (see `refuseHeldPush`'s own header for why the check lives here, not at each caller).
  const refusal = refuseHeldPush({ run, cwd, remote, branch: laneRef });
  if (refusal) return { action: 'error', reason: refusal.message };

  const push = run('git', ['push', ...(squash ? [`--force-with-lease=refs/heads/${laneRef}:${mergeRef}`] : []), remote, `${newCommit}:refs/heads/${laneRef}`], { cwd });
  if (push.status !== 0) return { action: 'error', reason: `push to ${laneRef} failed (${firstLine(push.stderr)})` };

  return { action: 'rebased', newCommit, cardRebaseSetting, ...(built ? { proof: built.proof } : {}), mergedPaths, droppedManifest, base, laneRef };
}
