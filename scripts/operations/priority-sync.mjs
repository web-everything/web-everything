import { isTerminalStatus } from '../lib/backlog-status.cjs';
/**
 * @file scripts/operations/priority-sync.mjs
 * @description THE `priority-sync` DECLARATION (epic #3383) — keep the maintained `## Priority order` section of
 *   the #3383 tracker card in step with the backlog, mechanically, instead of by hand in the same push as every
 *   card change.
 *
 * WHY IT EXISTS. The section is the ONE ordered list the orchestrator dispatches from, and until now a worker
 * edited it by hand whenever a #3383 card was filed, resolved, claimed or moved. `check-priority --strict` only
 * REPORTS drift. This operation FIXES the part of the drift that needs no judgment, and leaves the judgment (the
 * one-sentence "why", the tier, whether a landed card is really done) to a worker.
 *
 * ── THE THREE STEPS ────────────────────────────────────────────────────────────────────────────────────────
 *
 *   | step    | kind      | what it does                                                                        |
 *   |---------|-----------|-------------------------------------------------------------------------------------|
 *   | `read`  | `compute` | shape ONE injected `readFacts` call: the section text, the cards (origin/main merged with the branch's own), the ranker fields, and which cards a merged PR or commit on origin/main mentions |
 *   | `plan`  | `compute` | PURE: {@link planPrioritySync} — the planned change, never written by this step      |
 *   | `apply` | `effect`  | with `--apply` and a change to make: ONE effect that rewrites the section IN PLACE   |
 *
 * DRY RUN IS THE DEFAULT. Without `--apply` the `apply` step declares no effect and the run only prints the plan.
 * The operation NEVER commits and NEVER pushes: it edits the tracker card in the checkout it is run from and stops.
 *
 * ── WHAT THE PLANNER DOES (the rules, in the order the brief gives them) ────────────────────────────────────
 *
 *  1. DROP the line of a card that is not live (resolved on main or on the branch, or any other non-open status).
 *  2. ADD every open card in the live tree ({@link ../lib/priority-order.mjs liveTree}) that has no line. Band by the
 *     card's own fields ({@link bandOf}); order inside a band by the section's own rule 3 (dependencies via
 *     `blockedBy`, then leverage descending, then smaller size, then number); a card with `status: active` goes in
 *     the Claimed list; a card outside the tree goes in the Off-path list unless its line is `operator-added`.
 *  3. NEVER move or drop a line marked `pinned by operator`; never move a card out of the delegation section or
 *     drop its `operator-added` marker; NEVER insert a new card into the delegation section (its membership is the
 *     operator's).
 *  4. RENUMBER every ordered line (the list is numbered across sections) and rewrite the `Updated:` line.
 *  5. New lines carry {@link UNWRITTEN_WHY} instead of a reason. The operation writes no prose.
 *  6. FLAG, WITHOUT CHANGING, an open or active card that a merged PR or commit on origin/main mentions.
 *
 * ── THE SMALLEST READINGS (where the card and the section's rules do not settle it) ─────────────────────────
 *
 *  - Existing lines are never re-ranked. Their order encodes a tier (rule 0: P0 to P3, OFF) that only a person
 *    can judge, so a NEW line goes AFTER the last line of its band, ordered among the other new lines by rule 3.
 *    A worker who writes the "why" also places it.
 *  - The one exception is a dependency: a new card that blocks an existing line is placed just before that line
 *    (a blocker never sits below the card it blocks), and a new card never sits in an earlier band than its blocker.
 *  - A line whose card changed state is re-filed, keeping its prose: ordered -> Claimed when the card is now
 *    `active`, Claimed -> its band when the card is `open` again, either -> the Off-path list when the card is
 *    outside the live tree and the line is not `operator-added`. Lines in the delegation section or pinned lines
 *    are never re-filed; they are flagged instead.
 *  - A line for a card no source has, whose id is some card's `bornAs`, is renamed in place (a hash id that was
 *    JIT-numbered). Any other unknown id is flagged and left alone.
 *
 * PURE. No fs, no clock, no process, no network in this file (and it imports no io: its import graph reaches
 * nothing that can act, like `dispatch-lane.mjs`). It re-states the section's two entry-marker patterns from
 * `we:scripts/lib/priority-order.mjs` because that module carries the fs/git shell; a test pins the two parsers
 * to the same answer over the real tracker card.
 */

