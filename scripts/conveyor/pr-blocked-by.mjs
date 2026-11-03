/** R437: report-only PR dependency edges. All text is untrusted Markdown; no IO. */
import MarkdownIt from 'markdown-it';
const markdown = new MarkdownIt();
export function parseBlockedBy(text) {
  // Block tokens account for indentation, nesting and lazy blockquote continuation;
  // a line-prefix filter cannot tell quoted example text from an active dependency.
  const paragraphs = [];
  let quoteDepth = 0;
  for (const token of markdown.parse(String(text ?? ''), {})) {
    if (token.type === 'blockquote_open') quoteDepth++;
    else if (token.type === 'blockquote_close') quoteDepth--;
    else if (token.type === 'inline' && quoteDepth === 0) paragraphs.push(token.content);
  }
  const plain = paragraphs.join('\n');
  // Equal-length backtick runs delimit spans across lines. An unterminated span
  // stays excluded: uncertain quoted text must never manufacture a dependency.
  let clean = '', cursor = 0, delimiter = null;
  for (const run of plain.matchAll(/`+/g)) {
    if (delimiter === null) {
      clean += plain.slice(cursor, run.index) + '\u0000';
      delimiter = run[0].length;
    } else if (run[0].length === delimiter) {
      delimiter = null;
    }
    cursor = run.index + run[0].length;
  }
  if (delimiter === null) clean += plain.slice(cursor);
  return [...new Set([...clean.matchAll(/\b(?:blocked[ \t]+by|depends[ \t]+on|waits[ \t]+on|waiting[ \t]+on)[ \t]+#([1-9]\d*)\b/gi)]
    .map(m => Number(m[1])).filter(Number.isSafeInteger))];
}
/** Inputs are the current open-PR listing for ONE repository (state may be omitted).
 * Textual references alone never confirm a live blocker; closed, merged and absent targets do not block.
 */
export function buildBlockedMap(prs) {
  const blockedBy = new Map(), unblocks = new Map();
  const openPrs = prs.filter(pr => pr.state === undefined || (typeof pr.state === 'string' && pr.state.toUpperCase() === 'OPEN'));
  const openNumbers = new Set(openPrs.map(pr => Number(pr.number ?? pr.pr)));
  for (const pr of openPrs) {
    const number = Number(pr.number ?? pr.pr);
    const texts = [pr.body, ...(Array.isArray(pr.comments) ? pr.comments.map(c => typeof c === 'string' ? c : c.body) : []),
      pr.refusalReason, pr.fixDaemonRefusalReason, ...(pr.daemons ?? []).filter(d => d.kind === 'refusal').map(d => d.reason)];
    const refs = [...new Set(texts.flatMap(parseBlockedBy))].filter(n => n !== number && openNumbers.has(n));
    blockedBy.set(number, refs);
    for (const n of refs) unblocks.set(n, [...new Set([...(unblocks.get(n) ?? []), number])]);
  }
  return { blockedBy, unblocks };
}
export function sortUnblockersFirst(rows) {
  return [...rows].sort((a, b) => Number(!!b.unblocks?.length) - Number(!!a.unblocks?.length));
}
