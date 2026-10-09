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
 * Examples that do not: `This supersedes #4522.` (mid-sentence), `supersedes #4522` (lower case), anything CommonMark
 * renders as code (a fenced or indented code block, a raw `<pre>`, a code span running across lines) or hides (an HTML
 * comment). `open-pr.mjs` and `docs/agent/delivery-loop.md` tell authors to write `Supersedes: #N`.
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
import MarkdownIt from 'markdown-it';
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
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})([^]*)$/;
/** A fence opened inside a list item (`- ```` / `1. ````, markers may nest on one line: `- - ````). The closer may be
 *  indented at most 3 columns past the item's content column (4+ is code content, not a closer). `[^]` (not `.`) so
 *  U+2028/U+2029 in an info string do not stop a line being read as a fence. */
const LIST_FENCE_LINE_RE = /^ {0,3}(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)+(`{3,}|~{3,})([^]*)$/;
const FENCE_RUN_RE = /^(`{3,}|~{3,})([^]*)$/;
/** After a closing run only spaces and tabs are allowed (not `trim()`, which also strips NBSP, BOM, U+2028). */
const BLANK_RE = /^[ \t]*$/;
/** Columns a string spans, tabs to the next multiple of 4. */
const columnsOf = (s) => { let col = 0; for (const ch of s) col += ch === '\t' ? 4 - (col % 4) : 1; return col; };
/** The content column of a list-item fence opener (where the fence run starts), or null when ANY gap after a marker
 *  is 5+ spaces (then the rest is indented code, not a fence). */
