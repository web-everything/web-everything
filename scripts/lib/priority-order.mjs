import { isTerminalStatus } from './backlog-status.cjs';
/**
 * @file scripts/lib/priority-order.mjs
 * @description The gate behind epic #3383's `## Priority order` section — the ONE maintained, ordered list of
 *   open work under the epic, so the orchestrator dispatches from the top of it and never re-prioritises.
 *   `node scripts/prototype-tracker.mjs check-priority [--ref=origin/main] [--strict]` reports drift between
 *   that section and the backlog: an open card under #3383 with no line, a resolved card that still has one,
 *   a card listed twice, a card listed for a number that does not exist, or a `blockedBy` edge whose blocker
 *   sits BELOW the card it blocks.
 *
 * SCOPE — "under #3383" means the LIVE TREE: every open/active card whose `parent` chain reaches 3383 without
 * passing through a resolved card. That is the direct children plus the open slices of open epic children
 * (a slice of #3718 is dispatchable work the list must order; a slice of a resolved card is not the epic's).
 *
 * WHAT COUNTS AS A LINE. Only a line that STARTS with an entry marker inside the section:
 *   `N. #card · size · band · why`   — an ordered line (the list the orchestrator dispatches from)
 *   `- #card · size · claimed · why` — a claimed card (`status: active`): listed, never ordered
 * A `#card` mentioned inside the prose of a line is not an entry, so a "why" can cite other cards freely.
 *
 * TWO SOURCES, RESOLVED-WINS. Cards come from the local `backlog/` directory and, with `--ref`, also from a git
 * ref (`origin/main` — the prototype branch lags main, and new cards are filed there). A card resolved in EITHER
 * source is resolved (the branch resolves prototype work before main hears of it; main resolves cards the branch
 * has not fetched yet). A card present in only one source is read from that one.
 *
 * PURE CORE + IO SHELL (mirrors `we:scripts/lib/prototype-tracker-data.mjs`): parse/check are pure text-in,
 * struct-out; the fs and git reads sit at the bottom and are injectable, so the unit tests can stub them and
 * the real-mechanism tests (#2949) run the same shell against a real directory and a real git repo.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import matter from 'gray-matter';
import { UNWRITTEN_WHY } from './priority-markers.mjs';

export const ROOT_EPIC = '3383';
export const SECTION_HEADING = '## Priority order';

const LIVE = new Set(['open', 'active']);
const ORDERED_RE = /^(\d+)\.\s+#([0-9a-z]+)\s+·\s/;
const CLAIMED_RE = /^-\s+#([0-9a-z]+)\s+·\s/;

/**
 * Parse the `## Priority order` section out of the tracker card's text. PURE.
 * @param {string} text the whole tracker card
 * @returns {{found: boolean, entries: Array<{id: string, kind: 'ordered'|'claimed', n: number|null, line: number, unwritten: boolean}>}}
 */
export function parsePriorityOrder(text) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex((l) => l.trimEnd() === SECTION_HEADING);
  if (start === -1) return { found: false, entries: [] };
  const entries = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) break;
    const unwritten = lines[i].includes(UNWRITTEN_WHY);
    const o = ORDERED_RE.exec(lines[i]);
    if (o) { entries.push({ id: o[2], kind: 'ordered', n: Number(o[1]), line: i + 1, unwritten }); continue; }
    const c = CLAIMED_RE.exec(lines[i]);
    if (c) entries.push({ id: c[1], kind: 'claimed', n: null, line: i + 1, unwritten });
  }
  return { found: true, entries };
}

/**
 * The live tree under the root epic: every open/active card reachable through a chain of open/active parents.
 * PURE.
 * @param {Map<string, {id: string, parent: string|null, status: string, blockedBy: string[]}>} cards
 * @param {string} [root]
 * @returns {Set<string>} card ids, root excluded
 */
export function liveTree(cards, root = ROOT_EPIC) {
  const kids = new Map();
  for (const c of cards.values()) {
    if (!c.parent) continue;
    if (!kids.has(c.parent)) kids.set(c.parent, []);
    kids.get(c.parent).push(c);
  }
  const out = new Set();
  const walk = (id) => {
    for (const k of kids.get(id) ?? []) {
      if (out.has(k.id) || !LIVE.has(k.status)) continue;
      out.add(k.id);
      walk(k.id);
    }
  };
  walk(root);
  return out;
}

/**
 * Check the section against the cards. PURE.
 * @param {string} trackerText
 * @param {Map<string, {id: string, parent: string|null, status: string, blockedBy: string[]}>} cards
 * @returns {{ok: boolean, findings: Array<{kind: string, id: string|null, message: string}>, warnings: Array<{kind: string, id: string|null, message: string}>, stats: {live: number, entries: number}}}
 *   `warnings` are not drift: a line that still carries `why: (unwritten)` (a line `priority-sync` added, waiting for
 *   a worker to write its reason). They never change `ok`; `--strict-why` on the command line makes them fail.
 */
