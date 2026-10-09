/**
 * @file scripts/lib/prototype-tracker-data.mjs
 * @description PURE parser for epic #3383's own prototype tracker card
 *   (`backlog/3383-a-background-mechanical-dispatcher-replaces-the-interactive.md`) — the data half of the
 *   `prototype-tracker` skill's parser/renderer/CLI split, mirroring the `decision-docket` precedent
 *   (`we:skills-src/decision-docket/`): a session should never hand-author the tracker's published page, the
 *   same way it should never hand-author the docket's. Everything here is pure text-in/struct-out — no fs, no
 *   clock, no git — so it is unit-testable without touching the real backlog file (`__tests__/
 *   prototype-tracker-data.test.mjs`). The one impure lookup (finding the tracker file on disk) lives in the
 *   small IO-SHELL section at the bottom, mirroring `we:scripts/lib/poc-branches.mjs`'s pure-core/IO-shell split.
 *
 * WHY A DEDICATED PARSER RATHER THAN REUSING A GENERIC BACKLOG READER. This repo has no shared
 * frontmatter-plus-body backlog parser to reuse (checked before writing this — `we:scripts/lib/` holds no
 * `backlog-item.mjs`/`backlog-frontmatter.mjs`), and the tracker's OWN shape is bespoke: `## Session update
 * (<date>[, <qualifier>]) — <digest>` headings that other backlog cards don't use in this exact form. A shared
 * reader would have to special-case this card anyway, so it stays here, next to the renderer that consumes it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ACCEPTANCE_HEADING_RE } from '../backlog/task-agreement.mjs';

/** The frontmatter keys the render/CLI layer actually reads. Extras in the file are ignored, not an error. */
const FRONTMATTER_KEYS = ['bornAs', 'kind', 'parent', 'status', 'dateOpened', 'dateStarted', 'costSessions'];

// Deliberately LENIENT on what sits inside the parens: the live file's own ~25 entries include a couple of
// shapes a strict `date[, qualifier]` grammar misses — a date RANGE shorthand (`2026-08-30/31`) and a
// qualifier with no comma before it (`2026-09-12 night, close-out`). Capturing the whole parenthetical raw
// and splitting it in {@link splitDateQualifier} tolerates both without silently dropping those entries (a
// parser that quietly under-counts real session updates is worse than one that is a little permissive about
// their exact punctuation).
const SESSION_HEADING_RE = /^## Session update \(([^)]*)\)\s*(?:—|-{1,2})\s*(.*)$/;
const LEADING_DATE_RE = /^(\d{4}-\d{2}-\d{2})/;
const H1_RE = /^# (.+)$/m;
const H2_RE = /^## /;

/**
 * Split a session-update heading's raw parenthetical into its leading `YYYY-MM-DD` and whatever qualifier
 * text follows. PURE. Handles the two non-strict shapes found in the live file (a `/31`-style date-range
 * suffix, and a qualifier with no leading comma) by taking the date as a PREFIX match rather than requiring
 * the whole parenthetical to conform.
 * @param {string} raw the text between `Session update (` and `)`
 * @returns {{date: string|null, qualifier: string|null}}
 */
export function splitDateQualifier(raw) {
  const text = String(raw ?? '');
  const m = LEADING_DATE_RE.exec(text);
  if (!m) return { date: null, qualifier: text.trim() || null };
  const rest = text.slice(m[1].length).replace(/^,\s*/, '').trim();
  return { date: m[1], qualifier: rest || null };
}

/**
 * Split a very small subset of YAML frontmatter into a flat `{key: value}` map. PURE. Deliberately narrow —
 * this card's frontmatter is flat scalars/`[]` only (verified by reading the live file); a nested structure
 * would need a real YAML parser, which this is not trying to be.
 * @param {string} text the whole file's raw text
 * @returns {Record<string,string>}
 */
