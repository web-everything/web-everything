/**
 * @file scripts/backlog/task-agreement.mjs
 * @description #5399 — ONE reader and skeleton for a card's Acceptance + Non-goals agreement,
 * so authoring and dispatch gates share canonical headings, legacy aliases and draft semantics.
 * PURE: no filesystem or clock; malformed input produces problems, never throws.
 */

/**
 * The card format (operator ruling F3, 2026-10-08). Each section is a list of numbered items so a reviewer or a
 * gate can cite one by id:
 *
 *   ## Acceptance
 *
 *   - [A1] **Executable** — `npm run test:unit -- x.test.mjs` fails before and passes after.
 *
 *   ## Non-goals
 *
 *   - [N1] Backfilling resolved cards.        (or `- [N1] n/a: <why>` when nothing is excluded)
 *
 * The legacy `## Done when` heading reads as Acceptance during migration (`legacy: true`, positional ids A1..An).
 */
export const ACCEPTANCE_HEADING = '## Acceptance';
export const NON_GOALS_HEADING = '## Non-goals';
/** On its own line directly under either heading: the section was machine-drafted (the one-off refresh of open
 *  stories) and no author or preparer has confirmed it yet. The reader reports it as `draft: true`. */
export const AGREEMENT_DRAFT_MARKER = '<!-- agreement: draft -->';
/** Matches the TEXT of a level-2 heading (after `## `). Gates import it so `## Acceptance` and the legacy
 *  `## Done when` stay one rule. */
export const ACCEPTANCE_HEADING_RE = /^(?:acceptance|done when)\b/i;
export const NON_GOALS_HEADING_RE = /^non-goals?\b/i;
/** The gate setting lives in TASK_AGREEMENT_POLICY_PATH: `advise` warns only, `enforce` lets the prepare/dispatch
 *  gate hold a card whose agreement is missing. */
export const TASK_AGREEMENT_MODES = Object.freeze(['advise', 'enforce']);
export const DEFAULT_TASK_AGREEMENT_MODE = 'advise';
export const TASK_AGREEMENT_POLICY_PATH = 'scripts/lib/task-agreement-policy.json';

/** Validate the shared setting without loading it or silently accepting misspelled keys. */
export function validateTaskAgreementPolicy(policy) {
  try {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(policy))) {
      return ['Task agreement policy must be a plain object.'];
    }
    const problems = [];
    if (!TASK_AGREEMENT_MODES.includes(policy.mode)) problems.push('mode must be advise or enforce.');
    for (const key of Reflect.ownKeys(policy)) {
      if (key !== 'mode' && key !== '$comment') problems.push(`Unknown policy key: ${String(key)}`);
    }
    return problems;
  } catch {
    return ['Task agreement policy could not be read.'];
  }
}

/** The numbered placeholders remain visibly unfinished until the author supplies the agreement. */
export function renderTaskAgreementSkeleton() {
  return `${ACCEPTANCE_HEADING}\n\n- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.\n\n${NON_GOALS_HEADING}\n\n- [N1] TODO: what this item deliberately does not do — or \`n/a: <why>\` when nothing is excluded.\n`;
}

/** Whether an HTML comment is still open at the END of `line`, given whether one was open at its start. Scanned by
 *  state, not by regex (a comment may span lines — CodeQL js/bad-tag-filter), and shared by both passes so a
 *  heading hidden in a comment can never be read as a section in one pass and skipped in the other.
 *  A comment OPENS only where a line starts with `<!--` (a CommonMark HTML block), so a `<!--` quoted in prose or
 *  in backticks never swallows the rest of the card; once open it closes at the first `-->`. `<!-->` is an empty
 *  comment, already closed. */
function commentOpenAfter(line, open) {
  if (open) return !line.includes('-->');
  const start = line.trimStart();
  return start.startsWith('<!--') && !start.includes('-->', 2);
}

/** Every level-2 heading OUTSIDE code fences and HTML comments, in order, as `{ title, index, end }` — `index` is
 *  the offset of the heading line and `end` the offset just past it (before its newline). One scan for the gates
 *  that cut a card at its acceptance section (codex-worker, the orphan sweep), so a `## Acceptance` quoted in a
 *  fenced example or a commented-out draft is not mistaken for the real one. Line endings may be LF or CRLF. */
export function findLevel2Headings(text) {
  const found = [];
  let fence = null, inComment = false, at = 0;
  const source = typeof text === 'string' ? text : '';
  while (at <= source.length) {
    const nl = source.indexOf('\n', at);
    const lineEnd = nl === -1 ? source.length : nl;
    const line = source.slice(at, lineEnd).replace(/\r$/, '');
    if (inComment) inComment = commentOpenAfter(line, true);
    else {
      const fm = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length && !fm[2].trim()) fence = null;
      } else if (fm) fence = fm[1];
      else {
        inComment = commentOpenAfter(line, false);
        const heading = /^##[ \t]+(.*)$/.exec(line);
        if (heading) found.push({ title: heading[1].trim(), index: at, end: at + line.length });
      }
    }
    if (nl === -1) break;
    at = nl + 1;
  }
  return found;
}

/** Leading whitespace width of a line, a tab counting as four columns. */
const indentOf = (line) => /^[ \t]*/.exec(line)[0].replace(/\t/g, '    ').length;