import { op } from './registry.mjs';
import { compute, effect as effectStep } from './step-kinds.mjs';
import { UNWRITTEN_WHY } from '../lib/priority-markers.mjs';

/** The operation's stable id. Adapters resolve it by this name. */
export const PRIORITY_SYNC_OP = 'priority-sync';

/** The effect type the `apply` step declares — the sink is registered under this string in `./priority-sync-io.mjs`. */
export const PRIORITY_SYNC_EFFECT = 'priority-sync.write-section';

export { UNWRITTEN_WHY };

const SECTION_HEADING = '## Priority order';
const ORDERED_RE = /^(\d+)\.\s+#([0-9a-z]+)\s+·\s/;
const CLAIMED_RE = /^-\s+#([0-9a-z]+)\s+·\s/;
const OFFPATH_RE = /^-\s+off-path\s+#([0-9a-z]+)\b/;
const BOLD_START_RE = /^\*\*([^*]+)\*\*(?:\s|$)/;
const MARKER_RE = /^(operator-added|pinned by operator)\b/;
const UPDATED_TAIL_RE = /\sDerived by the rules below\b/;
const BAND_RANK = Object.freeze({ A: 0, B: 1, C: 2 });
const BANDS = Object.freeze(['A', 'B', 'C']);

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The section, as lines.

/** Which block a bold-led line opens. */
function blockKind(title) {
  const t = String(title).trim();
  if (/^Health chain/i.test(t)) return 'health';
  if (/^Delegation/i.test(t)) return 'delegation';
  const band = /^Band ([ABC])\b/.exec(t);
  if (band) return band[1];
  if (/^Claimed/i.test(t)) return 'claimed';
  if (/^Off-path/i.test(t)) return 'offpath';
  if (/^Owed/i.test(t)) return 'owed';
  if (/^Rules/i.test(t)) return 'rules';
  return 'other';
}

/** Fields of an ordered or claimed entry line. `parts[0]` is `N. #id` or `- #id`, then size, band, markers, why. */
function entryFields(text) {
  const parts = text.split(' · ');
  let i = 3;
  const marks = [];
  while (i < parts.length && MARKER_RE.test(parts[i].trim())) { marks.push(parts[i].trim()); i += 1; }
  return { size: (parts[1] ?? '').trim(), band: (parts[2] ?? '').trim(), marks, why: parts.slice(i).join(' · ') };
}

function classifyLine(text, block) {
  const o = ORDERED_RE.exec(text);
  if (o) return { text, block, type: 'ordered', id: o[2], n: Number(o[1]), ...entryFields(text) };
  const c = CLAIMED_RE.exec(text);
  if (c) return { text, block, type: 'claimed', id: c[1], n: null, ...entryFields(text) };
  const p = OFFPATH_RE.exec(text);
  if (p) return { text, block, type: 'offpath', id: p[1], n: null, size: '', band: '', marks: [], why: '' };
  return { text, block, type: 'text', id: null, n: null, size: '', band: '', marks: [], why: '' };
}

/**
 * Split the tracker card's text (or just the section's own text, heading first) into the section's lines,
 * each tagged with the block it sits in. PURE.
 *
 * A block opens at a line that STARTS with a bold phrase (`**Band A — …**`, `**Claimed …**`, `**Off-path …**`),
 * with or without prose after the phrase, and runs to the next such line or the end of the section.
 *
 * @param {string} text
 * @returns {{found: boolean, head: string[], lines: object[], tail: string[]}}
 */
