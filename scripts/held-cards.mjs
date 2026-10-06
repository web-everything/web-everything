/**
 * Pure held-card parsing and filing plans. Operator rule 21 defers backlog filing
 * while the host or PR queue is busy, then batches the held list into one lane/PR.
 * Line offsets are zero-based and endLine is exclusive.
 */
import { findUnmarkedLocusRefs } from './check-standards-rules.mjs';
import { prefixOwnPathMentions } from './operations/deliver-item-wrapper.mjs';

export const DEFAULT_MAX_LOAD = 15;
export const DEFAULT_MAX_PR_GROWTH = 0;

/** The item's title: its first closed `**bold**` span, else the line with any unclosed `**` stripped; trailing
 *  `.`, `:` or `,` dropped (a lead like "Follow-up from #3981 (...):" reads as a title, not a dangling clause). */
export function heldTitle(firstLine) {
  const bold = /\*\*(.*?)\*\*/.exec(firstLine)?.[1] ?? firstLine.replace(/\*\*/g, '');
  return bold.trim().replace(/[.:,]+$/, '').trim();
}

/** FILED|BUILT when an item's FIRST line carries a completion marker, else null. Two shapes only: the bold
 *  `**FILED …**` span `markFiled` appends, and the word right after a leading bold title (`**Title.** BUILT`).
 *  An uppercase mention in a title, body, continuation line or metadata is ordinary prose, never a marker. */
export function completionMarker(text) {
  const rest = text.split('\n', 1)[0].replace(/^\d+\.\s+/, '');
  return /\*\*(FILED|BUILT)\b[^*]*\*\*/.exec(rest)?.[1] ?? /^\*\*[^*]+\*\*\s+(FILED|BUILT)\b/.exec(rest)?.[1] ?? null;
}

export function parseHeldCards(md) {
  const lines = md.split(/\r?\n/);
  const items = [];
  const outside = [];
  for (let i = 0; i < lines.length;) {
    const match = /^(\d+)\.\s+(.*)/.exec(lines[i]);
    if (!match) { outside.push(lines[i++]); continue; }
    const startLine = i++;
    while (i < lines.length && !/^\d+\.\s+|^## /.test(lines[i]) &&
      (/^ +/.test(lines[i]) || !lines[i].trim())) i++;
    let endLine = i;
    while (endLine > startLine + 1 && !lines[endLine - 1].trim()) endLine--;
    const text = lines.slice(startLine, endLine).join('\n');
    let meta = null;
    const metadata = /<!-- held-card:\s*(.*?)\s*-->/.exec(text);
    if (metadata) {
      try { meta = JSON.parse(metadata[1]); } catch { /* Free-form notes can have malformed metadata. */ }
    }
    const doneReason = completionMarker(text);
    items.push({ num: Number(match[1]), title: heldTitle(match[2]),
      text, startLine, endLine, done: !!doneReason, doneReason, meta });
  }
  for (const line of outside) {
    const filed = /FILED\b.*?\bitems?\s+(\d+(?:\s*[–-]\s*\d+|(?:\s*,\s*\d+)*))/.exec(line);
    const built = /\bitem\s+(\d+)\b[^\n]*\bBUILT\b/.exec(line);
    for (const item of items) {
      const range = filed && /^(\d+)\s*[–-]\s*(\d+)$/.exec(filed[1]);
      const included = filed && (range ? item.num >= Number(range[1]) && item.num <= Number(range[2]) :
        filed[1].split(',').map(Number).includes(item.num));
      if (!item.done && (included || (built && item.num === Number(built[1])))) {
        item.done = true;
        item.doneReason = included ? 'FILED' : 'BUILT';
      }
    }
  }
  return { items, nextNum: Math.max(0, ...items.map(item => item.num)) + 1 };
}

export function appendHeldCard(md, { title, body = '', meta = null, nowEt }) {
  if (typeof title !== 'string' || !title.trim()) throw new TypeError('title must not be empty');
  const { nextNum: num } = parseHeldCards(md);
  const [first, ...rest] = body.split(/\r?\n/);
  const entry = [`${num}. **${title.trim().replace(/\.$/, '')}.**${first ? ` ${first}` : ''}`,
    ...rest.map(line => `    ${line}`), `    (held ${nowEt} ET)`,
    ...(meta === null ? [] : [`    <!-- held-card: ${JSON.stringify(meta)} -->`])].join('\n');
  return { md: `${md.trimEnd()}\n\n${entry}\n`, num };
}

export function quietVerdict({ load1, openPrs, previous, maxLoad = DEFAULT_MAX_LOAD, maxPrGrowth = DEFAULT_MAX_PR_GROWTH }) {
  const reasons = [];
  if (load1 >= maxLoad) reasons.push(`load ${load1} ≥ ${maxLoad}`);
  if (previous && openPrs - previous.openPrs > maxPrGrowth) reasons.push(`PR queue grew ${previous.openPrs} → ${openPrs}`);
  const quiet = reasons.length === 0;
  if (!previous) reasons.push('no previous PR snapshot; growth unknown');
  return { quiet, reasons, load1, openPrs, previousOpenPrs: previous?.openPrs ?? null };
}

export function planFiling(items, { defaults = { kind: 'story', size: 3 } } = {}) {
  return items.filter(item => !item.done).map(item => {
    const meta = item.meta ?? {};
    const raw = item.text.replace(/^\d+\.\s+/, '')
      .replace(/^[ \t]*<!-- held-card:.*?-->[ \t]*(?:\n|$)/gm, '')
      .replace(/^[ \t]*\(held .*? ET\)[ \t]*(?:\n|$)/gm, '').trim();
    const digest = prefixOwnPathMentions(raw, findUnmarkedLocusRefs(raw));
    return { num: item.num, title: item.title,
      kind: meta.kind ?? (/^Epic\b|^Umbrella \(epic\)|\(epic\)/i.test(item.title) ? 'epic'
        : /^(RATIFIED|Decision)\b/i.test(item.title) ? 'decision' : defaults.kind),
      size: meta.size ?? defaults.size, digest: `${digest} (Held-card #${item.num} from the operator handoff list.)`,
      scope: meta.scope ?? [], parent: meta.parent ?? null };
  });
}

export function markFiled(md, filings, { dateEt, pr }) {
  const lines = md.split('\n');
  const ids = new Map(filings.map(({ num, id }) => [num, id]));
  for (const item of parseHeldCards(md).items) {
    if (ids.has(item.num) && completionMarker(item.text) !== 'FILED') {
      const cr = lines[item.startLine].endsWith('\r') ? '\r' : '';
      lines[item.startLine] = lines[item.startLine].replace(/\r$/, '') +
        ` — **FILED ${dateEt} as ${ids.get(item.num)}, PR #${pr}**${cr}`;
    }
  }
  return lines.join('\n');
}
