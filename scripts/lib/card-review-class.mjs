/**
 * The `card` review class (operator OK 2026-10-21 ~14:00 ET, prototype). A PR earns it only when its pinned net
 * diff is PROVABLY plain card text:
 *   - every listed path, and every path any `diff --git` header names, is a backlog card (`isCardPath`, the one
 *     card-only definition) and the two sets agree; no rename or copy;
 *   - every touched `backlog/<card>.md` has its frontmatter read on each side that exists (git-read at the pinned
 *     base and head by the io shell, else rebuilt from a diff that shows it in full), parsed as YAML, with `kind`
 *     on the ALLOWLIST below and no ratification key (`codifiedIn`, `ratified`, any case);
 *   - a loose scan of the whole diff finds no decision or ratification marker at all (belt and braces: a
 *     disagreement between the git read and the diff can only make the PR `full`).
 * Anything else is `full`, i.e. today's routing. FAIL-CLOSED throughout. PURE.
 *
 * What the class buys (and nothing more): the panel-seat red team is not owed on the head
 * (`redTeamPanelSeatOwed`), and a `COVERAGE` finding (test-plan coverage in card text) from the card-only
 * correctness seat becomes a card suggestion instead of a blocking referral (`review-pr` reduce). Contradictions,
 * missing decisions and every other finding class still block; an operator `block` ruling still promotes it back.
 */
import yaml from 'js-yaml';
import { isCardOnlyDiff, isCardPath } from '../ci-card-only.mjs';

export const CARD_REVIEW_CLASS = Object.freeze({ CARD: 'card', FULL: 'full' });

/** Card kinds the light class may cover. `decision` (and anything unknown) is never on it. */
export const CARD_CLASS_KINDS = Object.freeze(['story', 'task', 'epic', 'investigation', 'feature']);

const RAISED_BY = /^backlog\/raised-by\//;
const RATIFICATION_KEYS = new Set(['codifiedin', 'ratified']);
/** Any hint of a decision or ratification anywhere in the diff text. Over-matching only costs a full review. */
const LOOSE_MARKER = /codified|ratif|(?:kind|type)\W{0,8}\s*(?:!!\w+\s*)?[>|]?[-+]?\s*["']?\s*decision/i;

/** Every path a `diff --git` header (and any rename/copy line) names. Card body lines never start at column 0. */
function headerPaths(diffText) {
  const paths = new Set();
  for (const m of diffText.matchAll(/^diff --git a\/(\S+) b\/(\S+)\s*$/gm)) { paths.add(m[1]); paths.add(m[2]); }
  for (const m of diffText.matchAll(/^(?:rename|copy) (?:from|to) (.+)$/gm)) paths.add(`rename:${m[1]}`);
  return paths;
}

function diffBlocks(diffText) {
  const blocks = new Map();
  for (const part of diffText.split(/^(?=diff --git )/m)) {
    const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(part);
    if (m) blocks.set(m[2], part);
  }
  return blocks;
}

/**
 * Both sides' frontmatter TEXT rebuilt from one card's diff block, or `null` when the diff does not show it in
 * full. Only the first hunk can hold it, and only when it starts at line 1 on each side that exists. The
 * delimiter must be exactly `---` (a `---` indented inside a block scalar is content).
 */
function diffFrontmatter(block) {
  const lines = block.replace(/\r/g, '').split('\n');
  const h = lines.findIndex((l) => l.startsWith('@@ '));
  if (h < 0) return null;
  const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[h]);
  if (!hm) return null;
  const exists = { old: (hm[2] === undefined ? 1 : Number(hm[2])) > 0, new: (hm[4] === undefined ? 1 : Number(hm[4])) > 0 };
  if ((exists.old && Number(hm[1]) !== 1) || (exists.new && Number(hm[3]) !== 1)) return null;
  const seen = { old: [], new: [] };
  const closed = { old: !exists.old, new: !exists.new };
  for (let i = h + 1; i < lines.length && !lines[i].startsWith('@@ ') && !(closed.old && closed.new); i++) {
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

/** Is one side's frontmatter text plain card metadata? Parsed as YAML; any parse doubt is `false`. */
function plainCardSide(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  let doc;
  try { doc = yaml.load(text, { schema: yaml.FAILSAFE_SCHEMA }); } catch { return false; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
  for (const key of Object.keys(doc)) if (RATIFICATION_KEYS.has(String(key).trim().toLowerCase())) return false;
  const kinds = Object.keys(doc).filter((k) => ['kind', 'type'].includes(String(k).trim().toLowerCase())).map((k) => doc[k]);
  if (!kinds.length) return false;
  return kinds.every((v) => typeof v === 'string' && CARD_CLASS_KINDS.includes(v.trim().toLowerCase()));
}

/**
 * @param {object} read - the review-pr `read` finding (`netChangedFiles`, `netRenameSources`, `diffText`, `netBasis`,
 *   optional `cardFrontmatter: {path: {old: string|null, new: string|null}}` from the io shell).
 * @returns {{class: 'card'|'full', reason: string}}
 */
export function cardReviewClass(read) {
  const full = (reason) => ({ class: CARD_REVIEW_CLASS.FULL, reason });
  if (!read || read.degraded === true) return full('degraded or missing read');
  if (!/^[a-f0-9]{40}$/i.test(read.netBasis?.rev ?? '')) return full('net basis is not pinned');
  const files = Array.isArray(read.netChangedFiles) ? read.netChangedFiles : null;
  const renames = read.netRenameSources == null ? [] : read.netRenameSources;
  if (!files?.length || !Array.isArray(renames) || renames.length) return full('no net file list, or a rename/copy');
  if (!isCardOnlyDiff(files)) return full('touches a non-card path');
  const diffText = String(read.diffText ?? '');
  if (!diffText.trim()) return full('empty diff');
  const headers = headerPaths(diffText);
  const listed = new Set(files);
  for (const p of headers) if (!listed.has(p) || !isCardPath(p)) return full(`diff names a path outside the card list (${String(p).slice(0, 60)})`);
  if (LOOSE_MARKER.test(diffText)) return full('the diff mentions a decision or ratification marker');
  const blocks = diffBlocks(diffText);
  for (const path of files) {
    const block = blocks.get(path);
    if (!block) return full(`${path}: no diff block`);
    if (RAISED_BY.test(path)) continue;
    const git = read.cardFrontmatter?.[path];
    const sides = git && typeof git === 'object' && 'old' in git && 'new' in git ? git : diffFrontmatter(block);
    if (!sides || (sides.old == null && sides.new == null)) return full(`${path}: frontmatter not read on both sides`);
    for (const side of ['old', 'new']) {
      if (sides[side] == null) continue;
      if (!plainCardSide(sides[side])) return full(`${path}: ${side} side is not a plain ${CARD_CLASS_KINDS.join('/')} card`);
      if (LOOSE_MARKER.test(sides[side])) return full(`${path}: ${side} side mentions a decision or ratification marker`);
    }
  }
  return { class: CARD_REVIEW_CLASS.CARD, reason: `card-only: ${files.length} plain card file(s)` };
}

/** A finding the card class sends to card suggestions: test-plan coverage in card text. PURE. */
export function isCardCoverageFinding(finding) {
  return /^COVERAGE\b/i.test(String(finding?.category ?? '').trim());
}