export function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(String(text ?? ''));
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    if (!FRONTMATTER_KEYS.includes(key)) continue;
    let value = rawValue.trim();
    if (/^".*"$/.test(value)) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/**
 * Every `## Session update (...)` entry, in file order (chronological — the convention is append-at-end).
 * PURE. Each entry's `body` is the text between its heading and the next `## `-level heading (or EOF),
 * trimmed — so a caller gets the full write-up, not just the digest line, without re-scanning the file.
 * @param {string} text
 * @returns {Array<{date: string, qualifier: string|null, digest: string, heading: string, body: string}>}
 */
export function parseSessionUpdates(text) {
  const lines = String(text ?? '').split('\n');
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const m = SESSION_HEADING_RE.exec(lines[i]);
    if (!m) continue;
    const [, raw, digest] = m;
    const { date, qualifier } = splitDateQualifier(raw);
    if (!date) continue; // no recognizable leading date — not a real dated entry, skip rather than mis-parse
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (H2_RE.test(lines[j])) { end = j; break; }
    }
    entries.push({
      date,
      qualifier,
      digest: digest.trim(),
      heading: lines[i].replace(/^## /, ''),
      body: lines.slice(i + 1, end).join('\n').trim(),
    });
  }
  return entries;
}

/**
 * The numbered acceptance checklist near the top of the card — the `## Acceptance` section or its legacy alias,
 * found by the shared task-agreement reader's heading rule (#5399 S7); items are `N. …` or `- [A#] …`. PURE. Returns `[]` when the section is
 * absent rather than throwing — a tracker missing that section is a content gap for the renderer to show
 * plainly, not a parse failure.
 * @param {string} text
 * @returns {string[]}
 */
export function parseDoneWhen(text) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex((l) => /^## /.test(l) && ACCEPTANCE_HEADING_RE.test(l.slice(3).trim()));
  if (start < 0) return [];
  const items = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (H2_RE.test(lines[i])) break;
    const m = /^(?:\d+\.|[-*+][ \t]+\[A\d+\])\s+(.*)$/i.exec(lines[i]);
    if (m) items.push(m[1].trim());
    // A continuation line (no leading "N.") extends the previous item — the card wraps long acceptance
    // entries across lines (verified against the live file's own item 1).
    else if (items.length && lines[i].trim() && !/^#/.test(lines[i])) items[items.length - 1] += ` ${lines[i].trim()}`;
  }
  return items;
}

/**
 * The card's H1 title and the standing-goal blockquote directly under it, when present. PURE. The blockquote
 * is the "STANDING GOAL FOR THIS EPIC" callout this card opens with — real, load-bearing operator direction,
 * not incidental — so the renderer surfaces it rather than dropping it as ordinary prose.
 * @param {string} text
 * @returns {{title: string|null, standingGoal: string|null}}
 */
export function parseHeaderBlock(text) {
  const h1 = H1_RE.exec(String(text ?? ''));
  const title = h1 ? h1[1].trim() : null;
  const lines = String(text ?? '').split('\n');
  const quoteLines = [];
  let seenH1 = false;
  for (const line of lines) {
    if (H1_RE.test(line)) { seenH1 = true; continue; }
    if (!seenH1) continue;
    if (line.startsWith('>')) { quoteLines.push(line.replace(/^>\s?/, '')); continue; }
    if (quoteLines.length) break; // blockquote ended
    if (line.trim() === '') continue; // skip the blank line between H1 and a blockquote
    break; // first non-blockquote content — no standing-goal callout here
  }
  return { title, standingGoal: quoteLines.length ? quoteLines.join(' ').trim() : null };
}

/**
 * Parse the whole tracker file into the struct the renderer consumes. PURE — the single entry point
 * `prototype-tracker.mjs` and the guard both call.
 * @param {string} text
 * @returns {{
 *   frontmatter: Record<string,string>,
 *   title: string|null,
 *   standingGoal: string|null,
 *   doneWhen: string[],
 *   sessionUpdates: Array<object>,
 *   latestUpdate: object|null,
 *   latestDate: string|null,
 * }}
 */