/** Read sections outside fences and comments, then normalize only the first selected section of each kind. */
export function readTaskAgreement(body) {
  const result = { acceptance: [], nonGoals: [], legacy: false, draft: false, problems: [] };
  const problem = (code, section, detail) => result.problems.push({ code, section, detail });
  const text = (typeof body === 'string' ? body : '').replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
  const sections = { canonical: [], legacy: [], nonGoals: [] };
  let current = null, fence = null, inComment = false;
  for (const line of text.split(/\r?\n/)) {
    // A line inside a comment is never a fence or a heading; the section keeps it so pass 2 skips it too.
    if (inComment) { inComment = commentOpenAfter(line, true); current?.push(line); continue; }
    const fm = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length && !fm[2].trim()) fence = null;
      continue;
    }
    if (fm) { fence = fm[1]; current?.push(''); continue; }
    inComment = commentOpenAfter(line, false);
    const heading = /^(#{1,2})[ \t]+(.*)$/.exec(line);
    if (heading) {
      current = null;
      if (heading[1] === '##') {
        const title = heading[2].trim();
        const kind = /^acceptance\b/i.test(title) ? 'canonical'
          : /^done when\b/i.test(title) ? 'legacy'
            : NON_GOALS_HEADING_RE.test(title) ? 'nonGoals' : null;
        if (kind) { current = []; sections[kind].push(current); }
      }
      continue;
    }
    if (current && line.trim() === AGREEMENT_DRAFT_MARKER) result.draft = true;
    current?.push(line);
  }
  if (inComment) problem('unterminated-comment', 'agreement', 'An HTML comment is never closed, so everything after it was skipped.');
  result.legacy = !sections.canonical.length && !!sections.legacy.length;
  for (const [section, groups, output, prefix] of [
    ['acceptance', [...sections.canonical, ...sections.legacy], 'acceptance', 'A'],
    ['non-goals', sections.nonGoals, 'nonGoals', 'N'],
  ]) {
    if (!groups.length) { problem(`${section}-missing`, section, 'Section is absent.'); continue; }
    for (let i = 1; i < groups.length; i++) problem('duplicate-section', section, 'First canonical section wins.');
    const items = [], paragraphs = [];
    let active = null, paragraph = [], inComment = false;
    const flushParagraph = () => {
      if (paragraph.length) paragraphs.push({ id: null, text: paragraph.join(' ') });
      paragraph = [];
    };
    for (const line of groups[0]) {
      const trimmed = line.trim();
      // HTML comments are skipped by state (see commentOpenAfter): pass 1 already kept their headings out of sections.
      if (inComment) { inComment = commentOpenAfter(line, true); continue; }
      const open = commentOpenAfter(line, false);
      if (trimmed.startsWith('<!--') && (open || trimmed.endsWith('-->'))) { inComment = open; continue; }
      inComment = open;
      if (/^Hint:/.test(trimmed)) continue;
      // A blank line keeps the item open: a loose list continues under it. A sub-heading closes it.
      if (!trimmed) { flushParagraph(); continue; }
      if (/^#{3,6}[ \t]+/.test(line)) { active = null; flushParagraph(); continue; }
      const indent = indentOf(line);
      // Anything indented two or more columns past the open item's marker belongs to that item — a wrapped line or
      // a nested bullet alike, at any depth — never a new item of its own.
      // A nested bullet that carries its own `[A2]` / `[N2]` id stays a separate, citable item.
      const numbered = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[[AN]\d+\]/i.test(line);
      if (active && indent >= active.indent + 2 && !numbered) { active.text += ` ${trimmed}`; continue; }
      const item = (indent <= 3 || numbered) && /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[([AN]\d+)\][ \t]*)?(.*)$/i.exec(line);
      if (item) {
        flushParagraph();
        active = { id: item[1]?.toUpperCase() ?? null, text: item[2].trim(), indent };
        items.push(active);
      } else {
        active = null;
        paragraph.push(trimmed);
      }
    }
    flushParagraph();
    const legacy = section === 'acceptance' && result.legacy;
    if (!items.length && paragraphs.length && !legacy) problem(`${section}-not-a-list`, section, 'Expected list items, found prose.');
    const candidates = !items.length && legacy ? paragraphs : items;
    const seen = new Set();
    for (const item of candidates) {
      if (/\bTODO\b/.test(item.text)) { problem(`${section}-todo`, section, item.text); continue; }
      if (section === 'non-goals' && /^(?:(?:none|n\/a|na|nothing)\.?|n\/a:\s*)$/i.test(item.text)) {
        problem('non-goals-bare-none', section, item.text); continue;
      }
      const positional = `${prefix}${result[output].length + 1}`;
      const id = legacy ? positional : item.id ?? positional;
      if (!legacy) {
        if (!item.id) problem('missing-id', section, item.text);
        else if (!id.startsWith(prefix)) problem('wrong-id-prefix', section, id);
        if (seen.has(id)) problem('duplicate-id', section, id);
      }
      seen.add(id);
      result[output].push({ id, text: item.text });
    }
    if (!result[output].length) problem(`${section}-empty`, section, 'Section has no kept items.');
  }
  return result;
}
