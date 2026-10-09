/**
 * @file decision-docket-data.mjs — the DATA half of the Decision Docket's data/template separation.
 *
 * WHY THIS EXISTS: the published Decision Docket artifact (skills-src/decision-docket/) has been hand-edited
 * HTML each time a session refreshed it. Because there was no structured data model in between "read the
 * backlog" and "write the HTML", each refresh session hand-composed prose directly into the page — including
 * meta-commentary about the refresh itself ("Correction — 13 September", "second pass", "false alarm",
 * retraction explanations). That commentary describes the SESSION's own history, not the decision content, and
 * had no business being baked into a published artifact re-rendered from scratch every time.
 *
 * THE FIX: pull a clean, fully-structured JSON record per decision item — title, status, leverage numbers,
 * forks with their real options/rejections/skeptic-screen verdicts — with NO prose narrative field anywhere in
 * the shape. There is nowhere in this schema to put a "correction" or a "second pass" note; if something needs
 * correcting, you fix the DATA (re-run this extractor) and the diff shows in `git log` on the JSON file, which
 * is a real, durable, diff-able audit trail — never a hand-written paragraph baked into the rendered page.
 *
 * This module is the PURE core (no fs, no child_process): it parses one decision item's raw markdown body into
 * the structured shape. The IO shell (reading files, shelling `git show`/`check:readiness`) lives in
 * `scripts/gen-decision-docket.mjs`, which is the only place this module's callers touch disk or a subprocess.
 *
 * SCOPE NOTE (read before extending): this is NOT backlog/3562's standing mechanical pass (the leverage-ranked
 * watch that auto-dispatches `/prepare` and republishes on every conveyor tick — blocked on backlog/3277's
 * still-unbuilt publish/refresh operation). This is the narrower, immediately buildable piece both of those
 * items still need regardless: a real data model + a pure renderer, so ANY caller (a hand session today, or
 * #3562's mechanical pass once it lands) produces the same clean page from the same data. See
 * `scripts/gen-decision-docket.mjs`'s header for the full scope note.
 */

import { ACCEPTANCE_HEADING_RE } from '../backlog/task-agreement.mjs';

/** One rendered fork option's disposition. */
export const OPTION_KINDS = Object.freeze({ DEFAULT: 'default', REJECTED: 'rejected', OPEN: 'open' });

/** What an open PR on a decision IS, read off its title prefix ("ratify #N: …", "prepare #N: …"). */
export const PR_KINDS = Object.freeze({ RATIFICATION: 'ratification', PREPARATION: 'preparation', OTHER: 'other' });

/**
 * The kind of an open PR for decision `itemNum`, from its title's leading verb. `ratify #N` → ratification,
 * `prepare #N` → preparation; anything else — including a `ratify #M` that names a DIFFERENT item, or a PR that
 * merely mentions the decision — is `other`. PURE.
 * @param {string} title
 * @param {string|number} itemNum
 * @returns {'ratification'|'preparation'|'other'}
 */
export function classifyPrKind(title, itemNum) {
  const m = /^\s*(ratif(?:y|ies)|prepar(?:e|es))\s+#0*(\d+)\b/i.exec(String(title ?? ''));
  if (!m || Number(m[2]) !== Number(itemNum)) return PR_KINDS.OTHER;
  return /^ratif/i.test(m[1]) ? PR_KINDS.RATIFICATION : PR_KINDS.PREPARATION;
}

const PR_KIND_ORDER = { [PR_KINDS.RATIFICATION]: 0, [PR_KINDS.PREPARATION]: 1, [PR_KINDS.OTHER]: 2 };

/**
 * The ONE open PR a decision row is listed under: a ratification beats a preparation beats any other PR (the
 * row exists to say what the operator can act on), then the newest number. Returns `null` for no PRs. PURE.
 * @param {string|number} itemNum
 * @param {Array<{number?:number|null, title?:string, url?:string|null, repo?:string}>} prs - every open PR that lands the item.
 * @returns {{ number: number|null, state: 'open', kind: string, title: string, url: string|null, repo: string|null }|null}
 */
export function pickPr(itemNum, prs) {
  const rows = (prs || []).map((p) => ({
    number: p.number ?? null,
    state: 'open',
    kind: classifyPrKind(p.title, itemNum),
    title: String(p.title ?? ''),
    url: p.url ?? null,
    repo: p.repo ?? null,
  }));
  rows.sort((a, b) => PR_KIND_ORDER[a.kind] - PR_KIND_ORDER[b.kind] || (b.number ?? 0) - (a.number ?? 0));
  return rows[0] ?? null;
}

/**
 * The docket's headline counts. `open` and `prepared` count EVERY listed decision, in-review ones included (a
 * decision with an open PR is still an open decision, and its `preparedDate` is still set); `inReview` is how
 * many of those have an open PR. PURE.
 * @param {Array<{prepared?:boolean, pr?:object|null}>} items
 * @returns {{ open: number, prepared: number, inReview: number }}
 */
export function computeCounts(items) {
  const list = items || [];
  return { open: list.length, prepared: list.filter((i) => i.prepared).length, inReview: list.filter((i) => i.pr).length };
}

