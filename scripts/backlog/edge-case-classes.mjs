/**
 * @file scripts/backlog/edge-case-classes.mjs
 * @description The seven edge-case classes every card and prepare must answer (opus perf sweep 2026-10-07,
 * section 3 cause 1: "the checklist lacked the requirement" was the largest review-round cause, 112 findings /
 * 872 min over 48 h). ONE source: the card skeleton (`scaffold.mjs`), the coroner's `prep.checklistClasses`
 * (`scripts/operations/coroner-rounds.mjs`) and the brief-consistency test all read this list, so the briefs and
 * the template cannot drift apart. PURE.
 */

/** Heading of the section a card carries. */
export const EDGE_CASES_HEADING = '## Edge cases this change must handle';

/**
 * `id` is stable (coroner keys); `label` is the bold name used in cards and briefs; `ask` is the one-line prompt;
 * `helpers` points at the shared helper a builder should reuse instead of re-inventing it.
 */
export const EDGE_CASE_CLASSES = Object.freeze([
  { id: 'untrusted-text', label: 'Untrusted text',
    ask: 'any LLM, PR, comment, card or CLI text that reaches a note, a shell, argv, a path or a regex: fold newlines and backticks, never let a value starting with `--` reach argv, NFKC and invisible characters',
    helpers: '`foldUntrusted` (we:scripts/lib/jury-core.mjs)' },
  { id: 'truncated-reads', label: 'Truncated reads',
    ask: 'every `gh`/`git` read: full pages, `maxBuffer`, and a `--limit` hit is an error, never "none"',
    helpers: '`readCompletePrComments` (we:scripts/conveyor/pr-comments-complete.mjs), `proc-read.mjs`' },
  { id: 'shared-state-files', label: 'Shared state files',
    ask: 'two writers at once: atomic write plus lock, compare-and-set on re-read, stale-lock steal only under a guard',
    helpers: '`writeJsonAtomic` and `withFileLock` (we:scripts/lib/atomic-json-file.mjs)' },
  { id: 'fail-closed', label: 'Fail closed',
    ask: 'a failed read, parse or spawn is never empty, `[]`, "not stamped" or "no PR"; name the refusal reason',
    helpers: '' },
  { id: 'identity-scoping', label: 'Identity scoping',
    ask: 'every key is scoped by repo + number + head sha / session id; hash and NNN spellings both resolve',
    helpers: '' },
  { id: 'state-over-time', label: 'State over time',
    ask: 'old records after a new head, repeat suppression across ticks, TTL and clock skew, and what happens on restart mid-operation',
    helpers: '' },
  { id: 'who-wrote-it', label: 'Who wrote it',
    ask: 'any comment, ref, label or job name that grants trust: check the author or source, not just the name',
    helpers: '' },
]);

/** The skeleton block `renderItem` emits: one `TODO` line per class, each to become the handling or `n/a: <why>`. */
export function renderEdgeCasesSkeleton() {
  const lines = EDGE_CASE_CLASSES.map((c, i) => `${i + 1}. **${c.label}** — TODO: the handling, or n/a: <why>.`);
  return `${EDGE_CASES_HEADING}\n\nOne line per class: either the handling, or \`n/a: <why>\`.\n\n${lines.join('\n')}\n`;
}

/**
 * Markdown lines with the fence state of each: `[{line, fenced}]`. A fence opens on a line of 3+ backticks or tildes (up to
 * three spaces of indent, any info string) and closes on a line of the same character, at least as long, with nothing
 * after it. An unterminated fence runs to the end of the text. `\r\n` and `\n` both split.
 */
function fencedLines(text) {
  const out = [];
  let open = null; // { ch, len }
  let inComment = false; // inside a multi-line `<!-- ... -->`: a `# old` line there is no heading either
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (inComment) {
      out.push({ line, fenced: true });
      if (line.includes('-->')) inComment = false;
      continue;
    }
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open === null) {
      out.push({ line, fenced: false });
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) open = { ch: m[1][0], len: m[1].length };
      else if (line.lastIndexOf('<!--') > line.lastIndexOf('-->')) inComment = true;
    } else {
      out.push({ line, fenced: true });
      if (m && m[1][0] === open.ch && m[1].length >= open.len && m[2].trim() === '') open = null;
    }
  }
  return out;
}

/**
 * The text of `text` up to the next level-1 or level-2 heading that is NOT inside a code fence. A `# comment` line in a
 * fenced shell block is a comment, not a heading. Joined with `\n`.
 */
export function untilNextHeading(text) {
  const kept = [];
  for (const { line, fenced } of fencedLines(text)) {
    if (!fenced && /^#{1,2}(?:\s|$)/.test(line)) break;
    kept.push(line);
  }
  return kept.join('\n');
}

/** Index (in lines) of the first line outside a fence that matches `re`, or `-1`. Same fence rules as {@link untilNextHeading}. */
export function indexOfUnfencedLine(text, re) {
  const lines = fencedLines(text);
  return lines.findIndex(({ line, fenced }) => !fenced && re.test(line));
}

/**
 * The classes a card body has NOT answered: the class label is absent from the edge-cases section, or only on an
 * unfilled `TODO` line. Pure; every class when the section is absent.
 */
export function unansweredEdgeCaseClasses(body) {
  const text = String(body ?? '');
  // The heading is a line outside any fence: the same words quoted in a code block are not the section. Up to three spaces
  // of indent and any depth of `#` from two up still read as the heading (as `indexOf` did before it was fence-aware).
  const at = indexOfUnfencedLine(text, new RegExp(`^ {0,3}#{2,}[ \\t]+${EDGE_CASES_HEADING.replace(/^#+\s+/, '')}`));
  if (at < 0) return [...EDGE_CASE_CLASSES];
  const section = untilNextHeading(text.split(/\r?\n/).slice(at + 1).join('\n'));
  const lines = section.split('\n');
  return EDGE_CASE_CLASSES.filter((c) => !lines.some((l) => l.toLowerCase().includes(c.label.toLowerCase()) && !/\bTODO\b/.test(l)));
}

/**
 * How many of the seven classes a card body answers: the class label appears on a line of the edge-cases section
 * that is not an unfilled `TODO`. Pure; `0` when the section is absent.
 */
export function countEdgeCaseClasses(body) {
  return EDGE_CASE_CLASSES.length - unansweredEdgeCaseClasses(body).length;
}
