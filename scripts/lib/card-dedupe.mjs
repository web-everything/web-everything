/**
 * @file scripts/lib/card-dedupe.mjs
 * @description DEDUPE BEFORE FILING (operator go 2026-10-10 ~10:40 ET). The mechanical filers (the approval-time
 *   prevention filer, the review loop's prevention + round-budget / late-findings cards — every one of them lands
 *   through `we:scripts/operations/land-prevention-card.mjs`) filed a fresh card per PR even when an OPEN card already
 *   asked for the same guard on the same file. The coroner/build queue showed ~30 such near-duplicates at its front.
 *
 *   This module decides, per finding a filer is about to file, whether an open card already carries it:
 *     - same TARGET (the finding's cited `we:path`, line ignored; a finding cited on a backlog card targets the card
 *       corpus `backlog/`, see {@link targetOf}) — required;
 *     - same DEFECT CLASS ({@link guardClass}) — required;
 *     - CLAIM SIMILARITY ≥ the threshold — IDF-weighted Jaccard over normalized word tokens ({@link claimSimilarity},
 *       {@link buildIdf}). No LLM. The default 0.3 is calibrated on the 2026-10-03..09 replay
 *       (`we:scripts/operations/card-dedupe-replay.mjs`).
 *   A matched finding becomes one "Also raised by …" line appended to the existing card; the unmatched rest is filed
 *   as today (all matched → no new card). Never across different files or classes; never into a card whose status is
 *   not `open` (an `active` card is claimed by a session and is never touched).
 *
 * THE POLICY CASCADE ({@link resolveCardDedupePolicy}): standard default (off — today's behaviour) → platform
 *   preference (`cards` in `we:scripts/lib/delivery-platform-preferences.json`; a missing file is no preference) →
 *   repo override (`cards` in `we:scripts/settings/card-dedupe.json`) → env (`WE_CARDS_DEDUPE`,
 *   `WE_CARDS_DEDUPE_SIMILARITY`). Each key reports the layer it came from.
 *
 * PURE above the IO marker; the IO helpers below it only read files / run `gh`, and are injectable.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ── Policy ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The standard default: off (today's behaviour). The repo override turns it on. */
export const CARD_DEDUPE_DEFAULTS = Object.freeze({ dedupe: false, similarity: 0.3 });

const validSimilarity = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * PURE policy cascade: standard default → platform preference → repo override → env. A layer overrides only the keys
 * it sets VALIDLY (a typo falls through to the layer below).
 * @param {{platform?: object|null, repo?: object|null, env?: object}} layers - `platform`/`repo` are the `cards` objects.
 * @returns {{dedupe: boolean, similarity: number, source: {dedupe: string, similarity: string}}}
 */
export function resolveCardDedupePolicy({ platform = null, repo = null, env = {} } = {}) {
  const out = { ...CARD_DEDUPE_DEFAULTS, source: { dedupe: 'default', similarity: 'default' } };
  for (const [name, layer] of [['platform', platform], ['repo', repo]]) {
    if (!isObj(layer)) continue;
    if (typeof layer.dedupe === 'boolean') { out.dedupe = layer.dedupe; out.source.dedupe = name; }
    if (validSimilarity(layer.similarity)) { out.similarity = layer.similarity; out.source.similarity = name; }
  }
  const e = isObj(env) ? env : {};
  const flag = String(e.WE_CARDS_DEDUPE ?? '').trim().toLowerCase();
  if (['1', 'true', 'on'].includes(flag)) { out.dedupe = true; out.source.dedupe = 'env'; }
  if (['0', 'false', 'off'].includes(flag)) { out.dedupe = false; out.source.dedupe = 'env'; }
  const sim = Number(e.WE_CARDS_DEDUPE_SIMILARITY);
  if (String(e.WE_CARDS_DEDUPE_SIMILARITY ?? '').trim() && validSimilarity(sim)) { out.similarity = sim; out.source.similarity = 'env'; }
  return out;
}

/** PURE. One log line naming each key's value and source. */
export function formatCardDedupePolicy(p) {
  return `cards.dedupe=${p.dedupe} (${p.source.dedupe}), similarity=${p.similarity} (${p.source.similarity})`;
}

// ── Classes and claim similarity ─────────────────────────────────────────────────────────────────────────────────

/**
 * The defect classes a guard can belong to, each with the words that name it. Deterministic: the class is the one
 * whose FIRST keyword appears EARLIEST in the claim (ties go to the earlier class in this list), so "add a
 * check:standards rule … and a test" is a standards rule, and "add a test that … like the lint" is a test.
 */
