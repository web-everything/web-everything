/**
 * The `card` review class (operator OK 2026-10-21 ~14:00 ET, prototype). A PR earns it only when its pinned net
 * diff is PROVABLY card text: every path is a backlog card (`isCardOnlyDiff`, the one card-only definition), and
 * every touched `backlog/<card>.md` shows its WHOLE frontmatter on both sides of the diff, neither side of which
 * is a decision card (`kind: decision`) or a ratified rule (`codifiedIn:` / `ratified:`). Anything else is `full`,
 * i.e. today's routing. FAIL-CLOSED: a degraded or unpinned read, an empty diff, a file with no diff block, or a
 * frontmatter the diff does not show in full is `full`, never `card`. PURE.
 *
 * What the class buys (and nothing more): the panel-seat red team is not owed on the head
 * (`redTeamPanelSeatOwed`), and a `COVERAGE` finding (test-plan coverage in card text) from the card-only
 * correctness seat becomes a card suggestion instead of a blocking referral (`review-pr` reduce). Contradictions,
 * missing decisions and every other finding class still block; an operator `block` ruling still promotes it back.
 */
import { isCardOnlyDiff } from '../ci-card-only.mjs';

export const CARD_REVIEW_CLASS = Object.freeze({ CARD: 'card', FULL: 'full' });

const RAISED_BY = /^backlog\/raised-by\//;
// Cards say `kind: decision` (the backlog schema); `type:` is accepted too, fail-closed.
const SENSITIVE_KEY = /^((?:kind|type):\s*["']?decision\b|codifiedIn:|ratified:)/;

/** Split a unified diff into `{path -> block text}`, keyed by the `b/` path (or `a/` for a deletion). */
function diffBlocks(diffText) {
  const blocks = new Map();
  const parts = String(diffText).split(/^(?=diff --git )/m);
  for (const part of parts) {
    const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(part);
    if (!m) continue;
    const deleted = /^\+\+\+ \/dev\/null$/m.test(part);
    blocks.set(deleted ? m[1] : m[2], part);
  }
  return blocks;
}

/**
 * Both sides' frontmatter of one card's diff block, or `null` when the diff does not show it in full. Only the
 * FIRST hunk can hold it, and only when it starts at line 1 on each side that exists (an added file has no old
 * side, a deleted one no new side). The frontmatter is `---` on line 1 through the next `---`.
 */
function frontmatterSides(block) {
  const lines = block.split('\n');
  const h = lines.findIndex((l) => l.startsWith('@@ '));
  if (h < 0) return null;
  const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[h]);
  if (!hm) return null;
  const oldLen = hm[2] === undefined ? 1 : Number(hm[2]);
  const newLen = hm[4] === undefined ? 1 : Number(hm[4]);
  const oldExists = oldLen > 0; const newExists = newLen > 0;
  if ((oldExists && Number(hm[1]) !== 1) || (newExists && Number(hm[3]) !== 1)) return null;
  const sides = { old: oldExists ? [] : null, new: newExists ? [] : null };
  const closed = { old: !oldExists, new: !newExists };
  for (let i = h + 1; i < lines.length && !lines[i].startsWith('@@ ') && !(closed.old && closed.new); i++) {
    const l = lines[i];
    const mark = l[0];
    if (mark === '\\') continue;
    const text = l.slice(1);
    for (const side of mark === ' ' ? ['old', 'new'] : mark === '-' ? ['old'] : mark === '+' ? ['new'] : []) {
      if (closed[side]) continue;
      const seen = sides[side];
      if (seen.length === 0 && text !== '---') return null; // no frontmatter at line 1: not provably a plain card
      if (seen.length > 0 && text === '---') { closed[side] = true; continue; }
      seen.push(text);
    }
  }
  return closed.old && closed.new ? sides : null;
}

/** A git-read `{old, new}` entry as sides, or `null` when malformed or both sides are absent. */
function gitSides(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const ok = (s) => s === null || (Array.isArray(s) && s.every((l) => typeof l === 'string'));
  if (!ok(entry.old) || !ok(entry.new) || (entry.old === null && entry.new === null)) return null;
  // A side with no frontmatter at all ([]) is not provably a plain card.
  if ((entry.old && entry.old.length === 0) || (entry.new && entry.new.length === 0)) return null;
  return { old: entry.old, new: entry.new };
}

/**
 * @param {object} read - the review-pr `read` finding (`netChangedFiles`, `netRenameSources`, `diffText`, `netBasis`).
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
  const blocks = diffBlocks(diffText);
  for (const path of files) {
    if (RAISED_BY.test(path)) { if (!blocks.has(path)) return full(`${path}: no diff block`); continue; }
    const block = blocks.get(path);
    if (!block) return full(`${path}: no diff block`);
    // Prefer the git-read frontmatter (the io shell reads both sides at the pinned base and head); fall back to
    // what the diff itself shows. A side the git read found absent must match the diff (added/deleted file).
    const git = read.cardFrontmatter?.[path];
    const sides = gitSides(git) ?? frontmatterSides(block);
    if (!sides) return full(`${path}: frontmatter not fully shown in the diff`);
    const hit = [...(sides.old ?? []), ...(sides.new ?? [])].find((l) => SENSITIVE_KEY.test(l.trim()));
    if (hit) return full(`${path}: decision or ratified card (${hit.trim().slice(0, 40)})`);
  }
  return { class: CARD_REVIEW_CLASS.CARD, reason: `card-only: ${files.length} card file(s), no decision or ratified card` };
}

/** A finding the card class sends to card suggestions: test-plan coverage in card text. PURE. */
export function isCardCoverageFinding(finding) {
  return /^COVERAGE\b/i.test(String(finding?.category ?? '').trim());
}
