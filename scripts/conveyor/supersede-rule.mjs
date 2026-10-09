/**
 * @file scripts/conveyor/supersede-rule.mjs — card xiqtf7w. Which open PRs has a MERGED PR declared it supersedes?
 *
 * Live 2026-10-09: #4532 merged at 01:52Z with the body line `### Supersedes #4522` ("#4522 is superseded by this PR.
 * It should be closed after this merges."). #4522 stayed open (`review:changes`, conflicting) and the fix daemon still
 * launched `fix-4522` at 04:34Z — a fixer spent on work that had already landed elsewhere.
 *
 * THE MARKER (precise on purpose — prose mentions never count). A LINE of the merged PR's body whose content, after an
 * optional markdown heading (`#` to `######` plus a space) and optional `**` bold, starts with the word `Supersedes`
 * (case-sensitive), an optional `:`, then one or more `#N` separated by `,`, `and`, or spaces. Examples that count:
 *   `Supersedes: #4522`   `### Supersedes #4522`   `**Supersedes:** #12, #13 and #14`
 * Examples that do not: `This supersedes #4522.` (mid-sentence), `supersedes #4522` (lower case), anything inside a
 * fenced code block. `open-pr.mjs` and `docs/agent/delivery-loop.md` tell authors to write `Supersedes: #N`.
 *
 * THE HOLD reuses the existing terminal hold — a stand-down (`stand-down.mjs`, reason `superseded`) — so
 * `reconcile-core.mjs` REFUSAL 1 stops fix, review and ci-heal for both daemons with no edit there. It never closes the
 * PR: closing on a supersede claim is an operator decision (the claim is the author's word, not a content proof).
 *
 * Declared setting `supersede-settings.json` (`{ "supersede": { "hold": "on", "lookbackDays": 14 } }`, env
 * `WE_SUPERSEDE_HOLD` beats the file's `hold`); missing, malformed or `off` = no hold (the behaviour before this card).
 * PURE apart from the settings file read.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supersedeHoldsOn } from './stand-down.mjs';

export const SUPERSEDE_HOLD_ENV = 'WE_SUPERSEDE_HOLD';
export const DEFAULT_SUPERSEDE_LOOKBACK_DAYS = 14;
export const supersedeSettingsPath = () => join(dirname(fileURLToPath(import.meta.url)), 'supersede-settings.json');

const parseSwitch = (raw) => {
  if (typeof raw === 'boolean') return raw;
  const s = String(raw ?? '').trim().toLowerCase();
  if (/^(on|true|1|yes)$/.test(s)) return true;
  if (/^(off|false|0|no)$/.test(s)) return false;
  return null;
};

/** `{ hold, lookbackDays }` in force. Env beats the file for `hold`; anything missing or malformed is off / 14 days. */
export function resolveSupersedeSettings(env = process.env, { path = supersedeSettingsPath(), read = readFileSync } = {}) {
  let file = {};
  try { file = JSON.parse(read(path, 'utf8'))?.supersede ?? {}; } catch { file = {}; }
  const days = Number(file.lookbackDays);
  return {
    hold: parseSwitch(env?.[SUPERSEDE_HOLD_ENV]) ?? parseSwitch(file.hold) ?? false,
    lookbackDays: Number.isInteger(days) && days > 0 && days <= 90 ? days : DEFAULT_SUPERSEDE_LOOKBACK_DAYS,
  };
}

/** One marker line: heading, bold, `Supersedes`, optional `:` (bold may close either side of it), then the PR list.
 *  Text after the list (`Supersedes #4522 (lane/main-red-soak)`) is allowed; text before `Supersedes` is not. */
