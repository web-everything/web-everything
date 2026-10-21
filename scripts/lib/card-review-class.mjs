/**
 * The `card` review class (operator OK 2026-10-21 ~14:00 ET, prototype). A PR earns it only when its pinned net
 * diff is PROVABLY plain card text. Every rule below is a `review.cardClass` setting (`resolveCardClassSettings`,
 * cascade standard → platform → tool → env); `settings.enabled: false` is the kill switch (every head `full`).
 *   - every listed path is a card (`isCardPath`, the one card-only definition) AND matches `cardPathPatterns`
 *     (settings can only narrow it); every `diff --git` / `---` / `+++` header names a listed path, unquoted;
 *     no rename, copy, mode change, binary patch, or block without a text hunk;
 *   - every touched `backlog/<card>.md` has its frontmatter proved on each side that exists — git-read at the
 *     pinned base and head by the io shell AND, where the diff shows it in full, rebuilt from the diff; EVERY
 *     available reading must pass (a disagreement can only make the PR `full`). A side is "absent" only when the
 *     diff says so (`--- /dev/null` + `new file mode`, or `+++ /dev/null` + `deleted file mode`);
 *   - each reading is parsed with js-yaml's DEFAULT schema (merge keys and escapes resolved, as the repo's parser
 *     reads them), must be a plain mapping with no `<<` merge, `kind`/`type` on the `kinds` allowlist and no
 *     `fullKeys` key (any case);
 *   - `fullMarker` matches nowhere in the diff or a frontmatter reading (over-matching only costs a full review);
 *   - raised-by pointer notes must be newly ADDED files with no frontmatter.
 * Anything else is `full`, i.e. today's routing. FAIL-CLOSED throughout. PURE.
 *
 * What the class buys: the red-team mode `settings.redTeam` for the head (`redTeamPanelSeatOwed`, review-job),
 * and `settings.coverageRoute` for test-plan COVERAGE from the correctness seat (`review-pr` reduce).
 */
import yaml from 'js-yaml';
import { isCardOnlyDiff, isCardPath } from '../ci-card-only.mjs';
import { CARD_CLASS_STANDARD, CARD_CLASS_VALID } from './review-seat-settings.mjs';

export const CARD_REVIEW_CLASS = Object.freeze({ CARD: 'card', FULL: 'full' });

const RAISED_BY = /^backlog\/raised-by\//;

/**
 * Settings with every invalid field replaced by the standard, and the exclusions FLOORED: `fullKeys` is the union
 * with the standard's, and the standard `fullMarker` always applies beside a configured one. So a setting can add
 * exclusions or narrow paths/kinds, never admit a ratified or decision card.
 */
function effective(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const e = Object.fromEntries(Object.entries(CARD_CLASS_STANDARD).map(([k, d]) => [k, CARD_CLASS_VALID[k](s[k]) ? s[k] : d]));
  e.fullKeys = [...new Set([...CARD_CLASS_STANDARD.fullKeys, ...e.fullKeys])];
  e.markers = [...new Set([CARD_CLASS_STANDARD.fullMarker, e.fullMarker])].map((m) => new RegExp(m, 'i'));
  return e;
}
const anyMarker = (markers, text) => markers.some((re) => re.test(text));

/** Split a unified diff into blocks, refusing (null) anything this predicate does not fully understand. */
function parseBlocks(diffText) {
  // Any CR or Unicode line separator is refused, not stripped: YAML treats a bare CR as a line break, so stripping
  // it could hide a field (`type: story #<CR>kind: decision`) from this predicate while the repo's parser sees it.
  if (/[\r\u0085\u2028\u2029]/.test(diffText)) return null;
  const text = diffText;
  if (!text.startsWith('diff --git ')) return null;
  const blocks = [];
  for (const part of text.split(/^(?=diff --git )/m)) {
    if (!part) continue;
    const m = /^diff --git a\/(\S+) b\/(\S+)\n/.exec(part);
    if (!m || m[1] !== m[2]) return null; // quoted, spaced, renamed or mismatched header
    const path = m[1];
    const lines = part.split('\n');
    const h = lines.findIndex((l) => l.startsWith('@@ '));
    if (h < 0) return null; // mode-only, binary or empty block
    const meta = lines.slice(1, h);
    let added = false; let deleted = false; let minus = null; let plus = null;
    if (new Set(meta).size !== meta.length) return null; // a repeated header line could shadow an earlier one
    for (const l of meta) {
      if (/^index [0-9a-f]+\.\.[0-9a-f]+(?: 100644)?$/.test(l)) continue;
      if (l === 'new file mode 100644') { added = true; continue; }
      if (l === 'deleted file mode 100644') { deleted = true; continue; }
      if (l.startsWith('--- ')) { if (minus !== null) return null; minus = l.slice(4); continue; }
      if (l.startsWith('+++ ')) { if (plus !== null) return null; plus = l.slice(4); continue; }
      return null; // old/new mode, similarity, rename/copy, binary, anything unknown
    }
    if (minus !== (added ? '/dev/null' : `a/${path}`) || plus !== (deleted ? '/dev/null' : `b/${path}`)) return null;
    if (added && deleted) return null;
    if (!hunksExact(lines.slice(h), { added, deleted })) return null;
    blocks.push({ path, added, deleted, lines: lines.slice(h) });
  }
  return blocks;
}

