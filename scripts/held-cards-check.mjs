/**
 * @file scripts/held-cards-check.mjs
 * @description PURE, HEURISTIC staleness check for the operator's held list. Per held item it pulls the named
 *   paths, backticked symbols, #PR numbers and slice names (S10) out of the free text (`extractRefs`), and turns
 *   evidence gathered from origin/main into a verdict (`assessItem`): likely-done, partly-done or not-started.
 *   It is a guess to run BEFORE dispatching a held item, never a ruling, and it never edits the list.
 *   The impure evidence gathering lives in `we:scripts/held-cards-io.mjs` (`check`).
 */

const TRAILING = /[.,;:)\]]+$/;
const STOP = new Set(('the and for with that this from into only when then than does not are was were has have had but all any '
  + 'can its via per one two out off use used using held item fix make makes made new add adds also each both '
  + 'not never now must should would could may will size scope').split(' '));

/** Crude word stem so `filing`, `filers` and `file` compare equal. */
export function stem(word) {
  return word.toLowerCase().replace(/(?:ing|ers|er|ed|es|s)$/, '').replace(/e$/, '');
}

/** The distinct, meaningful word stems of some text. */
export function wordStems(text) {
  const out = new Set();
  for (const word of String(text).toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []) {
    if (!STOP.has(word)) out.add(stem(word));
  }
  out.delete('');
  return out;
}

/** Named paths (`we:` prefix dropped; `:line` dropped), backticked or camelCase symbols, #PR numbers, slice names. */
export function extractRefs(text) {
  const body = String(text).replace(/<!--.*?-->/gs, '');
  const paths = new Set();
  for (const m of body.matchAll(/(?:\bwe:)?((?:scripts|skills-src|docs|backlog|standards|tests|\.claude)\/[\w./<>*@-]*[\w>*])(?::\d+)?/g)) {
    paths.add(m[1].replace(TRAILING, ''));
  }
  const bare = new Set();
  for (const m of body.matchAll(/(?<![\w/.-])([\w-]+\.(?:mjs|js|ts|md|json))(?::\d+)?\b/g)) {
    if (![...paths].some(p => p.endsWith(`/${m[1]}`))) bare.add(m[1]);
  }
  const symbols = new Set();
  for (const m of body.matchAll(/`([^`\n]+)`/g)) {
    const name = m[1].trim().replace(/\(\)$/, '');
    if (/^[A-Za-z_$][\w$]{3,}$/.test(name)) symbols.add(name);
  }
  for (const m of body.matchAll(/\b([a-z]+(?:[A-Z][a-z0-9]+)+)\b/g)) symbols.add(m[1]);
  const prs = new Set([...body.matchAll(/(?<![\w&])#(\d{3,5})\b/g)].map(m => Number(m[1])));
  const slices = new Set([...body.matchAll(/\bS(\d{1,2})\b/g)].map(m => `S${m[1]}`));
  return { paths: [...paths], bareFiles: [...bare], symbols: [...symbols], prs: [...prs], slices: [...slices] };
}

/** Does this merged PR (title/body) name held item `num`? Returns a short reason or null. */
export function prMentionsItem(num, pr) {
  const title = pr.title ?? '', body = pr.body ?? '';
  const n = String(num);
  if (new RegExp(`^(?:card|item)\\s+${n}\\b`, 'i').test(title)) return `title "${title.slice(0, 60)}"`;
  if (new RegExp(`^${n}[a-z]?\\s*[:)]`).test(title)) return `title "${title.slice(0, 60)}"`;
  const ref = new RegExp(`\\b(?:held[- ](?:item|card)|items?|cards?)s?\\s*#?(?:\\d+\\s*[,–-]\\s*)*${n}\\b`
    + `|\\b(?:items?|cards?)\\s+(\\d+)\\s*[–-]\\s*(\\d+)`, 'ig');
  for (const text of [title, body]) {
    for (const m of text.matchAll(ref)) {
      if (m[1] ? num >= Number(m[1]) && num <= Number(m[2]) : true) return `${text === title ? 'title' : 'body'} "${m[0]}"`;
    }
  }
  return null;
}