const MARKER_LINE_RE = /^ {0,3}(?:#{1,6}[ \t]+)?(?:\*\*)?Supersedes(?:\*\*)?[ \t]*:?[ \t]*(?:\*\*)?[ \t]*(#\d+(?:(?:[ \t]*,[ \t]*|[ \t]+and[ \t]+|[ \t]+)#\d+)*)(?!\w)/;

/** A fence line: up to 3 SPACES (a tab or no-break space is indented code / not a fence), a run of 3+ backticks or
 *  3+ tildes, then the rest of the line. */
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** A fence opened inside a list item (`- ```` / `1. ````): its closer is indented to the item's content, any depth. */
const LIST_FENCE_LINE_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+(`{3,}|~{3,})(.*)$/;
const INDENTED_FENCE_LINE_RE = /^ *(`{3,}|~{3,})(.*)$/;

/** Most PR numbers one body may declare; a body past it is not a list of real supersedes. */
export const MAX_SUPERSEDE_TARGETS = 50;

/**
 * The PR numbers a body declares it supersedes, in order, de-duplicated. PURE.
 * @param {string} body
 * @returns {number[]}
 */
export function parseSupersedes(body) {
  if (typeof body !== 'string' || !body) return [];
  const out = [];
  let fence = null; // { char, len, inList } of the open fence, CommonMark rules: closes on the same char, at least as long
  let inComment = false; // inside a multi-line `<!-- ... -->` (PR templates carry guidance there)
  for (const line of body.split(/\r?\n/)) {
    if (fence) {
      const close = (fence.inList ? INDENTED_FENCE_LINE_RE : FENCE_LINE_RE).exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len && close[2].trim() === '') fence = null;
      continue;
    }
    if (inComment) { if (line.includes('-->')) inComment = false; continue; }
    const open = FENCE_LINE_RE.exec(line) ?? LIST_FENCE_LINE_RE.exec(line);
    // A backtick fence's info string cannot hold a backtick, so ```text``` on one line is inline code, not a fence.
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { char: open[1][0], len: open[1].length, inList: !FENCE_LINE_RE.test(line) };
      continue;
    }
    const m = MARKER_LINE_RE.exec(line);
    if (m) {
      for (const n of m[1].matchAll(/#(\d+)/g)) {
        const num = Number(n[1]);
        if (Number.isSafeInteger(num) && num > 0 && !out.includes(num)) out.push(num);
        if (out.length >= MAX_SUPERSEDE_TARGETS) return out;
      }
    }
    const opened = line.lastIndexOf('<!--');
    if (opened !== -1 && !line.includes('-->', opened)) inComment = true;
  }
  return out;
}

const isMerged = (pr) => String(pr?.state ?? '').toUpperCase() === 'MERGED' || (typeof pr?.mergedAt === 'string' && pr.mergedAt !== '');

/**
 * The supersede holds owed now. For each OPEN PR a MERGED PR declares it supersedes (never itself, never by a PR
 * that is still open): `{ pr, by, mergedAt }`. Skips a PR whose thread already carries a trusted supersede hold
 * (`stand-down.mjs#supersedeHoldsOn`), so a re-run posts nothing new. At most one hold per open PR (the earliest
 * merged superseder). `[]` when the setting is off. PURE.
 * @param {{mergedPrs:Array<{number:number, body?:string, state?:string, mergedAt?:string}>,
 *   openPrs:Array<{number:number, comments?:Array<object>}>, settings?:{hold:boolean}}} o
 * @returns {Array<{pr:number, by:number, mergedAt:?string}>}
 */
export function planSupersedeHolds({ mergedPrs = [], openPrs = [], settings = resolveSupersedeSettings() } = {}) {
  if (!settings?.hold) return [];
  const open = new Map((Array.isArray(openPrs) ? openPrs : []).map((p) => [Number(p?.number), p]));
  const merged = (Array.isArray(mergedPrs) ? mergedPrs : []).filter(isMerged)
    .filter((m) => !open.has(Number(m.number)))
    .sort((a, b) => (Date.parse(a.mergedAt ?? '') || 0) - (Date.parse(b.mergedAt ?? '') || 0));
  const holds = new Map();
  for (const m of merged) {
    for (const target of parseSupersedes(m.body)) {
      if (target === Number(m.number) || holds.has(target)) continue;
      const pr = open.get(target);
      if (!pr) continue;
      if (supersedeHoldsOn(pr.comments).length) continue;
      holds.set(target, { pr: target, by: Number(m.number), mergedAt: m.mergedAt ?? null });
    }
  }
  return [...holds.values()];
}

/** The open PR numbers worth reading comments for: targets of a merged PR's marker. PURE. */
export function supersedeCandidates({ mergedPrs = [], openNumbers = [] } = {}) {
  const open = new Set((Array.isArray(openNumbers) ? openNumbers : []).map(Number));
  const out = new Set();
  for (const m of (Array.isArray(mergedPrs) ? mergedPrs : []).filter(isMerged)) {
    for (const t of parseSupersedes(m.body)) if (t !== Number(m.number) && open.has(t)) out.add(t);
  }
  return [...out];
}