export function parseSection(text) {
  const all = String(text ?? '').split('\n');
  const start = all.findIndex((l) => l.trimEnd() === SECTION_HEADING);
  if (start === -1) return { found: false, head: [], lines: [], tail: [] };
  let end = all.length;
  for (let i = start + 1; i < all.length; i++) if (/^## /.test(all[i])) { end = i; break; }
  let block = 'preamble';
  const lines = [];
  for (let i = start + 1; i < end; i++) {
    const bold = BOLD_START_RE.exec(all[i]);
    if (bold) block = blockKind(bold[1]);
    lines.push(classifyLine(all[i], block));
  }
  return { found: true, head: all.slice(0, start + 1), lines, tail: all.slice(end) };
}

/** The section's own text (heading line through the line before the next `## `), for the io to hand back. PURE. */
export function extractSectionText(trackerText) {
  const all = String(trackerText ?? '').split('\n');
  const start = all.findIndex((l) => l.trimEnd() === SECTION_HEADING);
  if (start === -1) return null;
  let end = all.length;
  for (let i = start + 1; i < all.length; i++) if (/^## /.test(all[i])) { end = i; break; }
  return all.slice(start, end).join('\n');
}

/** Replace the section inside the whole tracker text with `newSection` (same extent rule). PURE. */
export function replaceSectionText(trackerText, newSection) {
  const all = String(trackerText ?? '').split('\n');
  const start = all.findIndex((l) => l.trimEnd() === SECTION_HEADING);
  if (start === -1) return null;
  let end = all.length;
  for (let i = start + 1; i < all.length; i++) if (/^## /.test(all[i])) { end = i; break; }
  return [...all.slice(0, start), ...String(newSection).split('\n'), ...all.slice(end)].join('\n');
}

/** Every card id the section names on an entry line (ordered, claimed, off-path). PURE. */
export function sectionEntryIds(sectionText) {
  const sec = parseSection(sectionText);
  return sec.found ? sec.lines.filter((l) => l.id).map((l) => l.id) : [];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Card facts.

/**
 * THE BAND of a card from its own fields. PURE.
 *
 *   C — a decision (prepared or not), or a card the loader marks human-gated (a residual only a person can do).
 *   B — an epic, or a card whose body states a DESIGN TO SETTLE or carries an open-fork heading.
 *   A — everything else.
 *
 * The loader's `tier` is used where it is decisive (`B` is its word for an open decision). Its `A`/`C` are NOT
 * the section's bands: a blocked build is loader tier C but section band A (rule 1 sends it to the end of the band).
 *
 * @param {{kind?: string, tier?: string, humanGated?: boolean, designFirst?: boolean}} card
 * @returns {'A'|'B'|'C'}
 */
export function bandOf(card) {
  if (card.kind === 'decision' || card.tier === 'B') return 'C';
  if (card.humanGated) return 'C';
  if (card.kind === 'epic' || card.designFirst) return 'B';
  return 'A';
}

/** The size word a line carries: story points, `task`, `epic` or `decision`. */
export function sizeLabel(card) {
  if (card.kind === 'epic') return 'epic';
  if (card.kind === 'decision') return 'decision';
  if (card.kind === 'task') return 'task';
  return card.size != null && String(card.size) !== '' ? String(card.size) : '?';
}

/** Rule 3's size order: task, then story points ascending, then epic or decision. */
function sizeRank(card) {
  if (card.kind === 'task') return 0;
  if (card.kind === 'epic' || card.kind === 'decision') return 1000;
  const n = Number(card.size);
  return Number.isFinite(n) ? n : 999;
}

const numKey = (id) => (/^\d+$/.test(id) ? Number(id) : Number.POSITIVE_INFINITY);

/** Rule 1: a card whose blocker is claimed, or is open outside this epic, goes to the end of its band. */
function blockerOutside(card, cards, live) {
  return (card.blockedBy ?? []).some((b) => {
    const bc = cards.get(b);
    return bc && !isTerminalStatus(bc.status) && (bc.status === 'active' || !live.has(b));
  });
}

/** Rule 3 order of two NEW cards: blocked-outside last, leverage descending, smaller size, then number. */
function compareNew(a, b, cards, live) {
  const bl = Number(blockerOutside(a, cards, live)) - Number(blockerOutside(b, cards, live));
  if (bl) return bl;
  const lev = (b.leverage ?? 0) - (a.leverage ?? 0);
  if (lev) return lev;
  const sz = sizeRank(a) - sizeRank(b);
  if (sz) return sz;
  const ka = numKey(a.id);
  const kb = numKey(b.id);
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Order a set of inserts (each `{card, …}`): rule 3, with every card after those of the set that block it. */
function orderNewCards(items, cards, live) {
  const rest = [...items].sort((a, b) => compareNew(a.card, b.card, cards, live));
  const ids = new Set(items.map((i) => i.card.id));
  const out = [];
  while (rest.length) {
    const i = rest.findIndex((x) => (x.card.blockedBy ?? []).every((b) => !ids.has(b) || out.some((o) => o.card.id === b)));
    out.push(...rest.splice(i < 0 ? 0 : i, 1));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The planner.

const newOrderedText = (card, band) => `0. #${card.id} · ${sizeLabel(card)} · ${band} · ${UNWRITTEN_WHY}`;
const newClaimedText = (card) => `- #${card.id} · ${sizeLabel(card)} · claimed · ${UNWRITTEN_WHY}`;
const offPathText = (card, size, why) => `- off-path #${card.id} · ${size || sizeLabel(card)} · ${card.parent ? `parent #${card.parent}` : 'no parent'}: ${why || UNWRITTEN_WHY}`;

/** Rewrite an existing ordered/claimed line into a line of another type, keeping its markers and prose. */
function refiled(line, card, to, band) {
  const tail = [...line.marks, line.why || UNWRITTEN_WHY].join(' · ');
  if (to === 'claimed') return `- #${line.id} · ${line.size || sizeLabel(card)} · claimed · ${tail}`;
  return `0. #${line.id} · ${line.size || sizeLabel(card)} · ${band} · ${tail}`;
}

/**
 * THE PLAN. PURE: text and card facts in, the planned section out; nothing is written.
 *
 * @param {object} read - the `read` finding: `{sectionText, cards, live, landed, today}` (see {@link shapePriorityRead}).
 * @returns {object} `{found, changed, counts, added, dropped, moved, renamed, flagged, renumbered, updated, newSection}`
 */
export function planPrioritySync(read) {
  const r = read || {};
  const sec = parseSection(r.sectionText);
  if (!sec.found) throw new Error(`priority-sync.plan: the tracker card has no "${SECTION_HEADING}" section`);

  const cards = new Map((r.cards ?? []).map((c) => [c.id, c]));
  const bornAs = new Map((r.cards ?? []).filter((c) => c.bornAs).map((c) => [c.bornAs, c]));
  const live = new Set(r.live ?? []);
  const isLive = (c) => c && (c.status === 'open' || c.status === 'active');

  const added = [];
  const dropped = [];
  const moved = [];
  const renamed = [];
  const flagged = [];
  const flag = (kind, id, message, extra = {}) => flagged.push({ kind, id, message, ...extra });

  /** Lines to place: new cards, and existing lines re-filed. `keepText` is set for a re-filed line. */
  const inserts = [];
  const lines = sec.lines.map((l) => ({ ...l, drop: false }));

  for (const line of lines) {
    if (line.type === 'text') continue;
    let card = cards.get(line.id);
    if (!card && bornAs.has(line.id)) {
      const to = bornAs.get(line.id);
      const re = line.type === 'ordered' ? new RegExp(`^(\\d+\\.\\s+)#${line.id}\\b`) : new RegExp(`^(-\\s+(?:off-path\\s+)?)#${line.id}\\b`);
      line.text = line.text.replace(re, `$1#${to.id}`);
      renamed.push({ from: line.id, to: to.id });
      line.id = to.id;
      card = to;
    }
    const pinned = line.marks.some((m) => m.startsWith('pinned by operator'));
    const inDelegation = line.block === 'delegation';
    const operatorAdded = line.marks.some((m) => m.startsWith('operator-added'));

    if (!card) { flag('unknown-line', line.id, `#${line.id} is not a card in any source read, and no card was born as it: left in place`); continue; }

    if (line.type === 'offpath') {
      if (!isLive(card)) { line.drop = true; dropped.push({ id: line.id, line: line.text, reason: `${card.status}, off-path list` }); }
      else if (live.has(line.id)) {
        line.drop = true;
        inserts.push({ card, origin: 'off-path', from: 'off-path' });
        moved.push({ id: line.id, from: 'off-path list', to: 'the live tree', reason: 'the card is now under #3383' });
      }
      continue;
    }

    if (!isLive(card)) {
      if (pinned) { flag('pinned-not-live', line.id, `#${line.id} is ${card.status} but its line is pinned by operator: left in place`); continue; }
      line.drop = true;
      dropped.push({ id: line.id, line: line.text, reason: card.status === 'resolved' ? 'resolved' : `status ${card.status}` });
      continue;
    }
    if (pinned) continue;

    // A live card whose state no longer matches its line.
    if (!live.has(line.id) && !operatorAdded) {
      if (inDelegation) { flag('off-tree-in-delegation', line.id, `#${line.id} is outside the #3383 tree but sits in the delegation section: left in place`); continue; }
      line.drop = true;
      inserts.push({ card, origin: 'moved', to: 'offpath', text: offPathText(card, line.size, line.why) });
      moved.push({ id: line.id, from: `line ${line.type}`, to: 'off-path list', reason: 'the card is outside the live tree and the line is not operator-added' });
      continue;
    }
    if (card.status === 'active' && line.type === 'ordered') {
      if (inDelegation) { flag('claimed-in-delegation', line.id, `#${line.id} is claimed (status active) but sits in the delegation section: left in place`); continue; }
      line.drop = true;
      inserts.push({ card, origin: 'moved', to: 'claimed', text: refiled(line, card, 'claimed') });
      moved.push({ id: line.id, from: 'ordered list', to: 'claimed list', reason: 'the card is now active' });
      continue;
    }
    if (card.status === 'open' && line.type === 'claimed') {
      line.drop = true;
      const band = bandOf(card);
      inserts.push({ card, origin: 'moved', to: band, band, text: refiled(line, card, 'ordered', band) });
      moved.push({ id: line.id, from: 'claimed list', to: `band ${band}`, reason: 'the card is open again' });
    }
  }

  // ADD: every live-tree card without a line (after the passes above).
  const listed = new Set(lines.filter((l) => !l.drop && l.id).map((l) => l.id));
  for (const id of live) {
    if (listed.has(id) || inserts.some((i) => i.card.id === id)) continue;
    const card = cards.get(id);
    if (!isLive(card)) continue;
    inserts.push({ card, origin: 'new' });
  }

  // Bands of the new ordered cards: own band, never earlier than a blocker's.
  const lineBand = new Map();
  for (const l of lines) if (!l.drop && l.type === 'ordered' && BANDS.includes(l.block)) lineBand.set(l.id, l.block);
  const ordered = inserts.filter((i) => i.to !== 'claimed' && i.to !== 'offpath' && i.card.status !== 'active');
  const eff = new Map(ordered.map((i) => [i.card.id, i.band ?? bandOf(i.card)]));
  for (let pass = 0; pass < ordered.length + 1; pass++) {
    let changed = false;
    for (const i of ordered) {
      for (const b of i.card.blockedBy ?? []) {
        const bb = eff.get(b) ?? lineBand.get(b);
        if (bb && BAND_RANK[bb] > BAND_RANK[eff.get(i.card.id)]) { eff.set(i.card.id, bb); changed = true; }
      }
    }
    if (!changed) break;
  }

  // Place the ordered lines band by band, then the claimed and off-path ones.
  const out = [...lines.filter((l) => !l.drop)];
  const blockEnd = (block, type) => {
    let idx = -1;
    out.forEach((l, k) => { if (l.block === block && l.type === type) idx = k; });
    if (idx >= 0) return idx + 1;
    const head = out.findIndex((l) => l.block === block);
    return head >= 0 ? head + 1 : -1;
  };
  const place = (block, type, line, beforeIdx = null) => {
    let at = beforeIdx ?? blockEnd(block, type);
    if (at < 0) throw new Error(`priority-sync.plan: the section has no ${block} block to put #${line.id} in`);
    const noEntries = beforeIdx == null && !out.some((l) => l.block === block && l.type === type);
    if (noEntries) { out.splice(at, 0, { text: '', block, type: 'text', id: null, marks: [], why: '' }); at += 1; }
    out.splice(at, 0, line);
  };

  const orderedLine = (i, band) => {
    // A re-filed line keeps its prose but takes the band of the block it lands in.
    const text = i.text ? i.text.replace(/^(\d+\. #\S+ · [^·]+ · )[^·]+?( · )/, `$1${band}$2`) : newOrderedText(i.card, band);
    return { text, block: band, type: 'ordered', id: i.card.id, n: null, ...entryFields(text), isNew: true };
  };

  for (const band of BANDS) {
    const group = orderNewCards(ordered.filter((i) => eff.get(i.card.id) === band), cards, live);
    for (const i of group) {
      let beforeIdx = null;
      const blocked = out.findIndex((l) => l.type === 'ordered' && !l.isNew && (cards.get(l.id)?.blockedBy ?? []).includes(i.card.id));
      const end = blockEnd(band, 'ordered');
      if (blocked >= 0 && blocked < end) {
        const target = out[blocked];
        if (BANDS.includes(target.block)) { beforeIdx = blocked; }
        else flag('blocked-order', i.card.id, `#${i.card.id} blocks #${target.id}, which sits in the ${target.block} section; new cards are never inserted there, so the order is left for a person`);
      }
      const finalBand = beforeIdx != null ? out[beforeIdx].block : band;
      const line = orderedLine(i, finalBand);
      place(finalBand, 'ordered', line, beforeIdx);
      added.push({ id: i.card.id, band: finalBand, size: sizeLabel(i.card), line: line.text, origin: i.origin });
    }
  }
  for (const i of inserts.filter((x) => x.to === 'claimed' || (x.origin !== 'moved' && x.card.status === 'active'))) {
    const text = i.text ?? newClaimedText(i.card);
    place('claimed', 'claimed', { text, block: 'claimed', type: 'claimed', id: i.card.id, n: null, ...entryFields(text), isNew: true });
    if (i.origin !== 'moved') added.push({ id: i.card.id, band: 'claimed', size: sizeLabel(i.card), line: text, origin: i.origin });
  }
  for (const i of inserts.filter((x) => x.to === 'offpath')) {
    place('offpath', 'offpath', { text: i.text, block: 'offpath', type: 'offpath', id: i.card.id, n: null, marks: [], why: '', isNew: true });
  }

  // Renumber across the whole list.
  let n = 0;
  let renumbered = 0;
  for (const l of out) {
    if (l.type !== 'ordered') continue;
    n += 1;
    l.text = l.text.replace(/^\d+\./, `${n}.`);
    if (!l.isNew && l.n !== n) renumbered += 1;
    l.n = n;
  }

  // The added lines as they now read, with their final numbers.
  for (const a of added) {
    const placed = out.find((l) => l.isNew && l.id === a.id && (l.type === 'ordered' || l.type === 'claimed'));
    if (placed) a.line = placed.text;
  }

  // Order problems that remain (existing lines are never re-ranked, so a blocker below the card it blocks stays).
  const pos = new Map(out.filter((l) => l.type === 'ordered').map((l) => [l.id, l.n]));
  for (const [id, at] of pos) {
    for (const b of cards.get(id)?.blockedBy ?? []) {
      if (pos.has(b) && pos.get(b) > at) flag('blocked-order', id, `#${id} (${at}) is ordered before #${b} (${pos.get(b)}), which blocks it: existing lines are not re-ranked`);
    }
  }

  // Landed but still open: a merged PR or a commit on the ref names the card.
  const landedIds = [...new Set([...live, ...out.filter((l) => l.id).map((l) => l.id)])];
  for (const id of landedIds.sort()) {
    const hit = (r.landed ?? {})[id];
    const card = cards.get(id);
    if (hit && isLive(card)) {
      flag('landed-open', id, `#${id} landed but still open: resolve it (${hit.sha} ${hit.subject})`, { sha: hit.sha, subject: hit.subject });
    }
  }

  const changed = added.length + dropped.length + moved.length + renamed.length > 0;
  const counts = { added: added.length, dropped: dropped.length, moved: moved.length, renamed: renamed.length, flagged: flagged.length, renumbered };

  // The `Updated:` line, in place, only when something changed.
  let updated = null;
  if (changed) {
    const at = out.findIndex((l) => l.type === 'text' && l.text.startsWith('Updated:'));
    if (at >= 0) {
      const old = out[at].text;
      const tail = UPDATED_TAIL_RE.exec(old);
      const reason = `added ${counts.added}, dropped ${counts.dropped}, moved ${counts.moved}, flagged ${counts.flagged}, renumbered ${counts.renumbered}; new lines wait for a worker to write their why`;
      updated = `Updated: ${r.today} by delivery worker \`priority-sync\` — ${reason}.${tail ? old.slice(tail.index) : ''}`;
      out[at].text = updated;
    }
  }

  const newSection = [...sec.head.slice(-1), ...out.map((l) => l.text)].join('\n');
  return { found: true, changed, counts, added, dropped, moved, renamed, flagged, renumbered, updated, newSection };
}

/**
 * The plan as a readable diff. PURE. `applied` says the section was written; `asked` says the run had `--apply`
 * (so a no-change run does not read as a dry run).
 *
 * @param {object} plan
 * @param {{applied?: boolean, asked?: boolean, trackerPath?: string}} [o]
 * @returns {string[]}
 */
export function renderPlan(plan, { applied = false, asked = false, trackerPath = null } = {}) {
  if (!plan || !plan.found) return ['priority-sync: no plan'];
  const c = plan.counts;
  const out = [
    `priority-sync: ${applied ? 'APPLIED' : asked ? 'apply requested, nothing to write' : 'dry run'} — ${c.added} added, ${c.dropped} dropped, ${c.moved} moved, ${c.renamed} renamed, ${c.flagged} flagged; ${c.renumbered} existing lines renumbered`,
  ];
  for (const a of plan.added) out.push(`+ ${a.line}   [${a.origin === 'off-path' ? 'was off-path' : 'no line'}; band ${a.band}]`);
  for (const d of plan.dropped) out.push(`- ${d.line}   [${d.reason}]`);
  for (const m of plan.moved) out.push(`~ #${m.id}: ${m.from} -> ${m.to}   [${m.reason}]`);
  for (const rn of plan.renamed) out.push(`~ #${rn.from} -> #${rn.to}   [renamed: JIT-numbered]`);
  for (const f of plan.flagged) out.push(`! ${f.kind}: ${f.message}`);
  if (!plan.changed) out.push('the section is already in sync: nothing to write');
  else if (applied) out.push(`wrote the section${trackerPath ? ` in ${trackerPath}` : ''}; nothing committed or pushed`);
  else out.push('dry run: nothing written. Re-run with --apply to write the section.');
  return out;
}

/**
 * THE COMMAND LINE'S TRAILER. PURE. Puts the readable plan first in plain mode; `--json` is left to the adapter,
 * whose payload already carries the plan as `verdict` and the section as `findings`.
 *
 * @param {{run: object, code: number, lines: string[], json?: boolean}} o
 * @returns {{code: number, lines: string[]}}
 */
export function finishPriorityOutcome({ run, code, lines, json = false } = {}) {
  if (json) return { code, lines };
  const plan = run?.verdict;
  if (!plan || !plan.found) return { code, lines };
  const applied = (run.effects ?? []).some((e) => e.type === PRIORITY_SYNC_EFFECT && e.status === 'applied');
  return { code, lines: [...renderPlan(plan, { applied, asked: run.input?.apply === true, trackerPath: run.findings?.read?.trackerPath ?? null }), '', ...lines] };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The declaration.

/**
 * SHAPE one `readFacts()` result into the `read` finding. PURE — every field defensively coalesced.
 *
 * @param {object} raw
 * @returns {object}
 */
export function shapePriorityRead(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  if (!r.sectionText) throw new Error(`priority-sync.read: the tracker card has no "${SECTION_HEADING}" section`);
  return {
    trackerPath: r.trackerPath ? String(r.trackerPath) : null,
    sectionText: String(r.sectionText),
    ref: r.ref ? String(r.ref) : null,
    today: String(r.today || ''),
    ranker: r.ranker === 'loader' ? 'loader' : 'fields',
    cards: Array.isArray(r.cards) ? r.cards : [],
    live: Array.isArray(r.live) ? r.live.map(String) : [],
    landed: r.landed && typeof r.landed === 'object' ? r.landed : {},
  };
}

/**
 * BUILD THE DECLARATION. `readFacts` is the injected reader; {@link ./priority-sync-io.mjs} supplies the real one
 * and tests supply a stub. Built per call so nothing leaks between registries.
 *
 * @param {{readFacts: (o: {ref: string, date: string}) => object}} deps
 * @returns {object} the frozen declaration from `op()`.
 */
export function prioritySyncOperation({ readFacts } = {}) {
  if (typeof readFacts !== 'function') {
    throw new TypeError(
      'priority-sync: needs a `readFacts({ref, date})` reader — the io is INJECTED so the declaration stays testable '
      + 'without git, the backlog directory or the loader; the real binding is `we:scripts/operations/priority-sync-io.mjs`.',
    );
  }

  return op(PRIORITY_SYNC_OP, {
    input: {
      // Where the merged cards come from besides the checkout's own `backlog/`. `origin/main` because the prototype
      // branch lags main and new cards are filed there; the reader does not fetch, so fetch first when it matters.
      ref: { type: 'string', required: false, default: 'origin/main' },
      // Off by default: a dry run prints the plan and writes nothing.
      apply: { type: 'boolean', required: false, default: false },
      // The date the `Updated:` line carries (YYYY-MM-DD); empty means the operator-local today.
      date: { type: 'string', required: false, default: '' },
    },
    verdictFrom: 'plan',

    read: compute({
      reads: ['input.ref', 'input.date'],
      fn: (view) => shapePriorityRead(readFacts({ ref: view.input.ref, date: view.input.date })),
    }),

    plan: compute({
      reads: ['findings.read'],
      fn: (view) => planPrioritySync(view.findings.read),
    }),

    apply: effectStep({
      reads: ['verdict', 'findings.read', 'input.apply'],
      effects: (view) => {
        if (!view.input.apply || !view.verdict?.changed) return [];
        return [{
          type: PRIORITY_SYNC_EFFECT,
          // IDEMPOTENT: the payload is the whole new section, and the sink treats "already the new section" as done.
          idempotent: true,
          payload: {
            trackerPath: view.findings.read.trackerPath,
            expectedSection: view.findings.read.sectionText,
            newSection: view.verdict.newSection,
          },
        }];
      },
    }),
  });
}