/**
 * EXACT hunk accounting: each `@@ -a,b +c,d @@` consumes exactly b old and d new lines (context counts on both);
 * after that only another hunk header, a `\ No newline` marker, or the block's final empty line may follow. So no
 * text (an appended `--- a/code` / `+++ b/code` patch included) can hide inside or between hunks.
 */
function hunksExact(lines, { added = false, deleted = false } = {}) {
  let i = 0; let hunks = 0;
  // Hunks must be in order and must not overlap on either side (an overlapping second hunk could restate lines the
  // first one already proved). An added file is exactly one `-0,0` hunk; a deleted one exactly one `+0,0` hunk.
  const end = { old: 0, new: 0 };
  while (i < lines.length) {
    const l = lines[i];
    if (l === '' && i === lines.length - 1) break;
    const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(l);
    if (!hm) return false;
    let o = hm[2] === undefined ? 1 : Number(hm[2]); let n = hm[4] === undefined ? 1 : Number(hm[4]);
    const a = Number(hm[1]); const c = Number(hm[3]);
    for (const [start, count, side] of [[a, o, 'old'], [c, n, 'new']]) {
      if (count > 0 ? start < 1 || start <= end[side] : start < end[side]) return false;
      end[side] = count > 0 ? start + count - 1 : start;
    }
    if ((added && (a !== 0 || o !== 0)) || (deleted && (c !== 0 || n !== 0)) || (!added && o === 0 && a === 0) || (!deleted && n === 0 && c === 0)) return false;
    hunks++;
    if ((added || deleted) && hunks > 1) return false;
    i++;
    while (o > 0 || n > 0) {
      const x = lines[i];
      if (x === undefined) return false;
      const mark = x[0];
      if (mark === ' ' && o > 0 && n > 0) { o--; n--; } else if (mark === '-' && o > 0) o--; else if (mark === '+' && n > 0) n--;
      else if (mark === '\\') { /* no-newline marker */ } else return false;
      i++;
    }
    while (lines[i] !== undefined && lines[i].startsWith('\\')) i++;
  }
  return hunks > 0;
}

/**
 * Both sides' frontmatter TEXT rebuilt from a block's first hunk, or `null` when the diff does not show it in
 * full. Side existence comes from the block header (added/deleted), never from the hunk counts.
 */
function diffFrontmatter({ added, deleted, lines }) {
  const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[0]);
  if (!hm) return null;
  const exists = { old: !added, new: !deleted };
  if ((exists.old && Number(hm[1]) !== 1) || (exists.new && Number(hm[3]) !== 1)) return null;
  const seen = { old: [], new: [] };
  const closed = { old: !exists.old, new: !exists.new };
  for (let i = 1; i < lines.length && !lines[i].startsWith('@@ ') && !(closed.old && closed.new); i++) {
    const mark = lines[i][0];
    if (mark === '\\') continue;
    const text = lines[i].slice(1);
    for (const side of mark === ' ' ? ['old', 'new'] : mark === '-' ? ['old'] : mark === '+' ? ['new'] : []) {
      if (closed[side]) continue;
      if (seen[side].length === 0) { if (text !== '---') return null; seen[side].push(text); continue; }
      if (text === '---') { closed[side] = true; continue; }
      seen[side].push(text);
    }
  }
  if (!(closed.old && closed.new)) return null;
  return { old: exists.old ? seen.old.slice(1).join('\n') : null, new: exists.new ? seen.new.slice(1).join('\n') : null };
}

/**
 * Every diff line that lands inside a side's git-read frontmatter region (`---`, its lines, `---`) must equal the
 * git line at that position — so a partial frontmatter hunk can never contradict the git reading.
 */
function gitMatchesDiff(git, { lines }) {
  const region = (t) => (typeof t === 'string' ? ['---', ...t.split('\n'), '---'] : []);
  const want = { old: region(git.old), new: region(git.new) };
  let o = 0; let n = 0;
  for (const l of lines) {
    const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (hm) { o = Number(hm[1]); n = Number(hm[2]); if (o === 0) o = 1; if (n === 0) n = 1; continue; }
    const mark = l[0]; const text = l.slice(1);
    if (mark === ' ' || mark === '-') { if (o <= want.old.length && want.old[o - 1] !== text) return false; o++; }
    if (mark === ' ' || mark === '+') { if (n <= want.new.length && want.new[n - 1] !== text) return false; n++; }
  }
  return true;
}

