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

/** Read sections outside fences, then normalize only the first selected section of each kind. */
export function readTaskAgreement(body) {
  const result = { acceptance: [], nonGoals: [], legacy: false, draft: false, problems: [] };
  const problem = (code, section, detail) => result.problems.push({ code, section, detail });
  const text = (typeof body === 'string' ? body : '').replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
  const sections = { canonical: [], legacy: [], nonGoals: [] };
  let current = null, fence = null;
  for (const line of text.split(/\r?\n/)) {
    const fm = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length && !fm[2].trim()) fence = null;
      continue;
    }
    if (fm) { fence = fm[1]; current?.push(''); continue; }
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
  result.legacy = !sections.canonical.length && !!sections.legacy.length;
  for (const [section, groups, output, prefix] of [
    ['acceptance', [...sections.canonical, ...sections.legacy], 'acceptance', 'A'],
    ['non-goals', sections.nonGoals, 'nonGoals', 'N'],
  ]) {
    if (!groups.length) { problem(`${section}-missing`, section, 'Section is absent.'); continue; }
    for (let i = 1; i < groups.length; i++) problem('duplicate-section', section, 'First canonical section wins.');
    const items = [], paragraphs = [];
    let active = null, paragraph = [];
    const flushParagraph = () => {
      if (paragraph.length) paragraphs.push({ id: null, text: paragraph.join(' ') });
      paragraph = [];
    };
    for (const line of groups[0]) {
      const trimmed = line.trim();
      if (/^<!--.*-->$/.test(trimmed) || /^Hint:/.test(trimmed)) continue;
      if (!trimmed || /^#{3,6}[ \t]+/.test(line)) { active = null; flushParagraph(); continue; }
      const item = /^ {0,3}(?:[-*+]|\d+[.)])[ \t]+(?:\[([AN]\d+)\][ \t]*)?(.*)$/i.exec(line);
      if (item) {
        flushParagraph();
        active = { id: item[1]?.toUpperCase() ?? null, text: item[2].trim() };
        items.push(active);
      } else if (active && /^ {2,}/.test(line) && !/^\s*(?:[-*+]|\d+[.)])[ \t]+/.test(line)) {
        active.text += ` ${trimmed}`;
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