export function checkPriorityOrder(trackerText, cards) {
  const findings = [];
  const add = (kind, id, message) => findings.push({ kind, id, message });
  const { found, entries } = parsePriorityOrder(trackerText);
  const live = liveTree(cards);
  if (!found) {
    add('no-section', null, `the tracker card has no "${SECTION_HEADING}" section`);
    return { ok: false, findings, warnings: [], stats: { live: live.size, entries: 0 } };
  }

  const seen = new Map();
  for (const e of entries) {
    if (seen.has(e.id)) add('duplicate', e.id, `#${e.id} appears on lines ${seen.get(e.id)} and ${e.line}`);
    else seen.set(e.id, e.line);
  }
  for (const id of [...live].sort()) {
    if (!seen.has(id)) add('missing', id, `open card #${id} under #${ROOT_EPIC} has no line in the section`);
  }
  for (const e of entries) {
    const card = cards.get(e.id);
    if (!card) { add('unknown', e.id, `line ${e.line} lists #${e.id}, which is not a card in any source read`); continue; }
    if (!LIVE.has(card.status)) add('resolved-listed', e.id, `line ${e.line} lists #${e.id}, which is ${card.status}`);
    else if (card.status === 'active' && e.kind === 'ordered') add('claimed-ordered', e.id, `line ${e.line} orders #${e.id}, which is claimed (status active): list it under the claimed lines instead`);
    else if (card.status === 'open' && e.kind === 'claimed') add('not-claimed', e.id, `line ${e.line} lists #${e.id} as claimed, but it is open`);
  }

  const pos = new Map();
  for (const e of entries) if (e.kind === 'ordered' && !pos.has(e.id)) pos.set(e.id, e.n); // first line wins; a duplicate is already reported
  for (const [id, n] of pos) {
    for (const b of cards.get(id)?.blockedBy ?? []) {
      if (pos.has(b) && pos.get(b) > n) {
        add('blocked-order', id, `#${id} (line number ${n}) is ordered before #${b} (${pos.get(b)}), which blocks it`);
      }
    }
  }
  const warnings = entries.filter((e) => e.unwritten).map((e) => ({ kind: 'why-unwritten', id: e.id, message: `line ${e.line}: #${e.id} still carries "${UNWRITTEN_WHY}": a worker owes its one-sentence reason` }));
  return { ok: findings.length === 0, findings, warnings, stats: { live: live.size, entries: entries.length } };
}

/** Frontmatter of one card -> the few fields the check reads. PURE. */
export function parseCard(id, text) {
  let data;
  try { data = matter(String(text ?? '')).data ?? {}; } catch { return null; }
  const blockedBy = Array.isArray(data.blockedBy) ? data.blockedBy.map(String) : data.blockedBy ? [String(data.blockedBy)] : [];
  return { id, parent: data.parent != null && data.parent !== '' ? String(data.parent) : null, status: String(data.status ?? ''), blockedBy };
}

const idFromName = (name) => name.replace(/\.md$/, '').split('-')[0];

/**
 * Merge card maps: resolved in ANY source wins; otherwise the earlier source wins. PURE.
 * @param {Array<Map<string, object>>} sources local first
 */
export function mergeCards(...sources) {
  const out = new Map();
  for (const src of sources) {
    for (const [id, c] of src) {
      const prev = out.get(id);
      if (!prev) { out.set(id, c); continue; }
      if (isTerminalStatus(c.status) && !isTerminalStatus(prev.status)) out.set(id, { ...prev, status: c.status });
    }
  }
  return out;
}

/** Split `git cat-file --batch` output into `{sha, text}` records. PURE. */
export function parseCatFileBatch(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(0x0a, i);
    if (nl === -1) break;
    const [sha, type, size] = buf.toString('utf8', i, nl).split(' ');
    if (type === 'missing') { i = nl + 1; continue; }
    const n = Number(size);
    out.push({ sha, text: buf.toString('utf8', nl + 1, nl + 1 + n) });
    i = nl + 1 + n + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// IO shell — injectable.

/** Read every `backlog/*.md` under a directory. */
export function readCardsFromDir({ backlogDir = join(process.cwd(), 'backlog'), readdir = readdirSync, read = (p) => readFileSync(p, 'utf8') } = {}) {
  const cards = new Map();
  for (const name of readdir(backlogDir)) {
    if (!name.endsWith('.md')) continue;
    const id = idFromName(name);
    let text;
    try { text = read(join(backlogDir, name)); } catch { continue; }
    const c = parseCard(id, text);
    if (c) cards.set(id, c);
  }
  return cards;
}

/** Default git executor: `git <args>` with optional stdin, returns stdout as a Buffer (throws on a nonzero exit). */
export function defaultGit(args, { input, cwd } = {}) {
  const r = spawnSync('git', args, { input, cwd, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(r.stderr ?? '').trim()}`);
  return r.stdout;
}

/** Read every `backlog/*.md` blob at a git ref in ONE `cat-file --batch` call (not one `git show` per card). */
export function readCardsFromRef(ref, { git = defaultGit, cwd } = {}) {
  const tree = git(['ls-tree', '-r', '--full-tree', ref, '--', 'backlog/'], { cwd }).toString('utf8');
  const blobs = [];
  for (const line of tree.split('\n')) {
    const m = /^\d+ blob ([0-9a-f]+)\tbacklog\/([^/]+\.md)$/.exec(line);
    if (m) blobs.push({ sha: m[1], name: m[2] });
  }
  const raw = git(['cat-file', '--batch'], { input: blobs.map((b) => b.sha).join('\n') + '\n', cwd });
  const textBySha = new Map(parseCatFileBatch(raw).map((r) => [r.sha, r.text]));
  const cards = new Map();
  for (const b of blobs) {
    const id = idFromName(b.name);
    const c = parseCard(id, textBySha.get(b.sha) ?? '');
    if (c) cards.set(id, c);
  }
  return cards;
}