/** Is one frontmatter reading plain card metadata under `s`? Any parse doubt is `false`. */
function plainCardSide(text, s) {
  if (typeof text !== 'string' || !text.trim() || /[\r\u0085\u2028\u2029]/.test(text) || /<</.test(text) || anyMarker(s.markers, text)) return false;
  let doc;
  try { doc = yaml.load(text); } catch { return false; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
  const full = new Set(s.fullKeys.map((k) => k.trim().toLowerCase()));
  const keys = Object.keys(doc).map((k) => String(k).trim().toLowerCase());
  if (keys.some((k) => full.has(k) || k === '<<')) return false;
  if (anyMarker(s.markers, JSON.stringify(doc))) return false; // after escapes and merges are resolved
  const kinds = Object.keys(doc).filter((k) => ['kind', 'type'].includes(String(k).trim().toLowerCase())).map((k) => doc[k]);
  const allowed = s.kinds.map((k) => k.trim().toLowerCase());
  return kinds.length > 0 && kinds.every((v) => typeof v === 'string' && allowed.includes(v.trim().toLowerCase()));
}

/**
 * @param {object} read - the review-pr `read` finding (`netChangedFiles`, `netRenameSources`, `diffText`, `netBasis`,
 *   optional `cardFrontmatter: {path: {old: string|null, new: string|null}}` from the io shell).
 * @param {object} [settings] - resolved `review.cardClass` (`resolveCardClassSettings().value`); standard when omitted.
 * @returns {{class: 'card'|'full', reason: string}}
 */
export function cardReviewClass(read, settings = CARD_CLASS_STANDARD) {
  const full = (reason) => ({ class: CARD_REVIEW_CLASS.FULL, reason });
  const s = effective(settings);
  if (s.enabled !== true) return full('review.cardClass.enabled is off');
  if (!read || read.degraded === true) return full('degraded or missing read');
  if (!/^[a-f0-9]{40}$/i.test(read.netBasis?.rev ?? '')) return full('net basis is not pinned');
  const files = Array.isArray(read.netChangedFiles) ? read.netChangedFiles : null;
  const renames = read.netRenameSources == null ? [] : read.netRenameSources;
  if (!files?.length || !Array.isArray(renames) || renames.length) return full('no net file list, or a rename/copy');
  if (!isCardOnlyDiff(files)) return full('touches a non-card path');
  const patterns = s.cardPathPatterns.map((p) => new RegExp(p));
  const off = files.find((f) => !isCardPath(f) || !patterns.some((re) => re.test(f)));
  if (off) return full(`${off}: not on review.cardClass.cardPathPatterns`);
  const diffText = String(read.diffText ?? '');
  if (!diffText.trim()) return full('empty diff');
  if (anyMarker(s.markers, diffText)) return full('the diff matches review.cardClass.fullMarker');
  const blocks = parseBlocks(diffText);
  if (!blocks) return full('the diff has a header, mode, rename or binary block the card class does not accept');
  const byPath = new Map(blocks.map((b) => [b.path, b]));
  if (byPath.size !== blocks.length || blocks.length !== new Set(files).size || files.some((f) => !byPath.has(f))) {
    return full('the diff blocks and the net file list disagree');
  }
  for (const path of files) {
    const block = byPath.get(path);
    if (RAISED_BY.test(path)) {
      // A pointer note is new bullet text only: every added line is `- …` or empty, so nothing can parse as frontmatter.
      if (!block.added || !block.lines.slice(1).every((l, i, a) => (l === '' && i === a.length - 1) || /^\+(?:- .*)?$/.test(l) || l.startsWith('\\'))) {
        return full(`${path}: a raised-by note must be a new file of bullet lines`);
      }
      continue;
    }
    const readings = [];
    const fromDiff = diffFrontmatter(block);
    if (fromDiff) readings.push(fromDiff);
    const git = read.cardFrontmatter?.[path];
    if (git !== undefined) {
      if (!git || typeof git !== 'object' || !('old' in git) || !('new' in git)) return full(`${path}: malformed git-read frontmatter`);
      if ((git.old === null) !== block.added || (git.new === null) !== block.deleted) return full(`${path}: git read and diff disagree on which sides exist`);
      if (!gitMatchesDiff(git, block)) return full(`${path}: git-read frontmatter disagrees with the diff`);
      readings.push(git);
    }
    if (!readings.length) return full(`${path}: frontmatter not proved on both sides`);
    for (const r of readings) {
      for (const side of ['old', 'new']) {
        const exists = side === 'old' ? !block.added : !block.deleted;
        if (!exists) { if (r[side] != null) return full(`${path}: ${side} side should be absent`); continue; }
        if (!plainCardSide(r[side], s)) return full(`${path}: ${side} side is not a plain ${s.kinds.join('/')} card`);
      }
    }
  }
  return { class: CARD_REVIEW_CLASS.CARD, reason: `card-only: ${files.length} plain card file(s)` };
}

/** A finding the card class routes by `coverageRoute`: test-plan coverage, the exact class. PURE. */
export function isCardCoverageFinding(finding) {
  return /^COVERAGE$/i.test(String(finding?.category ?? '').trim());
}