export const GUARD_CLASSES = Object.freeze([
  ['standards-rule', /check[:-]standards|\blint\w*|standards rule|card-lint|\bgate rule\b/i],
  ['test', /\btests?\b|\bregression\b|\bvitest\b|\bfixture\b|\bmutation\b|\bassert\w*/i],
  ['doc', /\bdoc(?:s|block|ument\w*)?\b|\breadme\b|\bcomment\b|\bbrief\b|\bprompt\b|\bheader\b/i],
  ['runtime-guard', /\brefus\w*|\breject\w*|\bfail[- ]closed\b|\bvalidat\w*|\bthrow\w*|\bguard\w*|\bassertion\b/i],
]);

/** PURE. The guard's defect class; `other` when no class word appears. */
export function guardClass(text) {
  const s = String(text ?? '');
  let best = null;
  for (const [name, re] of GUARD_CLASSES) {
    const m = re.exec(s);
    if (m && (best === null || m.index < best.index)) best = { name, index: m.index };
  }
  return best?.name ?? 'other';
}

const STOP = new Set(('a an and are as at be by can could does each every for from has have if in into is it its '
  + 'it\'s may must no not of on one or should so such than that the their them then there these this those to '
  + 'was were when where which while will with would add adds also any new make makes ensure ensures same both '
  + 'only via use uses using like eg e.g i.e e g better instead so that before after').split(/\s+/));

/** Light stemming: `-ing`/`-ed` off longer words, then a plural `-s` (never `-ss`), so rule/rules and test/tests meet. */
const stem = (w) => {
  let s = w.length > 5 ? w.replace(/(?:ing|ed)$/, '') : w;
  if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  return s;
};