/** Slice names (S5) of item `num` that merged PR titles like "Card 89 S5: ..." report as done. */
export function mergedSlices(num, prs) {
  const done = new Map();
  for (const pr of prs) {
    const m = new RegExp(`^(?:card|item)\\s+${num}\\s+(S\\d+)\\b`, 'i').exec(pr.title ?? '');
    if (m) done.set(m[1].toUpperCase(), pr.number);
  }
  return done;
}

/** Shared word stems between an item's text and a commit/PR subject. */
export function overlap(itemStems, subject) {
  return [...wordStems(subject)].filter(s => itemStems.has(s));
}

export const OVERLAP_MIN = 3;
/** Word overlap that counts as a strong echo alone; 3-4 words count only when the commit also cites a PR the item cites. */
export const OVERLAP_STRONG = 8;
const SLICE_TITLE = /^(?:card|item)\s+\d+\s+S\d+/i;

/**
 * @param {object} item `{ num, title, text }` from parseHeldCards
 * @param {object} ev evidence from origin/main:
 *   paths [{path, exists}], symbols [{name, found}], prs [{number, state}], mentions [{number, title, why}],
 *   slicesDone Map<string, number>, commits [{path, subject, shared:[...]}]
 */
export function assessItem(item, refs, ev) {
  const evidence = [];
  const foundPaths = ev.paths.filter(p => p.exists), lostPaths = ev.paths.filter(p => !p.exists);
  const foundSyms = ev.symbols.filter(s => s.found), lostSyms = ev.symbols.filter(s => !s.found);
  if (ev.mentions.length) evidence.push(`merged PR names item ${item.num}: ${ev.mentions.slice(0, 3).map(m => `#${m.number} (${m.why})`).join('; ')}`);
  const named = refs.slices, doneSlices = named.filter(s => ev.slicesDone.has(s));
  if (ev.slicesDone.size) evidence.push(`merged slices: ${[...ev.slicesDone].map(([s, n]) => `${s}=#${n}`).join(', ')}`);
  if (ev.commits.length) evidence.push(`commits on its paths echo its text: ${ev.commits.slice(0, 2).map(c => `"${c.subject.slice(0, 60)}" [${c.shared.join(',')}]`).join('; ')}`);
  if (ev.prs.length) evidence.push(`cited PRs: ${ev.prs.map(p => `#${p.number} ${p.state}`).join(', ')}`);
  if (ev.symbols.length) evidence.push(`symbols on main: ${foundSyms.length}/${ev.symbols.length}${lostSyms.length ? ` (missing: ${lostSyms.slice(0, 4).map(s => s.name).join(', ')})` : ''}`);
  if (ev.paths.length) evidence.push(`paths on main: ${foundPaths.length}/${ev.paths.length}${lostPaths.length ? ` (missing: ${lostPaths.slice(0, 3).map(p => p.path).join(', ')})` : ''}`);

  const sliceGap = ev.slicesDone.size > 0 && (named.length === 0 || doneSlices.length < named.length);
  // Only a title naming the item (not a slice title, not a mere body mention) is a strong claim that it is done.
  const strongMentions = ev.mentions.filter(m => m.why.startsWith('title') && !SLICE_TITLE.test(m.title));
  const strong = strongMentions.length > 0 || ev.commits.some(c => c.strong) || (ev.slicesDone.size > 0 && !sliceGap);
  let verdict;
  if (strong && !sliceGap) verdict = 'likely-done';
  else if (strong || ev.slicesDone.size || ev.mentions.length || ev.commits.length || (foundSyms.length && lostSyms.length)) verdict = 'partly-done';
  else verdict = 'not-started';
  if (!evidence.length) evidence.push('no named paths, symbols or PRs found; nothing to check');
  return { num: item.num, title: item.title, verdict, evidence };
}

export const HEURISTIC_NOTE = 'HEURISTIC, read-only: guesses from item text vs origin/main. Confirm before skipping an item; never edits the held list.';
