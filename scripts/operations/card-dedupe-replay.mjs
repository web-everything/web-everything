#!/usr/bin/env node
/**
 * @file scripts/operations/card-dedupe-replay.mjs
 * @description REPLAY the mechanical filings of a past window through the dedupe (`we:scripts/lib/card-dedupe.mjs`)
 *   and count how many would have been "Also raised by" mentions instead of new cards. Read-only: it only reads
 *   `backlog/*.md` and prints a report.
 *
 *   A filing is a card whose body starts "Filed mechanically" and whose `dateOpened` is inside the window. Filings are
 *   replayed oldest first (dateOpened, then id). The open set a filing is matched against is every card that, ON THAT
 *   DAY, was open: opened on or before it, not yet resolved, not yet started (a started card was claimed — `active` —
 *   and is never a dedupe target). Each card is matched on its FILED digest (the text before its first `## ` section),
 *   so the preparer's later sections never count. A filing that would have become a mention is NOT added to the open set
 *   (it would not have existed); its findings are added to the card it was mentioned on, as the live path does.
 *
 * Usage: node scripts/operations/card-dedupe-replay.mjs [--since=YYYY-MM-DD] [--until=YYYY-MM-DD] [--similarity=0.5]
 *          [--root=<checkout>] [--json] [--examples=N]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cardFromText, planDedupe, appendMentions, CARD_DEDUPE_DEFAULTS } from '../lib/card-dedupe.mjs';

const fm = (text, key) => new RegExp(`^${key}:[ \\t]*"?([^"\\n]*)"?$`, 'm').exec(/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '')?.[1]?.trim() || null;

/** The card as it was FILED: frontmatter + title + the digest before the first `## ` section. PURE. */
export function filedText(text) {
  const at = text.search(/\n## /);
  return at === -1 ? text : text.slice(0, at);
}

/**
 * PURE. Replay `cards` (`{rel, text}`) through the dedupe.
 * @returns {{filings: number, mentions: number, partial: number, filed: number, mentionedFindings: number,
 *   totalFindings: number, examples: Array<object>}}
 */
export function replayDedupe(cards, { since, until, similarity = CARD_DEDUPE_DEFAULTS.similarity } = {}) {
  const policy = { dedupe: true, similarity };
  const rows = cards.map(({ rel, text }) => ({
    rel, text,
    opened: fm(text, 'dateOpened'), started: fm(text, 'dateStarted'), resolved: fm(text, 'dateResolved'),
    mechanical: /\n# .+\n\nFiled mechanically/.test(text),
  })).filter((r) => r.opened);
  rows.sort((a, b) => (a.opened < b.opened ? -1 : a.opened > b.opened ? 1 : a.rel < b.rel ? -1 : 1));
  // `edits` carries the mentions the replay itself appended, keyed by card rel.
  const edits = new Map();
  const parsed = new Map(); // rel → parsed card (re-parsed only when the replay appends a mention to it)
  const pos = new Map(rows.map((r, i) => [r.rel, i]));
  const cardOf = (c) => {
    if (!parsed.has(c.rel)) parsed.set(c.rel, { ...cardFromText({ rel: c.rel, text: edits.get(c.rel) ?? filedText(c.text) }), status: 'open' });
    return parsed.get(c.rel);
  };
  const skipped = new Set(); // filings that became pure mentions: they never existed
  const out = { filings: 0, mentions: 0, partial: 0, filed: 0, mentionedFindings: 0, totalFindings: 0, examples: [] };
  for (const f of rows) {
    if (!f.mechanical || f.opened < since || f.opened > until) continue;
    const day = f.opened;
    const open = rows.filter((c) => c !== f && !skipped.has(c.rel) && c.opened <= day
      && !(c.started && c.started <= day) && !(c.resolved && c.resolved <= day)
      // Same-day ties: only cards ordered before this one existed when it was filed.
      && (c.opened < day || pos.get(c.rel) < pos.get(f.rel)))
      .map(cardOf).filter((c) => c.items.length);
    const digest = filedText(f.text).replace(/^---\n[\s\S]*?\n---\n+# .+\n+/, '');
    const plan = planDedupe({ input: { title: /^# (.+)$/m.exec(f.text)?.[1] ?? '', digest }, cards: open, policy });
    const n = (digest.match(/^\d+\.\s+`/gm) ?? []).length;
    out.filings += 1;
    out.totalFindings += n;
    out.mentionedFindings += plan.matches.length;
    if (plan.action === 'mention') { out.mentions += 1; skipped.add(f.rel); } else if (plan.action === 'partial') out.partial += 1; else out.filed += 1;
    for (const m of plan.mentions) {
      edits.set(m.card.rel, appendMentions(edits.get(m.card.rel) ?? filedText(rows[pos.get(m.card.rel)].text), m.lines));
      parsed.delete(m.card.rel);
    }
    if (plan.matches.length) {
      out.examples.push({
        filing: f.rel, action: plan.action,
        matches: plan.matches.map((m) => ({ finding: m.item.n, file: m.item.file, cls: m.item.cls, card: m.card.rel, score: Number(m.score.toFixed(2)), claim: m.item.claim.slice(0, 140), matched: m.cardItem?.claim.slice(0, 140) })),
      });
    }
  }
  return out;
}

function main(argv) {
  const flags = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i === -1 ? [a.slice(2), 'true'] : [a.slice(2, i), a.slice(i + 1)]; }));
  const root = resolve(flags.root ?? resolve(fileURLToPath(import.meta.url), '..', '..', '..'));
  const dir = join(root, 'backlog');
  const cards = readdirSync(dir).filter((n) => n.endsWith('.md')).map((n) => ({ rel: `backlog/${n}`, text: readFileSync(join(dir, n), 'utf8') }));
  const r = replayDedupe(cards, {
    since: flags.since ?? '2026-10-03', until: flags.until ?? '2026-10-09',
    similarity: flags.similarity ? Number(flags.similarity) : CARD_DEDUPE_DEFAULTS.similarity,
  });
  if (flags.json) { process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); return; }
  process.stdout.write(`mechanical filings replayed: ${r.filings} (${r.totalFindings} findings)\n`
    + `  would be a mention only (no new card): ${r.mentions}\n  partial (some findings mentioned, rest filed): ${r.partial}\n`
    + `  filed as today: ${r.filed}\n  findings that become mentions: ${r.mentionedFindings}\n`);
  for (const e of r.examples.slice(0, Number(flags.examples ?? 5))) {
    process.stdout.write(`\n${e.filing} → ${e.action}\n`);
    for (const m of e.matches) process.stdout.write(`  #${m.finding} [${m.cls}] ${m.file} ~${m.score} ${m.card}\n    new: ${m.claim}\n    old: ${m.matched}\n`);
  }
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) main(process.argv.slice(2));
