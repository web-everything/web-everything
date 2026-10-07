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
 * How many of the seven classes a card body answers: the class label appears on a line of the edge-cases section
 * that is not an unfilled `TODO`. Pure; `0` when the section is absent.
 */
export function countEdgeCaseClasses(body) {
  const at = String(body ?? '').indexOf(EDGE_CASES_HEADING);
  if (at < 0) return 0;
  const section = body.slice(at + EDGE_CASES_HEADING.length).split(/^#{1,2}\s/m)[0];
  const lines = section.split('\n');
  return EDGE_CASE_CLASSES.filter((c) => lines.some((l) => l.toLowerCase().includes(c.label.toLowerCase()) && !/\bTODO\b/.test(l))).length;
}