const listFenceColumn = (line, open) => {
  const prefix = line.slice(0, line.length - open[1].length - open[2].length);
  return / {5,}/.test(prefix) ? null : columnsOf(prefix);
};
/** `line` without inline code spans, so a backticked `<!--` does not open a comment. */
const withoutCodeSpans = (line) => line.replace(/(`+)[^]*?\1/g, '');

/** PR #4560, round 4: what is code and what is prose is CommonMark's call. Three rounds of fixes to the line tracker
 *  above each missed a container rule (a line left of a list item's content column ends the item AND its fence, and
 *  may open a new fence), so the block AND inline structure now come from markdown-it, a CommonMark parser already
 *  used at runtime by `scripts/lib/review-escalation.mjs`. `html: true`, as GitHub renders PR bodies.
 *  The tracker stays as a SECOND reading: a line is a marker only when markdown-it reads it as prose AND the tracker
 *  does not read it as fenced. Where they disagree it is a sloppily indented example (`1. ```` then a line left of the
 *  item's column): GitHub shows it as text, but the author meant code, and a missed hold costs one wasted fixer run
 *  while a false hold stops an unrelated PR until an operator answers. So the tracker can only hide lines, never add. */
const md = new MarkdownIt({ html: true }).disable('reference'); // `reference` is quadratic in markdown-it 13 (3 s on a
// 64 KB body of definitions); without it a definition parses as a paragraph, which `REF_DEF_START_RE` skips.

/** Raw HTML elements whose text a reader sees as code or struck out, or never sees. Counted across the whole body:
 *  a browser carries one left open into the next paragraph. */
const HIDING_TAGS = 'code|pre|kbd|samp|tt|var|textarea|script|style|del|strike|s';
const HIDING_TAG_RE = new RegExp(`<(/?)(?:${HIDING_TAGS})(?=[\\s/>])`, 'gi');
/** `s` without its complete `<!-- ... -->` comments (linear: one forward scan; an unclosed one is cut to the end). */
const withoutComments = (s) => {
  let out = '';
  for (let at = 0; ;) {
    const open = s.indexOf('<!--', at);
    if (open === -1) return out + s.slice(at);
    out += s.slice(at, open);
    const close = s.indexOf('-->', open + 4);
    if (close === -1) return out;
    at = close + 3;
  }
};
/** Open hiding tags after raw HTML `s`, starting from `depth`. A comment's text is not markup. */
const hidingDepthAfter = (s, depth) => {
  for (const m of withoutComments(s).matchAll(HIDING_TAG_RE)) depth = m[1] ? Math.max(0, depth - 1) : depth + 1;
  return depth;
};
/** A paragraph that starts like a link reference definition (`[a]: /url`, `[a\]b]: /url`): the `reference` rule is
 *  off (below), so such a definition — and a title running across lines after it — would read as prose. Never read it. */
const REF_DEF_START_RE = /^\[(?:[^\]\\]|\\[^])*\]:/;
/** A private-use character the body does not hold: inserting it at a line start changes no inline structure (it is
 *  neither punctuation nor space), and a body cannot spell it to mark a hidden line visible. */
const sentinelChar = (body) => {
  const used = new Set(body);
  for (let cp = 0xe000; ; cp++) {
    if (cp === 0xf900) cp = 0xf0000; // BMP private use ends; plane 15 holds 65534 more than a body can use up
    const ch = String.fromCodePoint(cp);
    if (!used.has(ch)) return ch;
  }
};
/** Does raw HTML `s` leave a comment, processing instruction or CDATA section open? A browser then hides everything
 *  after it (a `-->` markdown-it renders as text is escaped, so it closes nothing). */
const leavesRawOpen = (s) => [['<!--', '-->'], ['<?', '?>'], ['<![CDATA[', ']]>']]
  .some(([o, c]) => { const at = s.lastIndexOf(o); return at !== -1 && !s.includes(c, at + o.length); });

/** Which of `marked` (line numbers of one paragraph or heading, from `from`) does a reader see as plain text? ONE
 *  inline parse, every marked line prefixed with its own sentinel: a line counts only when its sentinel lands in a
 *  `text` token outside raw code-ish HTML and outside `~~strike~~`. That rejects a line that starts inside a code
 *  span, an inline comment, a tag's attribute, a link title or an image's alt text, with CommonMark's own precedence.
 *  `depth` is the hiding tags already open; returns the lines seen and the depth after this block. */
function visibleLines(inline, from, marked, ch, depth) {
  const lines = inline.content.split('\n');
  for (const i of marked) lines[i - from] = `${ch}${i}${ch}${lines[i - from]}`;
  const sentinelRe = new RegExp(`${ch}(\\d+)${ch}`, 'gu');
  const [parsed] = md.parseInline(lines.join('\n'), {});
  const seen = new Set();
  let strike = 0;
  for (const c of parsed?.children ?? []) {
    if (c.type === 'html_inline') { depth = hidingDepthAfter(c.content, depth); continue; }
    if (c.type === 's_open') strike++;
    else if (c.type === 's_close') strike = Math.max(0, strike - 1);
    if (c.type !== 'text' || depth || strike) continue;
    for (const m of c.content.matchAll(sentinelRe)) seen.add(Number(m[1]));
  }
  return { seen, depth };
}

/** The line numbers of `body` that a reader sees as plain text AND that look like a marker (`candidates`): inside a
 *  paragraph or a heading, never in a code block, raw HTML, inside a code-ish or struck-out HTML element left open,
 *  or after a raw comment that is never closed. */
function proseMarkerLines(body, candidates) {
  const out = new Set();
  const ch = sentinelChar(body);
  let hiddenFrom = Infinity;
  let depth = 0;
  const tokens = md.parse(body, {});
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];
    if (!tok.map || tok.map[0] >= hiddenFrom) continue;
    if (tok.type === 'html_block') {
      if (leavesRawOpen(tok.content || '')) hiddenFrom = Math.min(hiddenFrom, tok.map[1]);
      depth = hidingDepthAfter(tok.content || '', depth);
      continue;
    }
    if (tok.type !== 'paragraph_open' && tok.type !== 'heading_open') continue;
    const inline = tokens[t + 1];
    if (inline?.type !== 'inline') continue;
    const [from, to] = tok.map;
    if (tok.type === 'paragraph_open' && REF_DEF_START_RE.test(inline.content)) continue;
    // markdown-it `trim()`s a block's text, which also drops a first or last line of only NBSP / U+2028 / \v. Then
    // the text's lines no longer line up with the body's: read nothing in that block rather than the wrong line.
    const setext = tok.type === 'heading_open' && (tok.markup === '=' || tok.markup === '-');
    const aligned = inline.content.split('\n').length === to - from - (setext ? 1 : 0);
    const marked = [];
    for (let i = from; i < to; i++) if (candidates.has(i)) marked.push(i);
    const r = visibleLines(inline, from, aligned ? marked : [], ch, depth);
    depth = r.depth;
    for (const i of r.seen) out.add(i);
  }
  for (const i of out) if (i >= hiddenFrom) out.delete(i);
  return out;
}