/** A fenced-code opener/closer line: any indent, then 3+ backticks or tildes (the CommonMark fence). */
const FENCE_LINE_RE = /^\s*(`{3,}|~{3,})/;

/**
 * Track fenced-code state across a line-by-line walk: feed each line, get back whether that line is INSIDE a
 * fence (the opener and closer lines count as inside). A blank line or a `## ` line inside a fence is code, not
 * a paragraph break or a section heading — splitting there would tear a code block (an `<svg>` sketch, a JSON
 * sample) into fragments that then render as flat prose.
 * @returns {(line: string) => boolean}
 */
function fenceTracker() {
  let open = null;
  return (line) => {
    const m = FENCE_LINE_RE.exec(line);
    if (open) {
      if (m && m[1][0] === open[0] && m[1].length >= open.length && /^\s*[`~]+\s*$/.test(line)) open = null;
      return true;
    }
    if (m) { open = m[1]; return true; }
    return false;
  };
}

/**
 * Split a markdown body into top-level paragraphs (blank-line separated, but never inside a fenced code block),
 * trimming each. Each paragraph keeps its own line structure (see `tidy`) so the renderer can see lists,
 * blockquotes and code; callers that only want a one-line string for DETECTION call `joinSoft`.
 * @param {string} text
 * @returns {string[]}
 */
function splitParagraphs(text) {
  return splitParagraphsRaw(text).map((p) => p.trim());
}

/**
 * Same blank-line/fence-aware split as `splitParagraphs`, but WITHOUT trimming each paragraph's leading
 * whitespace — only `splitParagraphs`' own `.filter(Boolean)` (on the trimmed check) drops genuinely-blank
 * entries. A paragraph's leading indent is the one signal that survives `splitParagraphs`' trim only on its
 * FIRST line (internal lines keep their own indent regardless) — and that first-line signal is exactly what
 * `walkOptionParagraphs` needs to tell "a markdown list item's own continuation paragraph" (indented — e.g.
 * a fenced code sample or nested sub-bullet inside an option, backlog/3055 Fork 2 option (a)) apart from "a
 * new top-level paragraph" (column 0 — a sibling option, or the fork's post-options commentary).
 * @param {string} text
 * @returns {string[]}
 */
function splitParagraphsRaw(text) {
  const paras = [];
  let cur = [];
  const inFence = fenceTracker();
  for (const line of String(text ?? '').split('\n')) {
    if (!inFence(line) && !line.trim()) {
      if (cur.length) paras.push(cur.join('\n'));
      cur = [];
    } else {
      cur.push(line);
    }
  }
  if (cur.length) paras.push(cur.join('\n'));
  return paras.filter((p) => p.trim());
}

/**
 * Join a paragraph's soft-wrapped lines into one flowing line. DETECTION ONLY (marker/verdict regexes, the
 * `Default: (x)` cross-reference): the displayed text keeps its newlines via `tidy`, because flattening it is
 * what destroyed every block construct (`> ` quotes, `- ` lists, ``` fences, `#` headings) before the renderer
 * ever saw them.
 */
function joinSoft(paragraph) {
  return paragraph.split('\n').map((l) => l.trim()).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Keep a paragraph's text as markdown for the renderer: strip trailing whitespace per line and trim the whole,
 * but PRESERVE newlines and indentation (a soft wrap is still just a space to a markdown renderer; a list,
 * quote or fence is not). Never inside a fence: a fence's own lines pass through untouched.
 */
function tidy(paragraph) {
  const inFence = fenceTracker();
  return paragraph.split('\n').map((l) => (inFence(l) ? l : l.replace(/\s+$/, ''))).join('\n').trim();
}

/**
 * Split a section's text into its numbered-list items ("1. …", "2) …"), joining each item's soft-wrapped
 * continuation lines. An acceptance section is often written as a numbered list with no blank line between
 * items (so a blank-line paragraph split would glue every item into one blob) — this handles that directly,
 * the same way `parseForkSection` handles lettered option bullets that aren't blank-line separated either.
 * @param {string} text
 * @returns {string[]}
 */
function splitNumberedList(text) {
  // A numbered item, or a task-agreement `- [A1] …` item (#5399 S7).
  const itemStartRe = /^(?:\d+[.)]\s*|[-*+][ \t]+\[A\d+\])/i;
  const items = [];
  let current = null;
  const inFence = fenceTracker();
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim();
    if (inFence(rawLine)) {
      // Inside a fenced code block every line is code — blank lines included, and a line that merely begins
      // with "1. " is not a new item.
      if (current !== null) current += `\n${rawLine.replace(/^ {1,3}/, '')}`;
      continue;
    }
    if (!line) continue;
    if (itemStartRe.test(line)) {
      if (current !== null) items.push(current);
      current = line;
    } else if (current !== null) {
      // Keep the continuation on its own line (indent stripped by the item marker's own width) so a nested
      // bullet or code fence inside a done-when item survives as markdown instead of running on as prose.
      current += `\n${rawLine.replace(/^ {1,3}/, '').replace(/\s+$/, '')}`;
    }
  }
  if (current !== null) items.push(current);
  return items.map((l) => l.trim());
}

/**
 * Split a full item body (everything after the `# Title` line) into top-level `## ` sections.
 * @param {string} bodyAfterTitle
 * @returns {Array<{ heading: string|null, text: string }>}
 */
function splitSections(bodyAfterTitle) {
  const lines = String(bodyAfterTitle ?? '').split('\n');
  const sections = [];
  let current = { heading: null, text: [] };
  const inFence = fenceTracker();
  for (const line of lines) {
    // A `## ` line inside a fenced code block is code (a markdown sample), not a new section.
    const m = inFence(line) ? null : /^##\s+(.*)$/.exec(line);
    if (m) {
      sections.push(current);
      current = { heading: m[1].trim(), text: [] };
    } else {
      current.text.push(line);
    }
  }
  sections.push(current);
  return sections.map((s) => ({ heading: s.heading, text: s.text.join('\n') }));
}

// A "Rejected"/"REJECTED" marker appears across the corpus in every emphasis wrapping an author happened to
// reach for — bold ("**Rejected:**"), italic ("*Rejected:*"), underscore-italic ("_Rejected:_"), or bare
// ("Rejected:" / "REJECTED") — 220+ instances of the colon-terminated form alone (only 19 are the older
// "**Rejected**"-only shape this used to require). Matching only the bold-no-colon form under-detected the
// overwhelming majority of real rejected options. Case-SENSITIVE on the word itself ("Rejected"/"REJECTED",
// never bare lowercase "rejected") — real content routinely uses the plain lowercase word mid-sentence with
// no marker intent at all ("one typed, named error per rejected input", backlog/2096 Fork 2's option (a),
// which is in fact the DEFAULT) and a case-insensitive match misread that as the option's own rejection.
const REJECTED_MARKER_RE = /(?:\*\*|\*|_)?\b(?:Rejected|REJECTED)\b:?(?:\*\*|\*|_)?/;
// A DEFAULT marker likewise shows up as the canonical trailing "← **RECOMMENDED**" (or, one item's own
// spelling of the same arrow convention, "← **default**" — same structural shape, case-insensitive on the
// word since the arrow itself is what makes it unambiguous, not the casing), a bare "RECOMMENDED"
// substring, or a bracketed inline marker — "[bold default]" (the most common legacy spelling, 119
// instances), "[default]", "[recommended default]", or "[RECOMMENDED DEFAULT]" — used by items that bold the
// option's own label+title and mark it default inline rather than appending a trailing arrow-marker.
const ARROW_MARKER_RE = /\s*←\s*\*\*(?:RECOMMENDED|default)\*\*/i;
const DEFAULT_BRACKET_RE = /\[\s*(?:bold\s+)?(?:recommended\s+)?default\s*\]/i;
// A same-shaped trailing PARENTHETICAL — "(default)", or "(default / ruling)"-style with trailing words
// after the marker itself (mirrors REJECTED_PAREN_RE's own trailing-text allowance below) — right after the
// option's own bolded title, rather than square brackets. Round parens are only trusted as a marker here
// (case-insensitively) because they're wrapped tightly around the marker word itself, not a bare substring
// search over the whole option — the bare-word searches above (Rejected/RECOMMENDED) are exactly what had
// to stay narrow to avoid mid-prose false positives; a parenthetical this specific carries far less of that
// risk.
const DEFAULT_PAREN_RE = /\(\s*(?:bold\s+)?(?:recommended\s+)?default\b[^)]{0,40}\)/i;
// The canonical BARE marker (docs/agent/backlog-workflow.md via backlog/3281's own worked catalogue):
// "**DEFAULT.**", "**NEW DEFAULT.**", "**BOLD DEFAULT.**", or the same word as the tail of a larger bold
// span ("**… — DEFAULT.**", "**… ; DEFAULT.**") — 25+ live instances across the corpus, always spelled in
// ALL CAPS when used as this marker (never the common lowercase "default" that appears constantly in
// ordinary prose describing a config/flag's own default VALUE — "a `drain` flag (default false)" is never a
// marker). Case-SENSITIVE on the word for exactly that reason: unlike RECOMMENDED (already matched
// case-insensitively above), "default" lowercase is far too common in incidental prose to search bare.
// "**SUPERSEDED DEFAULT …**" (backlog/3281's own documented retraction convention) is the one carve-out —
// an amendment's superseded marker records history, not a live pick — so it never counts here.
const SUPERSEDED_DEFAULT_RE = /\*\*SUPERSEDED\s+DEFAULT\b[^*]*\*\*/g;
const BARE_DEFAULT_WORD_RE = /\bDEFAULT\b/;
// Likewise a trailing parenthetical rejection marker — "(rejected …)", "(dominated)" — the latter a distinct
// but equally common rejection-flavored word for an option strictly worse than another live option (a
// game-theory framing several items use interchangeably with "Rejected").
const REJECTED_PAREN_RE = /\(\s*(?:rejected|dominated)\b[^)]{0,80}\)/i;

/**
 * True when `text` contains a genuine positive "recommended" default marker — but NOT when the only mention
 * is explicitly negated ("not recommended", "isn't recommended now") the way a REJECTED option's own prose
 * routinely states its exclusion (e.g. "*Coherent counter, not recommended.*"). Strips negated mentions
 * before testing so a negation-only text correctly reports false, while a text that ALSO carries a real
 * positive marker elsewhere still reports true.
 */
function hasPositiveRecommendedMarker(text) {
  const stripped = text.replace(/\b(?:not|n't)\s+recommended\b/gi, '');
  return /RECOMMENDED/i.test(stripped);
}

/** True when `text` carries the bare ALL-CAPS "DEFAULT" marker (see `BARE_DEFAULT_WORD_RE` above), ignoring
 * any "SUPERSEDED DEFAULT …" retraction mention (which records history, never a live pick). */
function hasPositiveDefaultMarker(text) {
  const stripped = text.replace(SUPERSEDED_DEFAULT_RE, '');
  return BARE_DEFAULT_WORD_RE.test(stripped);
}

/**
 * @param {string} label - the option's letter/number identifier (already lower-cased for a letter).
 * @param {string} flatText - the option's own tidied body text.
 * @param {boolean} [forceDefault] - true when the option's own label carried an inline marker (e.g. the
 *   "(a · DEFAULT)" convention) that already settled `kind` before any text-content marker is checked.
 */
function buildOption(label, flatText, forceDefault = false) {
  const isRejected = REJECTED_MARKER_RE.test(flatText) || REJECTED_PAREN_RE.test(flatText);
  const isDefault = !isRejected
    && (forceDefault || hasPositiveRecommendedMarker(flatText) || hasPositiveDefaultMarker(flatText)
      || DEFAULT_BRACKET_RE.test(flatText) || DEFAULT_PAREN_RE.test(flatText));
  const kind = isRejected ? OPTION_KINDS.REJECTED : isDefault ? OPTION_KINDS.DEFAULT : OPTION_KINDS.OPEN;
  // Strip the recognized default markers from the displayed body (redundant with `kind`, shown instead via the
  // ✓/✕ badge) — keep everything else verbatim, INCLUDING any punctuation right after it and the stated
  // rejection reason: dropping the rejection reason is exactly the omission the docket's own hard rule
  // (docs/agent/backlog-workflow.md#decision-docket) forbids, and dropping the trailing period would glue two
  // sentences together. The bracket-marker variant is stripped in two passes — first the form immediately
  // followed by a stray closing "**" (the "title **[bold default]**" convention closes its bold span right at
  // the marker), then the bare bracket alone — so a trailing "**" from the FIRST pass never survives into the
  // final body only to be counted as an orphaned bold delimiter downstream. The bare "**DEFAULT.**"-family
  // marker is intentionally left in the displayed body (same precedent as a bare "RECOMMENDED" mention —
  // detection-only, never stripped) rather than risk mis-trimming the larger bold span it often tails.
  const body = flatText
    .replace(ARROW_MARKER_RE, '')
    .replace(/\s*\[\s*(?:bold\s+)?(?:recommended\s+)?default\s*\]\s*\*\*/i, '**')
    .replace(/\s*\[\s*(?:bold\s+)?(?:recommended\s+)?default\s*\]/i, '')
    .trim();
  return { label: `(${label})`, kind, body };
}

/**
 * Remove a leading "Skeptic:"/"Screen:" label from a verdict paragraph and return the verdict text. A label's
 * emphasis is not always closed at the label: "**Skeptic: SURVIVES.** …" and "`Skeptic: … text`" open a span
 * at the label that only closes further in. Stripping just the label would leave that closer orphaned (a raw
 * `**` or backtick in the rendered page), so an opener the label consumed without closing takes its first
 * matching closer with it. A closer is only removed when the remainder has an unpaired one (odd count), so a
 * balanced span the verdict itself carries is never touched.
 * @param {string} text
 * @param {RegExp} labelRe - anchored label regex (matches through the colon and any closing emphasis).
 * @returns {string}
 */
function stripVerdictLabel(text, labelRe) {
  const m = labelRe.exec(text);
  if (!m) return text.trim();
  const label = m[0].trimEnd();
  let rest = text.slice(m[0].length);
  const opener = /^(\*\*|\*|_|`)/.exec(label)?.[1];
  if (opener && !label.endsWith(opener)) {
    const re = { '**': /\*\*/g, '*': /(?<!\*)\*(?!\*)/g, _: /(?<![\w_])_(?![\w_])/g, '`': /`/g }[opener];
    const hits = [...rest.matchAll(re)];
    if (hits.length % 2 === 1) {
      rest = rest.slice(0, hits[0].index) + rest.slice(hits[0].index + opener.length);
    }
  }
  return rest.trim();
}

// Bold ("**Skeptic:**") is the canonical current form. Older items wrote the plain label with no emphasis,
// wrapped it in a single backtick ("`Skeptic:`") or italics ("*Skeptic:*"/"_Skeptic:_"), or padded it with a
// parenthetical aside before the colon ("*Skeptic (dedicated fresh sub-agent, four axes…):*") — accept all
// of these rather than mis-flagging real content as missing: `[^:]*` absorbs any such aside, and matches zero
// characters for the plain "Skeptic:" case, so this stays backward-compatible. Shared by the fork parser and
// the validation-gate parser — a gate's `## Recommendation` closes with the same two verdict lines.
// `[^:]*` (not `[^:\n]*`): these run over the paragraph's own multi-line text (it is no longer pre-flattened
// onto one line), and a parenthetical aside is free to wrap across lines.
const EMPH = '(?:\\*\\*|\\*|_|`)?';
const skepticRe = new RegExp(`^${EMPH}Skeptic\\b[^:]*:${EMPH}\\s*`, 'i');
const screenRe = new RegExp(`^${EMPH}Screen\\b[^:]*:${EMPH}\\s*`, 'i');
const screenInlineRe = new RegExp(`${EMPH}Screen\\b[^:]*:${EMPH}\\s*`, 'i'); // unanchored — find/split Screen: WITHIN a paragraph

/**
 * Split a paragraph's text into its `Skeptic:` / `Screen:` verdicts. The two are often written as adjacent lines
 * (one paragraph to `splitParagraphs`), so a Skeptic paragraph is split at an inline `Screen:` label.
 * @param {string} text - one tidied paragraph.
 * @returns {{ skeptic: string|null, screen: string|null }} both null when the paragraph carries neither verdict.
 */
function extractVerdicts(text) {
  if (skepticRe.test(text)) {
    const screenIdx = text.search(screenInlineRe);
    if (screenIdx === -1) return { skeptic: stripVerdictLabel(text, skepticRe), screen: null };
    return {
      skeptic: stripVerdictLabel(text.slice(0, screenIdx), skepticRe),
      screen: stripVerdictLabel(text.slice(screenIdx), screenRe),
    };
  }
  if (screenRe.test(text)) return { skeptic: null, screen: stripVerdictLabel(text, screenRe) };
  return { skeptic: null, screen: null };
}

const TOP_BULLET_LINE_RE = /^-\s+/;

/**
 * Split a paragraph's raw lines into its top-level "- " bullet items (one entry per bullet, its own wrapped
 * continuation lines joined in). Returns `null` when the paragraph doesn't itself open with a bullet line —
 * nothing to split; the whole paragraph is one unit.
 * @param {string} paragraph - raw (pre-`tidy`) paragraph text.
 * @returns {string[]|null}
 */
function splitTopBulletItems(paragraph) {
  const lines = paragraph.split('\n');
  if (!TOP_BULLET_LINE_RE.test(lines[0])) return null;
  const items = [];
  let current = null;
  for (const line of lines) {
    if (TOP_BULLET_LINE_RE.test(line)) {
      if (current !== null) items.push(current.join('\n'));
      current = [line.replace(TOP_BULLET_LINE_RE, '')];
    } else if (current !== null) {
      current.push(line);
    }
  }
  if (current !== null) items.push(current.join('\n'));
  return items;
}

/**
 * Pull the Skeptic:/Screen: verdict(s) out of ONE raw top-level paragraph — including the common shape where
 * the verdict is one bullet inside a "- **Verdict:** … / - **Skeptic:** …" list with NO blank line between
 * bullets (so the whole list is ONE paragraph to `splitParagraphs`, and the verdict bullet isn't at the
 * paragraph's own start — e.g. backlog/2224, backlog/1648, backlog/2544's "## Recommendation" bullet lists).
 * @param {string} paragraph - raw (pre-`tidy`) paragraph text.
 * @returns {{ skeptic: string|null, screen: string|null, leftover: string|null }} `leftover` is the
 *   paragraph's remaining real content (verbatim, minus any consumed verdict bullet), tidied; `null` when
 *   the whole paragraph WAS the verdict(s).
 */
function extractParagraphVerdicts(paragraph) {
  const flat = tidy(paragraph);
  const whole = extractVerdicts(flat);
  if (whole.skeptic !== null || whole.screen !== null) return { ...whole, leftover: null };

  const items = splitTopBulletItems(paragraph);
  if (items && items.length > 1) {
    let skeptic = null;
    let screen = null;
    let matchedAny = false;
    const keptItems = [];
    for (const item of items) {
      const iv = extractVerdicts(tidy(item));
      if (iv.skeptic !== null || iv.screen !== null) {
        if (iv.skeptic !== null) skeptic = iv.skeptic;
        if (iv.screen !== null) screen = iv.screen;
        matchedAny = true;
      } else {
        keptItems.push(`- ${item}`);
      }
    }
    if (matchedAny) return { skeptic, screen, leftover: keptItems.length ? tidy(keptItems.join('\n')) : null };
  }

  return { skeptic: null, screen: null, leftover: flat };
}

/**
 * Parse ONE `## Fork N` section body into its structured shape: the fork-existence justification, the lettered
 * options (default / rejected / open), any leftover context paragraphs (code samples, scope narrowing — real
 * item content, never invented), and the closing `Skeptic:`/`Screen:` verdict lines. Never throws — a fork whose
 * shape doesn't match the documented convention (docs/agent/backlog-workflow.md#decision-docket's
 * "prepared-fork shape") comes back with `parseOk: false` and a human-readable `warning`, so a caller can
 * surface that honestly instead of fabricating content to fill the gap.
 * @param {number} n
 * @param {string} headingRest - the heading text after `## Fork N` (often `— <question>`).
 * @param {string} sectionText
 * @returns {object}
 */
// Letter-family option start: "- **(x)**", "- (x)" (bold optional — plenty of older items bold only the
// DEFAULT option's label and leave sibling options unbolded, e.g. "- **(a)** …" beside a plain "- (b) …" —
// widened here so option (b) is recognized as its OWN option instead of silently swallowed as a
// continuation of (a)'s text), with an optional inline default/recommended marker inside the label's own
// parens — "(a · DEFAULT)" / "(a · RECOMMENDED)" — a real, if less common, recurring authoring convention.
// The inline label-marker's own trailing text varies ("(a · DEFAULT)", "(a — recommended, FLIPPED by the
// red-team)") — capture whatever sits between the separator and the closing paren (bounded, so it can't run
// away into the option's own body) and test IT for the marker word, rather than requiring an exact "DEFAULT"/
// "RECOMMENDED"-only match immediately before ")".
const LETTER_OPTION_RE = /^-\s*(\*\*)?\(([a-z])(?:\s*[·:—–-]\s*([^)]{0,60}))?\)(\*\*)?\s*(.*)$/i;
// A rarer variant with NO leading "- " at all — the option starts its own top-level paragraph directly with
// a bolded lettered label (e.g. backlog/2981: "**(a) Never split — status quo.** All judgment-shaped …").
// Bold is REQUIRED here (unlike the dash-bulleted form above, where it's optional) specifically to keep this
// narrow: every real no-dash instance in the corpus bolds the label, and requiring it avoids matching an
// unrelated line that merely opens with a bare "(a) …" parenthetical mid-prose.
const LETTER_OPTION_NO_DASH_RE = /^\*\*\(([a-z])(?:\s*[·:—–-]\s*([^)]{0,60}))?\)(\*\*)?\s*(.*)$/i;
// Number-family fallback (used only when NO letter-family bullet exists anywhere in the fork): "1. **Title**"
// / "2) **Title**" — a real, recurring alternate convention (e.g. backlog/3132, backlog/3136) for a fork
// whose options are enumerated rather than lettered. The bold title immediately after the number is
// required (not optional, unlike the letter family) specifically to keep this fallback narrow — an ordinary
// numbered prose list (e.g. inside a fork-existence paragraph) never bolds its very first word this way.
const NUMBER_OPTION_RE = /^(\d+)[.)]\s+(\*\*)(.*)$/;

/**
 * Match one line against an option-start pattern, returning the parsed pieces in a family-neutral shape, or
 * `null` when the line doesn't open a new option.
 * @param {string} line
 * @returns {{ label: string, bodyStart: string, forceDefault: boolean }|null}
 */
const LABEL_MARKER_WORD_RE = /\b(?:DEFAULT|RECOMMENDED)\b/i;

/** Strip fenced and inline code spans, so a literal "**" inside one (a glob like `we:scripts/**`) is never
 * mistaken for a markdown emphasis delimiter by a structural balance check. */
function stripCodeSpans(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

function matchLetterOptionDash(line) {
  const m = LETTER_OPTION_RE.exec(line);
  if (!m) return null;
  const [, boldOpen, letter, marker, boldCloseImmediate, rest] = m;
  // If the label's bold span was NOT closed immediately ("- **(a) title…" with no "**" right after the
  // letter), the "**" is still open going into the captured rest-of-line — re-add it so the eventual
  // closing "**" further into the option's own prose (the "…title.**" convention) pairs back up correctly
  // instead of reading as one stray, unmatched delimiter (see buildOption's bold-count check).
  const reopen = boldOpen && !boldCloseImmediate;
  return { label: letter.toLowerCase(), bodyStart: (reopen ? '**' : '') + rest, forceDefault: LABEL_MARKER_WORD_RE.test(marker || '') };
}
function matchLetterOptionNoDash(line) {
  const nd = LETTER_OPTION_NO_DASH_RE.exec(line);
  if (!nd) return null;
  const [, letter, marker, boldCloseImmediate, rest] = nd;
  return { label: letter.toLowerCase(), bodyStart: (boldCloseImmediate ? '' : '**') + rest, forceDefault: LABEL_MARKER_WORD_RE.test(marker || '') };
}
// Combined matcher for "does this line open a new option" — used ONLY at a paragraph's own first line (see
// `walkOptionParagraphs`), never for the within-paragraph bullet re-split: the no-dash form has no dash
// marker to distinguish it from an ordinary mid-sentence line a source's own soft-wrap happens to start with
// "**(c)**" (a REAL false positive hit during development — a wrapped cross-reference "…captured instead by
// **(c)** below…" was misread as opening a new option (c)). Bundling multiple options into one
// blank-line-free paragraph (backlog/3128's "(a)"/"(b)" pair) is a dash-bulleted-list convention only, so the
// within-paragraph re-split stays dash-only.
function matchLetterOption(line) {
  return matchLetterOptionDash(line) || matchLetterOptionNoDash(line);
}
function matchNumberOption(line) {
  const m = NUMBER_OPTION_RE.exec(line);
  if (!m) return null;
  const [, num, , rest] = m;
  return { label: num, bodyStart: `**${rest}`, forceDefault: false };
}

/**
 * Walk `paras` from `start`, building one option per `matchParaStart`-recognized paragraph. A bullet's OWN
 * content isn't always one blank-line-delimited paragraph — a fenced code sample or a nested sub-bullet
 * inside the option gets its own paragraph the moment a blank line surrounds it (docs/agent's own multi-code
 * shape, e.g. backlog/3055 Fork 2 option (a); backlog/3013's nested "Strongest case" sub-bullets) — so this
 * also absorbs every subsequent INDENTED paragraph (a markdown list item's own continuation) into the option
 * most recently opened. A column-0 paragraph that neither opens a new option nor continues one (the fork's
 * own "why (a)"/Skeptic/Screen/Default-crossref prose) ends the block — that's the real signal a *paragraph*
 * boundary alone can't give, since the fork's post-options commentary is itself just more top-level prose.
 * @param {string[]} paras
 * @param {number} start
 * @param {(line: string) => { label: string, bodyStart: string, forceDefault: boolean }|null} matchParaStart
 *   - tested ONLY against a paragraph's own first line, to decide whether the paragraph opens a new option.
 * @param {(line: string) => { label: string, bodyStart: string, forceDefault: boolean }|null} matchBundledLine
 *   - tested against EVERY line of an opening paragraph, to split several bundled options sharing one
 *   blank-line-free paragraph. Deliberately narrower than `matchParaStart` (see the two letter-family
 *   matchers above) — a form with no distinguishing marker (no leading dash) can't safely be re-tested
 *   mid-paragraph without risking a false hit on an ordinary wrapped line.
 * @returns {{ options: object[], cursor: number }}
 */
function walkOptionParagraphs(paras, start, matchParaStart, matchBundledLine) {
  const options = [];
  let currentLabel = null;
  let currentForceDefault = false;
  let currentBuf = [];
  const flush = () => {
    if (currentLabel) options.push(buildOption(currentLabel, tidy(currentBuf.join('\n')), currentForceDefault));
  };
  let cursor = start;
  while (cursor < paras.length) {
    const para = paras[cursor];
    const opensHere = matchParaStart(para.split('\n')[0]);
    const isIndentedContinuation = cursor > start && !opensHere && /^[ \t]/.test(para);
    if (!opensHere && !isIndentedContinuation) break;
    if (opensHere) {
      // The paragraph may hold SEVERAL option bullets back to back (no blank line between list items, e.g.
      // backlog/3128's "(a)"/"(b)" pair) — re-split it line by line.
      let first = true;
      for (const line of para.split('\n')) {
        const m = first ? opensHere : matchBundledLine(line);
        first = false;
        if (m) {
          flush();
          currentLabel = m.label;
          currentForceDefault = m.forceDefault;
          currentBuf = [m.bodyStart];
        } else {
          // A continuation line belongs to the option's own content, which starts two columns in (after
          // "- "/"N. "): strip up to that much indent so a nested bullet is read as a nested list, not an
          // over-indented line of the option's first paragraph.
          currentBuf.push(line.replace(/^ {1,2}/, ''));
        }
      }
    } else {
      currentBuf.push('', ...para.split('\n').map((l) => l.replace(/^ {1,2}/, '')));
    }
    cursor += 1;
  }
  flush();
  return { options, cursor };
}

export function parseForkSection(n, headingRest, sectionText) {
  const crux = headingRest.replace(/^[—-]\s*/, '').trim();
  const paras = splitParagraphsRaw(sectionText);

  // Find the first paragraph that STARTS with a lettered-option bullet: "- **(x)** …" (the canonical shape;
  // see `matchLetterOption` for the accepted variants). When NONE exists anywhere in the fork, fall back to
  // the number-family convention (see `matchNumberOption`) — used only then, so a fork that already commits
  // to lettered options is never re-read as numbered by accident.
  let optionsStart = -1;
  let matchParaStart = matchLetterOption;
  let matchBundledLine = matchLetterOptionDash;
  for (let i = 0; i < paras.length; i += 1) {
    if (matchLetterOption(paras[i].split('\n')[0])) { optionsStart = i; break; }
  }
  if (optionsStart === -1) {
    for (let i = 0; i < paras.length; i += 1) {
      if (matchNumberOption(paras[i].split('\n')[0])) {
        optionsStart = i; matchParaStart = matchNumberOption; matchBundledLine = matchNumberOption; break;
      }
    }
  }

  if (optionsStart === -1) {
    return {
      n, crux, why: paras.length ? tidy(paras[0]) : null, options: [], notes: [], skeptic: null, screen: null,
      parseOk: false, warning: `Fork ${n}: no lettered options ("- **(a)** …") found — cannot render a fork breakdown for this fork.`,
    };
  }

  // Everything before the first option bullet is the fork-existence justification (+ any extra framing paras).
  const beforeParas = paras.slice(0, optionsStart);
  const why = beforeParas.length ? beforeParas.map(tidy).join('\n\n') : null;

  const { options, cursor } = walkOptionParagraphs(paras, optionsStart, matchParaStart, matchBundledLine);

  // Remaining paragraphs: Skeptic / Screen lines, plus any real leftover context (notes) in between — kept
  // verbatim rather than dropped, since dropping real item content is its own kind of fabrication-by-omission.
  const rest = paras.slice(cursor);

  // A very common legacy default-marking convention (69+ instances across the corpus) states the default in
  // its OWN standalone paragraph after the option bullets — "**Default: (a).** <reasoning…>" or "**Recommended
  // default: (1)** …" (digit labels too, for the number-family fallback) — rather than marking the option
  // bullet itself ("← **RECOMMENDED**" / "[bold default]"). Cross-reference it against the options built
  // above; the paragraph stays in `notes` too (via the loop below) since it usually carries real supporting
  // reasoning, not just the label.
  const defaultDeclRe = /\*{0,2}(?:Recommended\s+)?Default:\*{0,2}\s*\(([a-z0-9]+)\)/i;
  for (const p of rest) {
    const dm = defaultDeclRe.exec(joinSoft(p));  // detection only — one flowing line
    if (!dm) continue;
    const opt = options.find((o) => o.label === `(${dm[1].toLowerCase()})`);
    if (opt && opt.kind !== OPTION_KINDS.REJECTED) opt.kind = OPTION_KINDS.DEFAULT;
  }

  // Sole-survivor-by-elimination: a prepared fork's options are exhaustive by construction, so once every
  // OTHER option is explicitly excluded ("Rejected"/"dominated"/…) and exactly one is left unmarked, that
  // survivor IS the fork's default — not a guess, a logical consequence of the exclusions the body already
  // states (e.g. backlog/3043 Fork 1: (a) "Rejected as the implementation shape…", (c) "Rejected as the
  // default, not as unreasonable…", (b) carries no marker of its own at all — it's the only one left).
  // Never fires with zero exclusions (an un-attacked, genuinely-open set of options stays un-resolved) or
  // with 2+ survivors (a real ambiguity the body hasn't settled — e.g. backlog/3123's four live options).
  if (!options.some((o) => o.kind === OPTION_KINDS.DEFAULT)) {
    const rejected = options.filter((o) => o.kind === OPTION_KINDS.REJECTED);
    const open = options.filter((o) => o.kind === OPTION_KINDS.OPEN);
    if (rejected.length >= 1 && open.length === 1) open[0].kind = OPTION_KINDS.DEFAULT;
  }

  let skeptic = null;
  let screen = null;
  const notes = [];
  const fenceRe = /^```(\S*)\n([\s\S]*?)\n?```$/;
  for (const p of rest) {
    // A paragraph that IS one fenced code block (a Fork 2-style "illustrative shape only" sketch) is kept as its
    // own `{ kind: 'code' }` note with the original multi-line text preserved. Every other note keeps its line
    // structure (`tidy`) and is rendered as markdown, so a fence with prose around it still renders as code.
    const fenceMatch = fenceRe.exec(p.trim());
    if (fenceMatch) { notes.push({ kind: 'code', text: fenceMatch[2] }); continue; }

    const verdicts = extractParagraphVerdicts(p);
    if (verdicts.skeptic !== null) skeptic = verdicts.skeptic;
    if (verdicts.screen !== null) screen = verdicts.screen;
    if (verdicts.leftover !== null) notes.push({ kind: 'text', text: verdicts.leftover });
  }

  const hasDefault = options.some((o) => o.kind === OPTION_KINDS.DEFAULT);
  // parseForkSection is only ever called for a `prepared: true` item (buildDecisionRecord gates it on
  // `base.prepared`) — and a prepared fork, by the docket's own definition, has already picked a default AND
  // stated why every alternative was excluded. Many legacy items rely entirely on that surrounding prose (no
  // literal "Rejected"/"REJECTED" marker on the non-default bullet at all — see e.g. backlog/2249's Fork 1,
  // backlog/2938's Fork 1(a)) rather than fabricating a marker that was never written. Once a default IS
  // identified, every other option in the SAME fork is — by construction, not by guess — the rejected
  // alternative; relabeling it OPEN (which SKILL.md reserves for a genuinely un-prepared fork shown for
  // transparency) would misrepresent it as still undecided.
  if (hasDefault) {
    for (const o of options) {
      if (o.kind === OPTION_KINDS.OPEN) o.kind = OPTION_KINDS.REJECTED;
    }
  }
  const warnings = [];
  if (!hasDefault && options.length) warnings.push(`Fork ${n}: no option marked RECOMMENDED — default could not be identified.`);
  if (!skeptic) warnings.push(`Fork ${n}: no "Skeptic:" verdict line found.`);
  // An odd count of "**" inside an option's own text means a bold span never closed within that option — the
  // classic tell of a legacy item whose sub-bullets (nested lists INSIDE one option's body, each with its own
  // bold markers) got flattened into one run-on line by the source's own soft wrapping. Rendering that produces
  // stray literal asterisks and mismatched emphasis — worse than showing nothing. Flag it structurally rather
  // than let a malformed render reach the page. Strip fenced/inline CODE first — a literal "**" inside one
  // (a glob like `we:scripts/**`, an exponent in a code sample) is not a markdown emphasis delimiter, and
  // counting it produced a false positive here (backlog/3049's option (a) cites `we:scripts/**` three times).
  if (options.some((o) => (stripCodeSpans(o.body).match(/\*\*/g) || []).length % 2 !== 0)) {
    warnings.push(`Fork ${n}: an option's text has an unclosed bold marker — likely a legacy item whose nested sub-bullets don't flatten cleanly.`);
  }

  return {
    n, crux, why, options, notes, skeptic, screen,
    parseOk: warnings.length === 0,
    warning: warnings.length ? warnings.join(' ') : null,
  };
}

/** A section's text as tidied markdown paragraphs joined by blank lines (block structure kept for the renderer). */
function sectionMarkdown(section) {
  return splitParagraphs(section?.text ?? '').map(tidy).join('\n\n');
}

/**
 * Parse a prepared VALIDATION-GATE decision's sections (docs/agent/backlog-workflow.md → "The prepared
 * validation-gate shape") into the docket's gate record. A gate is a one-sided go / no / not-yet call with no
 * rival branch, so it carries no `## Fork N`; its Definition of Ready is instead the digest's verdict, `## What
 * you're deciding`, an optional `## Context & prior-art delta`, and a `## Recommendation` that states the verdict
 * + a concrete un-gate trigger and closes with a `Skeptic:` line. Never throws — a gate with no
 * `## Recommendation`, or one with no `Skeptic:` verdict, comes back `parseOk: false` with a `warning` rather
 * than a fabricated stand-in.
 * @param {Array<{ heading: string|null, text: string }>} sections - every `## ` section of the item body.
 * @returns {{ deciding: string|null, priorArt: string|null, recommendation: string, skeptic: string|null,
 *   screen: string|null, parseOk: boolean, warning: string|null }|null} null when there is no `## Recommendation`.
 */
export function parseGateSections(sections) {
  const find = (re) => sections.find((s) => s.heading && re.test(s.heading));
  const recSection = find(/^Recommendation\b/i);
  if (!recSection) return null;

  const deciding = sectionMarkdown(find(/^What you(?:'|’| a)?re deciding|^What you are deciding/i)) || null;
  const priorArt = sectionMarkdown(find(/prior[- ]art/i)) || null;

  // The verdict lines are pulled out of the recommendation; every other paragraph (the verdict itself, the
  // un-gate trigger, any list or table) stays verbatim as markdown.
  let skeptic = null;
  let screen = null;
  const kept = [];
  for (const p of splitParagraphs(recSection.text)) {
    const verdicts = extractParagraphVerdicts(p);
    if (verdicts.skeptic !== null) skeptic = verdicts.skeptic;
    if (verdicts.screen !== null) screen = verdicts.screen;
    if (verdicts.leftover !== null) kept.push(verdicts.leftover);
  }

  const warning = skeptic ? null : 'Gate: no "Skeptic:" verdict line found under "## Recommendation".';
  return { deciding, priorArt, recommendation: kept.join('\n\n'), skeptic, screen, parseOk: !warning, warning };
}

/**
 * Parse a decision item's full markdown body (everything after the frontmatter) into the docket's clean data
 * shape: the digest paragraphs (before the first `##`, or a `## Digest` section when the item leads with one),
 * every `## Fork N` in source order — or, for an item with no forks, its validation-gate record — and the
 * acceptance-section bullets (used to derive "what happens once ratified" — never invented, always the item's own stated
 * done-when). PURE. Never throws.
 * @param {string} rawBody - the file content AFTER the `---` frontmatter fence, including the `# Title` line.
 * @returns {{ digest: string[], forks: object[], gate: object|null, doneWhen: string[], parseOk: boolean, warnings: string[] }}
 */
// A legacy/alternate fork heading some prepared decisions use: `### Fork A` — h3, LETTER-named instead of
// the canonical `## Fork N` (h2, numbered). A real recurring shape across the corpus (4 items, e.g.
// backlog/2544), not a one-off typo — accepted as an equivalent spelling ONLY as a fallback, when the body
// carries no canonical `## Fork N` at all: letter position maps directly to fork number (A→1, B→2, C→3…),
// same as if the author had written `## Fork 1`/`## Fork 2`/`## Fork 3`.
const LETTER_FORK_HEADING_RE = /^###\s+Fork\s+([A-Z])\b\s*(.*)$/;

/**
 * Fallback for the `### Fork [A-Z]` shape (see above): split the body into one section per h3 fork heading,
 * bounded by the next h2/h3 heading (whichever comes first) or the body's end. Returns `[]` when the body
 * carries no such heading.
 * @param {string} bodyAfterTitle
 * @returns {Array<{ letter: string, heading: string, text: string }>}
 */
function splitLetterForkSections(bodyAfterTitle) {
  const lines = String(bodyAfterTitle ?? '').split('\n');
  const sections = [];
  let current = null;
  const inFence = fenceTracker();
  for (const line of lines) {
    if (inFence(line)) { if (current) current.text.push(line); continue; }
    const m = LETTER_FORK_HEADING_RE.exec(line);
    if (m) {
      if (current) sections.push(current);
      current = { letter: m[1], heading: `Fork ${m[1]} ${m[2]}`.trim(), text: [] };
      continue;
    }
    if (/^#{2,3}\s+/.test(line)) {
      if (current) { sections.push(current); current = null; }
      continue;
    }
    if (current) current.text.push(line);
  }
  if (current) sections.push(current);
  return sections.map((s) => ({ ...s, text: s.text.join('\n') }));
}

// A single-fork item sometimes skips the number entirely — "## Fork" or "## The fork" (backlog/3114,
// backlog/3115) — since there's only one to number. Accepted as "Fork 1" ONLY as a last-resort fallback
// (no canonical `## Fork N`, no `### Fork [A-Z]`), and ONLY when exactly one such heading exists in the
// body — two or more would be a real ambiguity the item's own numbering left unresolved, not a case this
// fallback should silently guess an order for.
const BARE_FORK_HEADING_RE = /^(?:The\s+)?Fork\b(?!\s*\d)\s*(.*)$/i;

export function parseDecisionBody(rawBody) {
  // Strip leading blank lines first — a caller-stripped frontmatter fence often leaves one behind, and an
  // anchored `^#` title match must not be defeated by it.
  const text = String(rawBody ?? '').replace(/^\s+/, '');
  const titleMatch = /^#\s+.*(?:\n|$)/.exec(text);
  const afterTitle = titleMatch ? text.slice(titleMatch[0].length) : text;
  const sections = splitSections(afterTitle);

  // sections[0] (heading: null) is everything before the first "## " — the digest. A validation-gate item leads
  // with an explicit `## Digest` section instead (its shape's first heading), so fall back to that when the
  // pre-heading text is empty.
  let digest = splitParagraphs(sections[0]?.text ?? '').map(tidy);
  if (!digest.length) {
    const digestSection = sections.find((s) => s.heading && /^Digest\b/i.test(s.heading));
    if (digestSection) digest = splitParagraphs(digestSection.text).map(tidy);
  }

  let forkSections = sections.filter((s) => s.heading && /^Fork\s+\d+/i.test(s.heading));
  // Fallback 1: no canonical numbered fork heading anywhere — try the `### Fork [A-Z]` h3/letter shape.
  if (!forkSections.length) {
    forkSections = splitLetterForkSections(afterTitle).map((s) => ({
      heading: `Fork ${s.letter.charCodeAt(0) - 64} ${s.heading.replace(/^Fork\s+[A-Z]\s*/, '')}`.trim(),
      text: s.text,
    }));
  }
  // Fallback 2: still nothing — try a single bare "## Fork"/"## The fork" heading (no number at all,
  // because there's only one fork in the item). Only when there's EXACTLY one such heading; 2+ is a real
  // ambiguity this fallback leaves alone rather than guessing an order for.
  if (!forkSections.length) {
    const bare = sections.filter((s) => s.heading && BARE_FORK_HEADING_RE.test(s.heading));
    if (bare.length === 1) {
      const m = BARE_FORK_HEADING_RE.exec(bare[0].heading);
      forkSections = [{ heading: `Fork 1 ${m[1]}`.trim(), text: bare[0].text }];
    }
  }
  const warnings = [];
  const forks = forkSections.map((s, idx) => {
    const m = /^Fork\s+(\d+)\s*(.*)$/i.exec(s.heading);
    const n = m ? Number.parseInt(m[1], 10) : idx + 1;
    const rest = m ? m[2] : '';
    const parsed = parseForkSection(n, rest, s.text);
    if (parsed.warning) warnings.push(parsed.warning);
    return parsed;
  });

  // The acceptance section, by the shared task-agreement reader's heading rule (canonical or legacy alias, #5399 S7).
  const doneSection = sections.find((s) => s.heading && ACCEPTANCE_HEADING_RE.test(s.heading));
  const doneWhen = doneSection ? splitNumberedList(doneSection.text) : [];

  // No forks: the item may be a validation gate (a one-sided go / no / not-yet call — no `## Fork N` by design).
  const gate = forks.length ? null : parseGateSections(sections);
  if (gate) {
    if (gate.warning) warnings.push(gate.warning);
  } else if (!forks.length) {
    warnings.push('No "## Fork N" sections found in the body.');
  }

  return { digest, forks, gate, doneWhen, parseOk: warnings.length === 0, warnings };
}

/**
 * Compute an item's age in whole days from `dateOpened` to `now`. Never throws on a malformed date (returns 0).
 * @param {string} dateOpened - ISO date string.
 * @param {Date} [now]
 * @returns {number}
 */
export function ageDays(dateOpened, now = new Date()) {
  const opened = new Date(dateOpened);
  if (Number.isNaN(opened.getTime())) return 0;
  const ms = now.getTime() - opened.getTime();
  return Math.max(0, Math.round(ms / 86_400_000));
}

/**
 * Build ONE decision record for the docket JSON from a `suggest-next`/`check:readiness` ranked entry plus the
 * item's raw file text (frontmatter + body). PURE. Never throws — a body that fails to parse still yields a
 * record (with `prepared: true` but `forks: []` and `parseOk: false`), so the caller can render an honest
 * "parse incomplete" card rather than silently dropping the item or fabricating its content.
 * @param {object} rankedEntry - one entry from `check:readiness --select --json`'s `selection.tierB` (or its
 *   `inReview` list, which adds `prs` — every open PR landing the item — and `blockedBy`).
 * @param {string|null} fileText - the full raw markdown file (frontmatter + body), or null if unavailable.
 * @param {Date} [now]
 * @returns {object}
 */
export function buildDecisionRecord(rankedEntry, fileText, now = new Date()) {
  const base = {
    num: String(rankedEntry.num),
    title: rankedEntry.title,
    prepared: !!rankedEntry.prepared,
    preparedDate: rankedEntry.preparedDate ?? null,
    leverageScore: rankedEntry.leverageScore ?? 0,
    directUnblocks: rankedEntry.directUnblocks ?? 0,
    transitiveUnblocks: rankedEntry.transitiveUnblocks ?? 0,
    unblocksToReady: rankedEntry.unblocksToReady ?? 0,
    // Set only for a decision with an OPEN pull request (the docket's "In review" section): the PR it is listed
    // under, and any still-open blockers (a blocked decision with a PR is listed too, saying what blocks it).
    pr: pickPr(rankedEntry.num, rankedEntry.prs),
    blockedBy: (rankedEntry.blockedBy ?? []).map(String),
  };

  if (!fileText) {
    return {
      ...base, dateOpened: null, ageInDays: 0, digest: [], forks: [], gate: null, doneWhen: [],
      parseOk: false, warnings: ['Source file not found for this item — rendered from ranking data only.'],
    };
  }

  const fmMatch = /^---\n([\s\S]*?)\n---\n?/.exec(fileText);
  const frontmatter = fmMatch ? fmMatch[1] : '';
  const body = fmMatch ? fileText.slice(fmMatch[0].length) : fileText;
  const dateOpenedMatch = /^dateOpened:\s*"?([\d-]+)"?/m.exec(frontmatter);
  const dateOpened = dateOpenedMatch ? dateOpenedMatch[1] : null;

  const parsed = base.prepared
    ? parseDecisionBody(body)
    : { digest: [], forks: [], gate: null, doneWhen: [], parseOk: true, warnings: [] };

  return {
    ...base,
    dateOpened,
    ageInDays: dateOpened ? ageDays(dateOpened, now) : 0,
    digest: parsed.digest,
    forks: parsed.forks,
    gate: parsed.gate,
    doneWhen: parsed.doneWhen,
    parseOk: parsed.parseOk,
    warnings: parsed.warnings,
  };
}
