/**
 * @file scripts/lib/related-items-core.mjs
 * @description FIND THE CARDS AN IDEA IS ALREADY ABOUT, before it is proposed or filed (operator 2026-10-21). Live
 *   miss that day: the orchestrator proposed "shared node_modules via copy-on-write" as new work while card 5743
 *   ("Installs use pnpm (or a shared content-addressed store) instead of npm ci copies", operator-approved
 *   2026-10-10) was open. The only dedupe then, `we:scripts/lib/card-dedupe.mjs`, covers only mechanical prevention
 *   filings (same target file + same defect class), never an agent/human `file-item` filing or a proposal, and it
 *   misses the same idea worded differently.
 *
 *   SCORE (deterministic, explainable, no LLM) of one card against a query (title + idea text):
 *     - WORDING — the query's tokens (the SAME tokenizer as card-dedupe, `./claim-similarity.mjs`), after a small
 *       synonym table (a setting: npm/pnpm/node_modules/install, red team/redteam, …) folds each group to one
 *       token. `text = 0.5 × coverage + 0.3 × titleCoverage + 0.2 × titleSimilarity`, where `coverage` is the
 *       IDF-weighted share of the query's tokens the card's title + lead paragraph carries (recall against the query,
 *       so a long card is not penalized for being long), `titleCoverage` the same share for the title alone, and
 *       `titleSimilarity` the IDF-weighted Jaccard against the title alone (cards ABOUT the idea name it in the title).
 *     - SCOPE — the share of the query's `--scope` paths that share a path prefix with the card's `scope`.
 *     - TAGS — the share of the query's tags the card carries.
 *     `score = min(1, w.text × text + w.scope × scope + w.tags × tags)`.
 *   A long query (a filing's title line + digest) counts every title-line token plus only the digest's most
 *   distinctive tokens (highest IDF) up to `queryTerms`, so it scores on the same scale as a one-line idea. Every row says WHY: the matched terms, paths and tags.
 *
 *   ELIGIBLE CARDS: status in `statuses` (default open, parked, active), plus `resolved` within
 *   `resolvedWithinDays` of today (by `dateResolved`).
 *
 * THE POLICY CASCADE ({@link resolveRelatedItemsPolicy}): standard default → platform preference
 *   (`relatedItems` in `we:scripts/lib/delivery-platform-preferences.json`) → repo override (`relatedItems` in
 *   `we:scripts/settings/related-items.json`) → env (`WE_RELATED_ITEMS`, `WE_RELATED_ITEMS_FILE_ITEM`,
 *   `WE_RELATED_ITEMS_THRESHOLD`). Each key reports the layer it came from.
 *
 * PURE. No fs, no clock, no process, no network.
 */
import { claimTokens, buildIdf, claimSimilarity } from './claim-similarity.mjs';

// ── Policy ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const FILE_ITEM_MODES = Object.freeze(['off', 'warn', 'refuse']);