export function parseTracker(text) {
  const frontmatter = parseFrontmatter(text);
  const { title, standingGoal } = parseHeaderBlock(text);
  const doneWhen = parseDoneWhen(text);
  const sessionUpdates = parseSessionUpdates(text);
  const latestUpdate = sessionUpdates.length ? sessionUpdates[sessionUpdates.length - 1] : null;
  return {
    frontmatter,
    title,
    standingGoal,
    doneWhen,
    sessionUpdates,
    latestUpdate,
    latestDate: latestUpdate ? latestUpdate.date : null,
  };
}

/**
 * Format one `## Session update (...)` heading line, exactly matching the convention already in the live file
 * (verified against its ~40 existing entries): `## Session update (<date>[, <qualifier>]) — <digest>`. PURE.
 * @param {{date: string, qualifier?: string|null, summary: string}} o
 * @returns {string}
 */
export function formatSessionUpdateHeading({ date, qualifier = null, summary }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new TypeError(`formatSessionUpdateHeading: date must be YYYY-MM-DD, got ${JSON.stringify(date)}`);
  if (!summary || !String(summary).trim()) throw new TypeError('formatSessionUpdateHeading: summary is required');
  const q = qualifier && String(qualifier).trim() ? `, ${String(qualifier).trim()}` : '';
  return `## Session update (${date}${q}) — ${String(summary).trim()}`;
}

/**
 * Append one new session-update section to the tracker's raw text. PURE — takes and returns text, never
 * touches disk (the CLI does the read/write). Normalizes trailing whitespace so a repeated append can never
 * accumulate blank lines, and always leaves the file ending in exactly one trailing newline.
 * @param {string} text the tracker's current full text
 * @param {{date: string, qualifier?: string|null, summary: string, body: string}} entry
 * @returns {string} the new full text, with `entry` appended as the newest (last) section
 */
export function appendSessionUpdate(text, entry) {
  const heading = formatSessionUpdateHeading(entry);
  const trimmed = String(text ?? '').replace(/\s+$/, '');
  const body = String(entry?.body ?? '').trim();
  return `${trimmed}\n\n${heading}\n\n${body}\n`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// IO SHELL — the only part that touches the disk
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The one card this whole module exists to read — matched by prefix, never hard-coded past the number, so a
 *  future slug edit to the file (the part after `3383-`) can't silently break every caller. */
export const TRACKER_PREFIX = '3383-';

/**
 * Find the tracker's path under a `backlog/` directory. Returns `null` when absent rather than throwing — every
 * caller (CLI, guard) treats "no tracker found" as a reportable, non-fatal state.
 * @param {{backlogDir?: string, readdir?: (d:string) => string[]}} [o]
 * @returns {string|null}
 */
export function findTrackerPath({ backlogDir = join(process.cwd(), 'backlog'), readdir = readdirSync } = {}) {
  let names;
  try { names = readdir(backlogDir); } catch { return null; }
  const hit = names.find((n) => n.startsWith(TRACKER_PREFIX) && n.endsWith('.md'));
  return hit ? join(backlogDir, hit) : null;
}

/**
 * Read + parse the tracker off disk. `null` on any read/parse failure — never throws, so a SessionStart hook
 * or a CLI `render` can report "not found" instead of crashing.
 * @param {{backlogDir?: string, readdir?: (d:string) => string[], read?: (p:string) => string}} [o]
 * @returns {{path: string, data: ReturnType<typeof parseTracker>}|null}
 */
export function readTracker({ backlogDir, readdir = readdirSync, read = (p) => readFileSync(p, 'utf8') } = {}) {
  const path = findTrackerPath({ backlogDir, readdir });
  if (!path) return null;
  let text;
  try { text = read(path); } catch { return null; }
  return { path, data: parseTracker(text) };
}