/** PURE. Normalized claim tokens: lowercase words ≥3 chars, no stopwords, no bare numbers, light stemming. */
export function claimTokens(text) {
  const words = String(text ?? '').toLowerCase()
    .replace(/`[^`]*`/g, (m) => m.replace(/[/.:#-]/g, ' '))
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
  return new Set(words.map(stem));
}

/**
 * PURE. Token weights for {@link claimSimilarity}: inverse document frequency over a set of findings (each finding's
 * token set is one document). A word every guard uses ("deterministic", "assert") weighs little; a word naming the
 * guarded thing ("probeErrors", "6f-ii-c", "redCause") weighs a lot — which is what makes two reworded asks for the
 * same guard meet while two different tests on the same file stay apart (calibrated on the 2026-10-03..09 replay).
 * @param {Iterable<{tokens: Set<string>}>} items
 * @returns {(token: string) => number}
 */
export function buildIdf(items) {
  const df = new Map();
  let n = 0;
  for (const it of items) {
    n += 1;
    for (const t of it.tokens) df.set(t, (df.get(t) ?? 0) + 1);
  }
  // Smoothed (`1 +`), so a token every finding shares still weighs something in a small corpus (two cards).
  return (t) => Math.log(1 + (n + 1) / ((df.get(t) ?? 0) + 1));
}

/** PURE. Weighted Jaccard similarity of two claims' token sets (0 when either is empty); unweighted with no `idf`. */
export function claimSimilarity(a, b, idf = () => 1) {
  const A = a instanceof Set ? a : claimTokens(a);
  const B = b instanceof Set ? b : claimTokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  let union = 0;
  for (const t of new Set([...A, ...B])) {
    const w = idf(t);
    union += w;
    if (A.has(t) && B.has(t)) inter += w;
  }
  return union ? inter / union : 0;
}

/**
 * PURE. The TARGET a finding's cited file stands for. A finding cited on a backlog card (`backlog/<card>.md`) asks for a
 * guard over card text — a card lint, a preparation check — so its target is the card corpus `backlog/`, not the one
 * card it happened to be raised on (the 2026-10-03..09 replay: the "reject a card whose Done-when still says TODO" rule
 * was filed again and again, each time cited on a different card). Every other file is its own target.
 */
export const targetOf = (file) => (/^backlog\/[^/]+\.md$/.test(String(file ?? '')) ? 'backlog/' : String(file ?? ''));

/** The one spelling a target file is compared in: no `we:` locus, no leading `./`, no `:line`. PURE. */
export const normalizeTarget = (p) => String(p ?? '').trim().replace(/^we:/, '').replace(/^(\.\/)+/, '')
  .replace(/:\d+(?:[:-]\d+)?$/, '');

// ── Parsing filings and cards ────────────────────────────────────────────────────────────────────────────────────

/** A numbered finding line: `N. \`we:path:line\` — claim` (the shape every mechanical filer writes). */
const ITEM_RE = /^(\d+)\.\s+`([^`\n]+)`\s+—\s+(.+)$/;
/** A mention line this module appends (so a card's own mentions keep matching later filings). */
const MENTION_RE = /^- Also raised by (\S+#\d+) \(finding \d+: `([^`\n]+)` — (.+?)\)(?: · key `[^`]*`)?$/;

const toItem = (n, anchor, claim, raw) => {
  const file = /^(?:we:)?[A-Za-z0-9_.][A-Za-z0-9._/-]*(?::\d+(?:[:-]\d+)?)?$/.test(anchor.trim()) ? normalizeTarget(anchor) : null;
  const line = /:(\d+)(?:[:-]\d+)?$/.exec(anchor.trim())?.[1];
  return { n, file, target: file ? targetOf(file) : null, line: line ? Number(line) : null, claim: claim.trim(), cls: guardClass(claim), tokens: claimTokens(claim), raw };
};

/**
 * PURE. The numbered findings of a filing's digest, in order. A finding with no cited plain path has `file: null` and
 * is never deduped.
 * @returns {Array<{n:number, file:(string|null), line:(number|null), claim:string, cls:string, tokens:Set<string>, raw:string}>}
 */
export function parseFilingItems(digest) {
  const out = [];
  for (const raw of String(digest ?? '').split('\n')) {
    const m = ITEM_RE.exec(raw.trim());
    if (m) out.push(toItem(Number(m[1]), m[2], m[3], raw));
  }
  return out;
}

/**
 * PURE. The findings an existing card carries: the numbered lines of its filed digest (the body before its first `## `
 * section — later sections are the preparer's own Design/MVP lists, not filed findings) plus its "Also raised by" lines.
 */
export function parseCardItems(text) {
  const out = [];
  let inDigest = true;
  for (const raw of String(text ?? '').split('\n')) {
    const t = raw.trim();
    if (/^## /.test(t)) inDigest = false;
    const m = inDigest ? ITEM_RE.exec(t) : null;
    if (m) { out.push(toItem(Number(m[1]), m[2], m[3], raw)); continue; }
    const k = MENTION_RE.exec(t);
    if (k) out.push(toItem(0, k[2], k[3], raw));
  }
  return out;
}

const readFm = (text, key) => {
  const fm = /^---\n([\s\S]*?)\n---/.exec(String(text ?? ''))?.[1] ?? '';
  return new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, '') || null;
};

/**
 * PURE. A card as the matcher sees it. `host` is `'main'` (a card on origin/main, edited in a lane) or `{pr}` (a card
 * still in an open filing PR — mentioned there by a PR comment, since that branch is not ours to push to).
 */
export function cardFromText({ rel, text, host = 'main' }) {
  const name = String(rel ?? '').split('/').pop() ?? '';
  return {
    rel, host, id: /^([^-]+)-/.exec(name)?.[1] ?? name.replace(/\.md$/, ''),
    status: readFm(text, 'status'), title: /^# (.+)$/m.exec(String(text ?? ''))?.[1] ?? '',
    items: parseCardItems(text), text: String(text ?? ''),
  };
}

/** PURE. Which PR raised this filing: `{repo, pr}` from its idempotency key, digest or title; `null` if none. */
export function filingSource(input = {}) {
  const hay = [input.digest, input.title].map((s) => String(s ?? '')).join('\n');
  const m = /approval-prevention-key:([\w.-]+\/[\w.-]+)#(\d+)/.exec(hay)
    || /([\w.-]+\/[\w.-]+)#(\d+)(?:'s| review|\b)/.exec(hay);
  return m ? { repo: m[1], pr: Number(m[2]) } : null;
}

/** PURE. The filing's idempotency key, when it carries one. */
export const filingKey = (input = {}) => /approval-prevention-key:[\x21-\x5a\x5c\x5e-\x7e]{1,300}/.exec(String(input.digest ?? ''))?.[0] ?? null;

// ── Matching and planning ────────────────────────────────────────────────────────────────────────────────────────

/**
 * PURE. The best open-card finding for one incoming finding, or `null`. Same file AND same class are hard gates; the
 * score is the claim similarity; ties go to the lower card id, then the earlier line (deterministic).
 */
export function matchItem(item, cards, threshold, idf = () => 1) {
  if (!item?.target) return null;
  let best = null;
  for (const card of cards) {
    if (card.status !== 'open') continue; // never a claimed (active), resolved or parked card
    for (const ci of card.items) {
      if (!ci.target || ci.target !== item.target || ci.cls !== item.cls) continue;
      const score = claimSimilarity(item.tokens, ci.tokens, idf);
      if (score < threshold) continue;
      if (!best || score > best.score || (score === best.score && String(card.id) < String(best.card.id))) best = { card, cardItem: ci, score };
    }
  }
  return best;
}

const MENTION_CLAIM_CAP = 300;

/** PURE. The line appended to an existing card for one matched finding. */
export function mentionLine({ source, item, key = null }) {
  const who = source ? `${source.repo}#${source.pr}` : 'unknown#0';
  const where = `we:${item.file}${item.line ? `:${item.line}` : ''}`;
  const claim = item.claim.replace(/[()`]/g, ' ').replace(/\s+/g, ' ').trim();
  const bounded = claim.length > MENTION_CLAIM_CAP ? `${claim.slice(0, MENTION_CLAIM_CAP - 1)}…` : claim;
  return `- Also raised by ${who} (finding ${item.n}: \`${where}\` — ${bounded})${key ? ` · key \`${key}\`` : ''}`;
}

export const MENTION_HEADING = '## Also raised by';

/**
 * PURE. The card text with `lines` appended under its "Also raised by" section (created at the end if absent). A line
 * the card already carries is skipped, so a retried filing never doubles a mention. Returns the text unchanged when
 * there is nothing new.
 */
export function appendMentions(text, lines) {
  const src = String(text ?? '');
  const fresh = [...new Set(lines)].filter((l) => !src.includes(l));
  if (!fresh.length) return src;
  const body = src.replace(/\s+$/, '');
  const at = body.indexOf(`\n${MENTION_HEADING}\n`);
  if (at === -1) return `${body}\n\n${MENTION_HEADING}\n\n${fresh.join('\n')}\n`;
  // Insert after the section's last mention line (the section may be followed by later sections).
  const start = at + MENTION_HEADING.length + 2;
  const rest = body.slice(start);
  const next = rest.search(/\n## /);
  const sectionEnd = next === -1 ? body.length : start + next;
  const section = body.slice(start, sectionEnd).replace(/\s+$/, '');
  return `${body.slice(0, start)}${section}\n${fresh.join('\n')}${body.slice(sectionEnd)}\n`;
}

/**
 * PURE. The filing input reduced to its unmatched findings (renumbered), or `null` when none remain. The header before
 * the first finding and the idempotency-key tail are kept; scope keeps only entries naming a kept file or its test.
 */
export function reduceFilingInput(input, keep, matched = []) {
  if (!keep.length) return null;
  const digest = String(input.digest ?? '');
  const lines = digest.split('\n');
  const first = lines.findIndex((l) => ITEM_RE.test(l.trim()));
  const keySep = digest.lastIndexOf('\n\nIdempotency key (do not edit): ');
  const header = first === -1 ? '' : lines.slice(0, first).join('\n');
  const tail = keySep === -1 ? '' : digest.slice(keySep);
  const renumbered = keep.map((it, i) => it.raw.trim().replace(/^\d+\./, `${i + 1}.`));
  const note = matched.length
    ? `\n\nAlready tracked on open cards (recorded there as "Also raised by", not refiled): ${matched.map((m) => `finding ${m.item.n} → #${m.card.id}`).join(', ')}.`
    : '';
  const stemOf = (p) => normalizeTarget(p).split('/').pop().replace(/\.test\.[cm]?[jt]s$/, '').replace(/\.[^.]+$/, '');
  const kept = new Set(keep.map((k) => k.file).filter(Boolean).map(stemOf));
  const scope = String(input.scope ?? '').split(',').filter((e) => e.trim() && kept.has(stemOf(e))).join(',');
  return { ...input, digest: `${header}${renumbered.join('\n')}${note}${tail}`, scope: scope || input.scope };
}

/**
 * PURE. THE PLAN for one filing.
 * @param {{input: object, cards: Array<object>, policy: {dedupe:boolean, similarity:number}}} o
 * @returns {{action: 'file'|'mention'|'partial'|'off', mentions: Array<{card: object, lines: string[]}>,
 *   matches: Array<{item: object, card: object, score: number}>, remaining: (object|null)}}
 */
export function planDedupe({ input, cards = [], policy }) {
  if (!policy?.dedupe) return { action: 'off', mentions: [], matches: [], remaining: input };
  const items = parseFilingItems(input?.digest);
  if (!items.length) return { action: 'file', mentions: [], matches: [], remaining: input };
  const source = filingSource(input);
  const key = filingKey(input);
  const matches = [];
  const keep = [];
  const idf = buildIdf([...cards.flatMap((c) => c.items), ...items]);
  for (const item of items) {
    const m = matchItem(item, cards, policy.similarity, idf);
    if (m) matches.push({ item, card: m.card, cardItem: m.cardItem, score: m.score }); else keep.push(item);
  }
  if (!matches.length) return { action: 'file', mentions: [], matches, remaining: input };
  const byCard = new Map();
  for (const m of matches) {
    const entry = byCard.get(m.card.rel) ?? { card: m.card, lines: [], items: [] };
    entry.items.push(m.item);
    // The key goes on the FIRST mention only: it makes the existing card answer the filer's own on-disk idempotency
    // lookup (`findApprovalPreventionCardOnDisk` matches the key text) when nothing new was filed.
    entry.lines.push(mentionLine({ source, item: m.item, key: !keep.length && matches[0] === m ? key : null }));
    byCard.set(m.card.rel, entry);
  }
  return {
    action: keep.length ? 'partial' : 'mention',
    mentions: [...byCard.values()],
    matches,
    remaining: reduceFilingInput(input, keep, matches),
  };
}

/**
 * PURE. The filing input once only `recorded` matches were actually written somewhere: every finding NOT recorded (an
 * unmatched one, or a match whose card turned out not to be open any more) is filed — a match is never dropped.
 * @param {object} input
 * @param {Array<{item: object, card: object}>} recorded
 * @returns {object|null}
 */
export function remainingAfter(input, recorded) {
  const done = new Set(recorded.map((m) => m.item.n));
  return reduceFilingInput(input, parseFilingItems(input?.digest).filter((it) => !done.has(it.n)), recorded);
}

// ── IO (injectable) ──────────────────────────────────────────────────────────────────────────────────────────────

const readJson = (path, read) => { try { return JSON.parse(read(path, 'utf8')); } catch { return null; } };

/**
 * Read the cascade's layers from `root` and `env` and resolve them. A missing platform-preferences file (it lands with
 * #4708) is no preference, never an error.
 */
export function loadCardDedupePolicy({ root, env = process.env, read = readFileSync } = {}) {
  const platform = readJson(join(root, 'scripts', 'lib', 'delivery-platform-preferences.json'), read)?.cards ?? null;
  const repo = readJson(join(root, 'scripts', 'settings', 'card-dedupe.json'), read)?.cards ?? null;
  return resolveCardDedupePolicy({ platform, repo, env });
}

/** Every `status: open` card in `<dir>/backlog` (the lane's origin/main copy). `[]` when the dir is unreadable. */
export function readOpenCards(dir, { list = readdirSync, read = readFileSync } = {}) {
  let names;
  try { names = list(join(dir, 'backlog')); } catch { return []; }
  const out = [];
  for (const name of names.filter((n) => n.endsWith('.md')).sort()) {
    let text;
    try { text = read(join(dir, 'backlog', name), 'utf8'); } catch { continue; }
    const card = cardFromText({ rel: `backlog/${name}`, text });
    if (card.status === 'open' && card.items.length) out.push(card);
  }
  return out;
}

/** The branches whose new cards are still waiting to land: card-batch PRs and per-card prevention landing PRs. */
export const FILING_PR_REF_RE = /^lane\/(?:card-batch-|.*prevention-card$)/;
const PR_CARD_CAP = 60;

/**
 * Open cards that exist only in an open filing PR (bounded). Best-effort: any `gh` failure returns `[]` — a lookup
 * miss only means a duplicate may be filed, exactly as before this module existed.
 */
export function readPrHostedCards({ exec, cwd }) {
  try {
    const prs = JSON.parse(exec('gh', ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,headRefName,files'], { cwd, encoding: 'utf8' }));
    const out = [];
    for (const pr of Array.isArray(prs) ? prs : []) {
      if (!FILING_PR_REF_RE.test(String(pr.headRefName ?? ''))) continue;
      for (const f of pr.files ?? []) {
        if (out.length >= PR_CARD_CAP) return out;
        if (!/^backlog\/[^/]+\.md$/.test(String(f.path ?? ''))) continue;
        let text;
        try {
          text = exec('gh', ['api', `repos/{owner}/{repo}/contents/${f.path}?ref=${encodeURIComponent(pr.headRefName)}`, '-H', 'Accept: application/vnd.github.raw'], { cwd, encoding: 'utf8' });
        } catch { continue; }
        const card = cardFromText({ rel: f.path, text, host: { pr: pr.number } });
        if (card.status === 'open' && card.items.length) out.push(card);
      }
    }
    return out;
  } catch {
    return [];
  }
}