/** The standard default. `fileItem: 'warn'` — print matches, never block — until the threshold is calibrated live. */
export const RELATED_ITEMS_DEFAULTS = Object.freeze({
  enabled: true,
  fileItem: 'warn',
  threshold: 0.5,
  floor: 0.12,
  limit: 5,
  queryTerms: 10,
  statuses: Object.freeze(['open', 'parked', 'active']),
  resolvedWithinDays: 30,
  weights: Object.freeze({ text: 1, scope: 0.25, tags: 0.1 }),
  synonyms: Object.freeze([
    Object.freeze(['pnpm', 'npm', 'npm ci', 'node_modules', 'install', 'yarn', 'package manager']),
    Object.freeze(['copy-on-write', 'cow', 'clonefile', 'hardlink', 'hard-link', 'reflink']),
    Object.freeze(['verdict-ledger', 'ledger']),
    Object.freeze(['redteam', 'red team', 'red-team']),
    Object.freeze(['hang', 'hung', 'stall', 'stuck', 'wedge', 'timeout', 'time out', 'never exit']),
    Object.freeze(['review', 'reviewer', 'juror']),
    Object.freeze(['test', 'vitest', 'test:unit']),
  ]),
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const unit = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const posInt = (v) => Number.isInteger(v) && v > 0;
const strList = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s.trim());
const synList = (v) => Array.isArray(v) && v.every((g) => strList(g));
const weightsOk = (v) => isObj(v) && ['text', 'scope', 'tags'].every((k) => v[k] === undefined || (typeof v[k] === 'number' && v[k] >= 0 && v[k] <= 2));

/** Each key's validator: a layer overrides only the keys it sets VALIDLY (a typo falls through to the layer below). */
const VALID = Object.freeze({
  enabled: (v) => typeof v === 'boolean',
  fileItem: (v) => FILE_ITEM_MODES.includes(v),
  threshold: (v) => unit(v) && v > 0,
  floor: unit,
  limit: posInt,
  queryTerms: posInt,
  statuses: strList,
  resolvedWithinDays: (v) => Number.isInteger(v) && v >= 0,
  weights: weightsOk,
  synonyms: synList,
});

/**
 * PURE policy cascade: standard default → platform preference → repo override → env.
 * @param {{platform?: object|null, repo?: object|null, env?: object}} layers - `platform`/`repo` are the `relatedItems` objects.
 */
export function resolveRelatedItemsPolicy({ platform = null, repo = null, env = {} } = {}) {
  const out = { ...RELATED_ITEMS_DEFAULTS, weights: { ...RELATED_ITEMS_DEFAULTS.weights }, source: {} };
  for (const k of Object.keys(VALID)) out.source[k] = 'default';
  for (const [name, layer] of [['platform', platform], ['repo', repo]]) {
    if (!isObj(layer)) continue;
    for (const [k, ok] of Object.entries(VALID)) {
      if (layer[k] === undefined || !ok(layer[k])) continue;
      out[k] = k === 'weights' ? { ...out.weights, ...layer[k] } : layer[k];
      out.source[k] = name;
    }
  }
  const e = isObj(env) ? env : {};
  const flag = String(e.WE_RELATED_ITEMS ?? '').trim().toLowerCase();
  if (['1', 'true', 'on'].includes(flag)) { out.enabled = true; out.source.enabled = 'env'; }
  if (['0', 'false', 'off'].includes(flag)) { out.enabled = false; out.source.enabled = 'env'; }
  const mode = String(e.WE_RELATED_ITEMS_FILE_ITEM ?? '').trim().toLowerCase();
  if (FILE_ITEM_MODES.includes(mode)) { out.fileItem = mode; out.source.fileItem = 'env'; }
  const th = Number(e.WE_RELATED_ITEMS_THRESHOLD);
  if (String(e.WE_RELATED_ITEMS_THRESHOLD ?? '').trim() && VALID.threshold(th)) { out.threshold = th; out.source.threshold = 'env'; }
  return out;
}

/** PURE. One log line naming the decisive keys' values and sources. */
export function formatRelatedItemsPolicy(p) {
  const s = p.source ?? {};
  return `relatedItems.enabled=${p.enabled} (${s.enabled}), fileItem=${p.fileItem} (${s.fileItem}), `
    + `threshold=${p.threshold} (${s.threshold}), statuses=${p.statuses.join('|')} (${s.statuses}), `
    + `resolvedWithinDays=${p.resolvedWithinDays} (${s.resolvedWithinDays}), floor=${p.floor} (${s.floor}), limit=${p.limit} (${s.limit}), `
    + `queryTerms=${p.queryTerms} (${s.queryTerms}), weights=text:${p.weights.text}/scope:${p.weights.scope}/tags:${p.weights.tags} (${s.weights}), `
    + `synonyms=${p.synonyms.length} groups (${s.synonyms})`;
}

// ── Tokens with synonyms ─────────────────────────────────────────────────────────────────────────────────────────

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * PURE. The synonym folder for a group table: every term of a group (a word, a compound like `node_modules`, or a
 * phrase like `red team`; separators `space _ - / :` interchangeable; a plural/tense suffix tolerated) is rewritten to
 * the group's canonical token (its first term, letters and digits only). Longest terms first, so `npm ci` wins over
 * `npm`. Returns `{fold, labels}` — `labels` maps a canonical token back to its group for the "why" line.
 */
export function compileSynonyms(groups = []) {
  const rules = [];
  const labels = new Map();
  for (const group of groups) {
    const canon = String(group[0] ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (canon.length < 3) continue;
    // Keyed by the token the canonical actually becomes after stemming ("copyonwrite" → "copyonwrit").
    for (const t of claimTokens(canon)) labels.set(restem(t), group.join('/'));
    for (const term of group) {
      const parts = String(term).toLowerCase().trim().split(/[\s_\-/:]+/).filter(Boolean).map(escapeRe);
      if (!parts.length) continue;
      rules.push({ len: parts.join(' ').length, re: new RegExp(`(?<![a-z0-9])${parts.join('[\\s_\\-/:]*')}(?:s|es|ed|ing)?(?![a-z0-9])`, 'g'), canon });
    }
  }
  rules.sort((a, b) => b.len - a.len);
  const fold = (text) => {
    let s = String(text ?? '').toLowerCase();
    for (const r of rules) s = s.replace(r.re, ` ${r.canon} `);
    return s;
  };
  return { fold, labels };
}

/** PURE. Two endings the shared stemmer leaves apart, folded here only (card-dedupe's calibration is untouched): a
 *  plural `-ies` left as `-ie` ("copies" → "copy"), and a final `-e` ("share" meets "shared" → "shar"). */
const restem = (t) => {
  if (t.length > 4 && t.endsWith('ie')) return `${t.slice(0, -2)}y`;
  if (t.length > 4 && t.endsWith('e')) return t.slice(0, -1);
  return t;
};

/** PURE. The tokens of `text` after folding synonyms (`syn` from {@link compileSynonyms}). */
export const relatedTokens = (text, syn) => new Set([...claimTokens(syn ? syn.fold(text) : text)].map(restem));

// ── Cards ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** PURE. A frontmatter list value: a JSON-ish inline array, or the YAML `- item` lines that follow the key. */
function fmList(fm, key) {
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(fm);
  if (!m) return [];
  const inline = m[1].trim();
  if (inline.startsWith('[')) {
    try { const v = JSON.parse(inline); return Array.isArray(v) ? v.map(String) : []; } catch {
      return inline.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
  }
  if (inline) return [inline.replace(/^["']|["']$/g, '')];
  const after = fm.slice(m.index + m[0].length).split('\n').slice(1);
  const out = [];
  for (const line of after) {
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (!item) break;
    out.push(item[1].trim().replace(/^["']|["']$/g, ''));
  }
  return out;
}

const fmScalar = (fm, key) => new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, '') || null;

/** PURE. The lead paragraph after the `# ` title (bounded), skipping blank lines; '' when the card has none. */
function leadParagraph(body, cap = 1500) {
  const lines = body.split('\n');
  const at = lines.findIndex((l) => /^# /.test(l));
  const rest = at === -1 ? lines : lines.slice(at + 1);
  const para = [];
  for (const l of rest) {
    if (!l.trim()) { if (para.length) break; continue; }
    if (/^#{1,6} /.test(l)) break;
    para.push(l.trim());
  }
  return para.join(' ').slice(0, cap);
}

/** PURE. A backlog card as the ranker sees it, from its file name and text. */
export function relatedCardFromText({ rel, text }) {
  const src = String(text ?? '');
  const fm = /^---\n([\s\S]*?)\n---/.exec(src)?.[1] ?? '';
  const body = fm ? src.slice(src.indexOf('\n---', 3) + 4) : src;
  const name = String(rel ?? '').split('/').pop() ?? '';
  return {
    rel,
    id: /^([^-]+)-/.exec(name)?.[1] ?? name.replace(/\.md$/, ''),
    status: fmScalar(fm, 'status'),
    dateResolved: fmScalar(fm, 'dateResolved'),
    parent: fmScalar(fm, 'parent'),
    scope: fmList(fm, 'scope'),
    tags: fmList(fm, 'tags'),
    title: /^# (.+)$/m.exec(body)?.[1]?.trim() ?? '',
    lead: leadParagraph(body),
  };
}

const daysBetween = (fromIso, toIso) => (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400e3;

/** PURE. Is this card one the ranker considers (status, or resolved within the window)? */
export function isEligible(card, policy, today) {
  if (policy.statuses.includes(card.status)) return true;
  if (card.status !== 'resolved' || !card.dateResolved || !today) return false;
  const d = daysBetween(String(card.dateResolved).slice(0, 10), today);
  return Number.isFinite(d) && d >= 0 && d <= policy.resolvedWithinDays;
}

// ── Scope and tags ───────────────────────────────────────────────────────────────────────────────────────────────

/** PURE. One spelling for a scope entry: a locus (`we:` when bare), no leading `./`, no trailing `/`, no `:line`. */
export function normalizeScopePath(p) {
  let s = String(p ?? '').trim().replace(/^\.\//, '');
  if (!s) return '';
  if (!/^[a-z][a-z0-9-]*:/.test(s)) s = `we:${s}`;
  return s.replace(/:\d+(?:[:-]\d+)?$/, '').replace(/\/+$/, '');
}

const splitList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((s) => String(s).trim()).filter(Boolean);
const prefixOf = (a, b) => a === b || b.startsWith(`${a}/`);

/** PURE. Which query paths share a path prefix with the card's scope. */
export function scopeOverlap(queryScope, cardScope) {
  const q = splitList(queryScope).map(normalizeScopePath).filter(Boolean);
  const c = cardScope.map(normalizeScopePath).filter(Boolean);
  const matched = q.filter((p) => c.some((cp) => prefixOf(p, cp) || prefixOf(cp, p)));
  return { score: q.length ? matched.length / q.length : 0, matched };
}

// ── Ranking ──────────────────────────────────────────────────────────────────────────────────────────────────────

const round = (n) => Math.round(n * 1000) / 1000;
const ABOVE_IDS_CAP = 200;

/** PURE. One spelling for a card reference: no `#`, and a numeric id without leading zeros (`001` ≡ `1`). */
export const normalizeCardRef = (ref) => {
  const s = String(ref ?? '').trim().replace(/^#/, '');
  return /^\d+$/.test(s) ? String(Number(s)) : s;
};

/**
 * PURE. Rank `cards` against the query. Returns the eligible card count, the rows at or above `policy.floor`
 * (highest score first, ties to the lower id), and how many reach `policy.threshold`.
 * @param {{text: string, scope?: string|string[], tags?: string|string[], limit?: number, exclude?: string[]}} query
 * @param {Array<object>} cards - {@link relatedCardFromText} rows.
 * @param {object} policy - {@link resolveRelatedItemsPolicy}.
 * @param {string} today - `YYYY-MM-DD`.
 */
export function rankRelatedItems({ query, cards = [], policy, today }) {
  const syn = compileSynonyms(policy.synonyms);
  const exclude = new Set(splitList(query.exclude).map(normalizeCardRef));
  const pool = cards.filter((c) => !exclude.has(normalizeCardRef(c.id)) && isEligible(c, policy, today))
    .map((c) => ({ card: c, title: relatedTokens(c.title, syn), doc: relatedTokens(`${c.title} ${c.lead}`, syn) }));
  const text = String(query.text ?? '');
  const firstBreak = text.indexOf('\n');
  const head = relatedTokens(firstBreak === -1 ? text : text.slice(0, firstBreak), syn);
  const all = relatedTokens(text, syn);
  const qTags = new Set(splitList(query.tags).map((t) => t.toLowerCase()));
  const idf = buildIdf([...pool.map((p) => ({ tokens: p.doc })), { tokens: all }]);
  // A long filing (title line + digest) carries filler words. Its TITLE line is what it is about, so every title token
  // counts; the rest adds only its most distinctive tokens (highest IDF, ties by token) up to `queryTerms` in all (at
  // least 3), so a long text and a one-line idea score on the same scale.
  const rest = [...all].filter((t) => !head.has(t)).sort((a, b) => idf(b) - idf(a) || a.localeCompare(b));
  const Q = new Set([...head, ...rest.slice(0, Math.max(3, policy.queryTerms - head.size))]);
  let qWeight = 0;
  for (const t of Q) qWeight += idf(t);
  const w = policy.weights;
  const rows = [];
  for (const p of pool) {
    let covered = 0;
    let inTitle = 0;
    const terms = [];
    for (const t of Q) {
      if (p.doc.has(t)) { covered += idf(t); terms.push(t); }
      if (p.title.has(t)) inTitle += idf(t);
    }
    const coverage = qWeight ? covered / qWeight : 0;
    const titleCoverage = qWeight ? inTitle / qWeight : 0;
    const titleSim = claimSimilarity(Q, p.title, idf);
    const textScore = 0.5 * coverage + 0.3 * titleCoverage + 0.2 * titleSim;
    const scope = scopeOverlap(query.scope, p.card.scope);
    const sharedTags = p.card.tags.map((t) => String(t).toLowerCase()).filter((t) => qTags.has(t));
    const tags = qTags.size ? sharedTags.length / qTags.size : 0;
    const score = Math.min(1, w.text * textScore + w.scope * scope.score + w.tags * tags);
    // A floor above the threshold would hide a qualifying card from the gate, so the threshold caps it.
    if (score < Math.min(policy.floor, policy.threshold)) continue;
    terms.sort((a, b) => idf(b) - idf(a));
    rows.push({
      id: p.card.id, title: p.card.title, status: p.card.status, rel: p.card.rel, score: round(score),
      parts: { text: round(textScore), coverage: round(coverage), titleCoverage: round(titleCoverage), title: round(titleSim), scope: round(scope.score), tags: round(tags) },
      why: { terms: terms.map((t) => syn.labels.get(t) ?? t), paths: scope.matched, tags: sharedTags },
    });
  }
  rows.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
  const limit = posInt(query.limit) ? query.limit : policy.limit;
  const above = rows.filter((r) => r.score >= policy.threshold);
  const named = new Set(splitList(query.named).map(normalizeCardRef));
  return {
    query: { text: query.text, scope: splitList(query.scope), tags: [...qTags] },
    eligible: pool.length,
    threshold: policy.threshold,
    aboveThreshold: above.length,
    // Every card over the threshold (bounded), independent of `limit` — the file-item gate is satisfied by naming ANY of them.
    aboveIds: above.slice(0, ABOVE_IDS_CAP).map((r) => String(r.id)),
    // The `query.named` cards (a filing's --related/--parent) that are over the threshold — checked against EVERY
    // qualifying row, so the gate never depends on the display caps above.
    namedAbove: above.filter((r) => named.has(normalizeCardRef(r.id))).map((r) => String(r.id)),
    matches: rows.slice(0, limit),
  };
}

/** PURE. Human lines for one ranking. */
export function renderRelatedItems(result, { policyLine = null } = {}) {
  const lines = [];
  if (result.disabled) return [`related-items: off (${policyLine ?? 'relatedItems.enabled=false'})`];
  lines.push(`related-items: ${result.matches.length} match(es) of ${result.eligible} eligible card(s); ${result.aboveThreshold} at or above threshold ${result.threshold}`);
  for (const m of result.matches) {
    const flag = m.score >= result.threshold ? '!' : ' ';
    lines.push(`${flag} ${m.score.toFixed(2)}  #${m.id} (${m.status}) ${m.title}`);
    const why = [];
    if (m.why.terms.length) why.push(`terms: ${m.why.terms.slice(0, 8).join(', ')}`);
    if (m.why.paths.length) why.push(`paths: ${m.why.paths.join(', ')}`);
    if (m.why.tags.length) why.push(`tags: ${m.why.tags.join(', ')}`);
    if (why.length) lines.push(`          ${why.join(' · ')}`);
  }
  if (policyLine) lines.push(`policy: ${policyLine}`);
  return lines;
}

// ── The file-item gate ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * PURE. What `file-item` does with the ranking. A filing is SATISFIED when it names a matched (≥ threshold) card in
 * `--parent` or `--related`, or gives a `--new-because` reason. Mode `refuse` + unsatisfied refuses the filing;
 * `warn` prints the matches and files anyway; `off` (or `enabled: false`) skips the check.
 * @returns {{mode: string, checked: boolean, refuse: boolean, satisfied: boolean, above: string[], lines: string[], result: object|null}}
 */
export function planRelatedGate({ result, policy, input = {} }) {
  const mode = policy?.enabled === false ? 'off' : (policy?.fileItem ?? 'off');
  const none = { mode, checked: false, refuse: false, satisfied: true, above: [], lines: [], result: null };
  if (mode === 'off' || !result) return none;
  const above = result.aboveIds ?? result.matches.filter((m) => m.score >= result.threshold).map((m) => String(m.id));
  const named = new Set([...splitList(input.related), ...splitList(input.parent)].map(normalizeCardRef));
  const namedHit = Array.isArray(result.namedAbove) && result.namedAbove.length > 0;
  const satisfied = !above.length || namedHit || above.some((id) => named.has(normalizeCardRef(id))) || Boolean(String(input.newBecause ?? '').trim());
  const refuse = mode === 'refuse' && !satisfied;
  const lines = above.length ? [
    `file-item: ${above.length} existing card(s) look related to this filing (mode ${mode}):`,
    ...renderRelatedItems({ ...result, matches: result.matches.filter((m) => m.score >= result.threshold) }),
    satisfied ? 'file-item: the filing names one of them (or says why it is new) — filing.'
      : refuse ? 'file-item: REFUSED — name the related card with --related=<id> (or --parent=<id>), or say why this is new with --new-because="<reason>".'
        : 'file-item: warn-only — filing anyway. Name the related card with --related=<id>, or --new-because="<reason>".',
  ] : [];
  return { mode, checked: true, refuse, satisfied, above, lines, result };
}

/** PURE. The digest line recording what the filer said about related cards; '' when it said nothing. */
export function relatedDigestNote(input = {}) {
  const related = splitList(input.related).map((s) => `#${s.replace(/^#/, '')}`);
  const because = String(input.newBecause ?? '').trim().replace(/\s+/g, ' ');
  const parts = [];
  if (related.length) parts.push(`Related: ${related.join(', ')}.`);
  if (because) parts.push(`New because: ${because}`);
  return parts.join(' ');
}
