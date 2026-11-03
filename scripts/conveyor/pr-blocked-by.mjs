/** R437: report-only PR dependency edges. Only explicit body trailers and current tooling refusals declare edges; no IO. */
import MarkdownIt from 'markdown-it';
import { currentToolingRefusals, prKey } from './pr-sweep-core.mjs';
const markdown = new MarkdownIt();
/** Mask backtick spans without joining source lines or manufacturing trailer text.
 * Equal-length runs close a span; an unmatched opener masks the rest of its paragraph.
 */
function maskInlineCode(text) {
  const mask = value => value.replace(/[^\n]/g, '\u0000');
  let clean = '', cursor = 0, delimiter = null;
  for (const run of text.matchAll(/`+/g)) {
    if (delimiter === null) {
      // Outside code, a backslash escapes only the first backtick in a run.
      const escapes = text.slice(0, run.index).match(/\\+$/)?.[0].length ?? 0;
      const escaped = escapes % 2;
      const length = run[0].length - escaped;
      if (!length) continue;
      clean += text.slice(cursor, run.index + escaped) + mask(run[0].slice(escaped));
      delimiter = length;
    } else {
      clean += mask(text.slice(cursor, run.index + run[0].length));
      if (run[0].length === delimiter) delimiter = null;
    }
    cursor = run.index + run[0].length;
  }
  return clean + (delimiter === null ? text.slice(cursor) : mask(text.slice(cursor)));
}
/** Read literal trailer lines in unquoted Markdown paragraphs; code never declares edges. */
function trailers(text, key) {
  const body = String(text ?? '').replace(/\r\n?/g, '\n');
  const lines = body.split('\n'), refs = [];
  let quoteDepth = 0;
  for (const token of markdown.parse(body, {})) {
    if (token.type === 'blockquote_open') quoteDepth++;
    else if (token.type === 'blockquote_close') quoteDepth--;
    else if (token.type === 'inline' && quoteDepth === 0 && token.map) {
      for (const line of maskInlineCode(lines.slice(...token.map).join('\n')).split('\n')) {
        const list = line.match(new RegExp(`^ {0,3}${key}:[ \t]*(#[1-9]\\d*(?:[ \t,]+#[1-9]\\d*)*)[ \t]*$`, 'i'))?.[1];
        if (list) refs.push(...[...list.matchAll(/#([1-9]\d*)/g)].map(m => Number(m[1])).filter(Number.isSafeInteger));
      }
    }
  }
  return [...new Set(refs)];
}
export function parseBlockedBy(text) { return trailers(text, 'blocked-by'); }
export function parseUnblocks(text) { return trailers(text, 'unblocks'); }
/** Inputs are the current open-PR listing for ONE repository (state may be omitted).
 * Textual references alone never confirm a live blocker; closed, merged and absent targets do not block.
 */
export function buildBlockedMap(prs, { now, settings = {}, owners = {} } = {}) {
  const blockedBy = new Map(), unblocks = new Map();
  const openPrs = prs.filter(pr => pr.state === undefined || (typeof pr.state === 'string' && pr.state.toUpperCase() === 'OPEN'));
  const openNumbers = new Set(openPrs.map(pr => Number(pr.number ?? pr.pr)));
  for (const pr of openPrs) {
    const number = Number(pr.number ?? pr.pr);
    // Preserve the existing refusal-state mapping only; comments and arbitrary logs are never declarations.
    const tooling = currentToolingRefusals(pr.daemons ?? [], pr, (pr.repo ? owners[prKey(pr)] : null) ?? {}, now, settings)
      .flatMap(d => [...d.reason.matchAll(/\b(?:blocked[ \t]+by|depends[ \t]+on|waits[ \t]+on|waiting[ \t]+on)[ \t]+#([1-9]\d*)\b/gi)].map(m => Number(m[1])));
    const refs = [...new Set([...parseBlockedBy(pr.body), ...tooling])].filter(n => n !== number && openNumbers.has(n));
    blockedBy.set(number, refs);
    for (const n of refs) unblocks.set(n, [...new Set([...(unblocks.get(n) ?? []), number])]);
  }
  for (const pr of openPrs) {
    const number = Number(pr.number ?? pr.pr);
    for (const target of parseUnblocks(pr.body).filter(n => n !== number && openNumbers.has(n))) {
      blockedBy.set(target, [...new Set([...blockedBy.get(target), number])]);
      unblocks.set(number, [...new Set([...(unblocks.get(number) ?? []), target])]);
    }
  }
  // Remove every edge participating in a cycle, using the original graph so
  // removing one edge cannot accidentally preserve another edge in that cycle.
  const reaches = (start, target) => {
    const pending = [start], seen = new Set();
    while (pending.length) {
      const node = pending.pop();
      if (node === target) return true;
      if (seen.has(node)) continue;
      seen.add(node); pending.push(...(blockedBy.get(node) ?? []));
    }
    return false;
  };
  const acyclic = new Map([...blockedBy].map(([number, refs]) => [number, refs.filter(n => !reaches(n, number))]));
  unblocks.clear();
  for (const [number, refs] of acyclic) for (const n of refs) unblocks.set(n, [...(unblocks.get(n) ?? []), number]);
  return { blockedBy: acyclic, unblocks };
}
export function sortUnblockersFirst(rows) {
  return [...rows].sort((a, b) => Number(!!b.unblocks?.length) - Number(!!a.unblocks?.length));
}