/** The last few bodies' results: `supersedeCandidates` and `planSupersedeHolds` read the same bodies each tick. */
const parsedBodies = new Map();
const PARSED_BODIES_CAP = 256;

/** Most PR numbers one body may declare; a body past it is not a list of real supersedes. */
export const MAX_SUPERSEDE_TARGETS = 50;

/**
 * The PR numbers a body declares it supersedes, in order, de-duplicated. PURE.
 * @param {string} body
 * @returns {number[]}
 */
export function parseSupersedes(body) {
  if (typeof body !== 'string' || !body) return [];
  if (!parsedBodies.has(body)) {
    if (parsedBodies.size >= PARSED_BODIES_CAP) parsedBodies.delete(parsedBodies.keys().next().value);
    parsedBodies.set(body, readSupersedes(body));
  }
  return [...parsedBodies.get(body)];
}

function readSupersedes(body) {
  const out = [];
  const lines = body.split(/\r\n|\r|\n/); // CommonMark line endings: CRLF, lone CR, LF (markdown-it splits the same way)
  const candidates = new Set();
  lines.forEach((line, i) => { if (MARKER_LINE_RE.test(line)) candidates.add(i); });
  if (!candidates.size) return out; // most bodies: no markdown parse at all
  const prose = proseMarkerLines(body, candidates);
  let fence = null; // the tracker's open fence { char, len, base }: closes on the same char, at least as long,
  // indented 0-3 columns past `base` (0 for a top-level fence, the item's content column for a list-item fence)
  let inComment = false; // inside a multi-line `<!-- ... -->` (PR templates carry guidance there)
  for (const [index, line] of lines.entries()) {
    if (fence) {
      const lead = /^[ \t]*/.exec(line)[0];
      const close = FENCE_RUN_RE.exec(line.slice(lead.length));
      const indent = columnsOf(lead);
      if (close && indent >= fence.base && indent <= fence.base + 3 && close[1][0] === fence.char
        && close[1].length >= fence.len && BLANK_RE.test(close[2])) fence = null;
      continue;
    }
    if (inComment) { if (line.includes('-->')) inComment = false; continue; }
    const topOpen = FENCE_LINE_RE.exec(line);
    const open = topOpen ?? LIST_FENCE_LINE_RE.exec(line);
    // A backtick fence's info string cannot hold a backtick, so ```text``` on one line is inline code, not a fence.
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      const base = topOpen ? 0 : listFenceColumn(line, open);
      if (base !== null) {
        fence = { char: open[1][0], len: open[1].length, base };
        continue;
      }
    }
    const m = prose.has(index) ? MARKER_LINE_RE.exec(line) : null;
    if (m) {
      for (const n of m[1].matchAll(/#(\d+)/g)) {
        const num = Number(n[1]);
        if (Number.isSafeInteger(num) && num > 0 && !out.includes(num)) out.push(num);
        if (out.length >= MAX_SUPERSEDE_TARGETS) return out;
      }
    }
    // The lazy code-span regex is quadratic on a long backtick line: past 4 KB keep the line whole (hides more, never less).
    const bare = line.includes('<!--') && line.length <= 4096 ? withoutCodeSpans(line) : line;
    const opened = bare.lastIndexOf('<!--');
    if (opened !== -1 && !bare.includes('-->', opened)) inComment = true;
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
