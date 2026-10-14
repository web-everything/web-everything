/**
 * @file scripts/backlog/frontmatter.mjs
 * @description Surgical backlog-frontmatter editing — the shared core behind the `backlog.mjs`
 * status verbs (claim / resolve / release / scaffold).
 *
 * The mechanical half of backlog work — flipping `status`, stamping `dateStarted`/`dateResolved`,
 * setting `graduatedTo` — is pure frontmatter field hygiene the agent currently does by hand (re-read,
 * reason, Edit), burning a tool round-trip and context on every item. This module does it
 * deterministically with one rule borrowed from `readiness/engine.mjs#spliceStaleEdges` and the
 * intents-JSON footgun lesson: **splice the single line, never round-trip the whole document.** Only
 * the frontmatter block (first `---` … next `---`) is ever touched; the body is byte-for-byte
 * preserved, so a status flip can never disturb prose, a digest, or a `## Progress` block.
 *
 * PURE — no fs, no process, no `Date`. The CLI injects the file text and "today" so the same logic
 * runs against the live backlog or an in-memory fixture in tests.
 */

import { CLOSED_REASONS } from '../lib/backlog-status.cjs';

import { usdFromTokens, parseCostTokens, formatCostTokens } from './cost-rates.mjs';

/** Match a top-level `key:` line inside the frontmatter (not indented list items). */
const keyLineRe = (key) => new RegExp(`^${key}:.*$`, 'm');

/**
 * Locate the frontmatter block. Returns `{ start, end, block }` where `block` is the text *between*
 * the opening and closing `---` (start = first char after the opening `---\n`, end = index of the
 * closing `---`), or `null` if the document has no frontmatter.
 */
function locateFrontmatter(content) {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const start = fm.index + fm[0].indexOf('\n') + 1;
  const end = fm.index + fm[0].length - 3; // index of the closing `---`
  return { start, end, block: content.slice(start, end) };
}

/** Read a top-level scalar frontmatter field's raw (unquoted, untrimmed-of-quotes) value, or `undefined`. */
export function readField(content, key) {
  const fm = locateFrontmatter(content);
  if (!fm) return undefined;
  const m = fm.block.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  if (!m) return undefined;
  return m[1].trim().replace(/^["']|["']$/g, '') || undefined;
}

/**
 * Set a top-level scalar frontmatter field. If the key already exists, its line is replaced in place;
 * otherwise the new line is inserted **after** the last present key from `after` (so a stamped date
 * lands next to `dateOpened`/`status` rather than at the bottom), falling back to just before the
 * closing `---`. Returns the new content, or `null` if there's no frontmatter to edit.
 *
 * @param {string} content
 * @param {string} key
 * @param {string} rendered  The value text as it should appear (already quoted if a string: `'"2026-06-10"'`).
 * @param {{ after?: string[] }} [opts]  Anchor keys for insertion when the field is absent.
 * @returns {string|null}
 */
export function setFrontmatterField(content, key, rendered, { after = [] } = {}) {
  const fm = locateFrontmatter(content);
  if (!fm) return null;
  const line = `${key}: ${rendered}`;
  const existing = fm.block.match(keyLineRe(key));
  let newBlock;
  if (existing) {
    newBlock = fm.block.replace(keyLineRe(key), line);
  } else {
    const lines = fm.block.split('\n');
    let insertAt = lines.length; // default: end of block (just before closing ---)
    // The block ends with a trailing '' element (the newline before `---`); insert before it.
    if (lines[lines.length - 1] === '') insertAt = lines.length - 1;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^([A-Za-z0-9_]+):/);
      if (m && after.includes(m[1])) insertAt = i + 1;
    }
    lines.splice(insertAt, 0, line);
    newBlock = lines.join('\n');
  }
  return content.slice(0, fm.start) + newBlock + content.slice(fm.end);
}

/**
 * Remove a top-level scalar frontmatter field's whole line (the counterpart to {@link setFrontmatterField},
 * for the CLI's `--clear`/`remove` forms — e.g. `build-queue remove`, #2530). CRLF-safe: it reuses
 * `locateFrontmatter` (unlike a hand-rolled `---\n` regex, which silently no-ops on a CRLF file and would
 * leave a safety flag set). Scoped to the frontmatter block, never the body. A no-op (returns `content`
 * unchanged) when the field is absent or there is no frontmatter.
 * @param {string} content @param {string} key @returns {string}
 */
export function removeFrontmatterField(content, key) {
  const fm = locateFrontmatter(content);
  if (!fm) return content;
  // Drop the `key: …` line INCLUDING its line-ending (CRLF or LF), leaving no blank line. No-op if absent.
  const newBlock = fm.block.replace(new RegExp(`^${key}:.*(?:\\r?\\n|$)`, 'm'), '');
  return content.slice(0, fm.start) + newBlock + content.slice(fm.end);
}

/** Today's date as a quoted `"YYYY-MM-DD"` string, ready to drop into frontmatter. The CLI passes the value. */
export const quoteDate = (ymd) => `"${ymd}"`;

/**
 * Fold a session's usage into a card's cumulative cost accounting — the close-time cost-on-card record.
 * PURE (caller reads the file, supplies the token counts).
 *
 * The DURABLE field is the cumulative token breakdown `costTokens` (`in:.. cw:.. cr:.. out:..`, raw
 * integers). `costUsd` is strictly DERIVED: recomputed from the cumulative tokens through the one shared
 * rate table (`cost-rates.mjs`) at every accrual, so it can never again drift from a stale hardcoded rate
 * and is always regenerable from what's stored. `costSessions` is the cumulative contributing-share count.
 *
 * Accumulates: a decision worked across /prepare then /decide sums into one running total, and a
 * workflow's even-split share lands on each item it touched. USD rounds to whole cents (diff-quiet).
 * `sessions` defaults to 1. Returns the new content, or `null` if there's no frontmatter to edit.
 *
 * The card's aggregate tokens carry no per-model or per-cache-tier split, so `costUsd` is derived at the
 * default (opus) rates with cache-writes priced at the 1-hour tier — this user's regime. That is a
 * deliberate, documented approximation; the raw tokens are what's authoritative and re-priceable.
 * @param {string} content
 * @param {{in?:number,cw?:number,cr?:number,out?:number}} tokens  token counts to ADD to the running total
 * @param {{ sessions?: number }} [opts]
 * @returns {string|null}
 */
export function accrueCost(content, tokens = {}, { sessions = 1 } = {}) {
  const prev = parseCostTokens(readField(content, 'costTokens'));
  const prevN = Number(readField(content, 'costSessions')) || 0;
  const cum = {
    in:  prev.in  + (Number(tokens.in)  || 0),
    cw:  prev.cw  + (Number(tokens.cw)  || 0),
    cr:  prev.cr  + (Number(tokens.cr)  || 0),
    out: prev.out + (Number(tokens.out) || 0),
  };
  const nextUsd = Math.round(usdFromTokens(cum) * 100) / 100;
  const AFTER = ['costTokens', 'costUsd', 'dateResolved', 'dateStarted', 'dateOpened', 'preparedDate', 'status', 'size', 'kind'];
  let next = setFrontmatterField(content, 'costTokens', quoteScalar(formatCostTokens(cum)), { after: AFTER });
  if (next == null) return null;
  next = setFrontmatterField(next, 'costUsd', String(nextUsd), { after: ['costTokens', ...AFTER] });
  next = setFrontmatterField(next, 'costSessions', String(prevN + sessions), { after: ['costUsd', 'costTokens', ...AFTER] });
  return next;
}

/**
 * Render a free-text scalar as a safe frontmatter value, double-quoting it **iff** it carries a
 * YAML-significant character that would make an unquoted (plain) scalar misparse — a colon (the
 * `key: value` separator), a `#` (comment intro), a leading YAML indicator char
 * (`-?:[]{}#&*!|>%@\`"'` or surrounding whitespace), or a newline. Without this, a `graduatedTo`
 * value like `the gap-sweep: skill` or `#492 ruling` silently breaks the YAML loader, dropping the
 * whole item from the projection and every dependent's `blockedBy` resolution (#603, hit 3× in one
 * batch). Quoting is always semantically safe; we skip it only to keep simple slugs diff-quiet.
 * An already-quoted value (matching outer `"…"` or `'…'`) is passed through untouched.
 * @param {string} value
 * @returns {string} the value text ready to splice after `key: `
 */
export function quoteScalar(value) {
  const v = String(value);
  if (v === '') return '""';
  if (/^".*"$/s.test(v) || /^'.*'$/s.test(v)) return v; // author already quoted it
  const needsQuote =
    /[:#]/.test(v) ||                          // colon (key/value sep) or hash (comment intro) anywhere
    /^[\s\-?:[\]{}#&*!|>%@`"']/.test(v) ||      // leading YAML indicator char or whitespace
    /\s$/.test(v) ||                            // trailing whitespace
    /[\n\r]/.test(v);                           // a newline can't live in a plain scalar
  if (!needsQuote) return v;
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Validate a `codifiedIn` value for the #911 resolve gate. Returns an error string to refuse the
 * resolve, or `null` if the value is an acceptable statute pointer. Accepts the `one-off` sentinel
 * (a narrow call that establishes no reusable rule, analogous to `graduatedTo: none`) or a guideline
 * path — a `docs/….md` file, optionally with an `#anchor` into the named rule. A bare anchor, an
 * empty string, or `undefined` is refused with the actionable next step.
 * @param {string|undefined} value
 * @returns {string|null}
 */
export function validateCodifiedIn(value) {
  const v = (value ?? '').trim().replace(/^["']|["']$/g, '');
  const HINT =
    'a `kind: decision` resolves only with `codifiedIn` (#911). Promote its rule to the statute layer ' +
    '(docs/agent/platform-decisions.md#<anchor>, or the topical docs/agent/*.md it belongs to) and pass ' +
    '`--codified-to=<path#anchor>`. For a narrow call that yields no reusable rule, pass `--codified-to=one-off`.';
  if (!v) return `no codifiedIn — ${HINT}`;
  if (v === 'one-off') return null;
  if (/^docs\/[\w./-]+\.md(#[\w./-]+)?$/.test(v)) return null;
  return `codifiedIn "${v}" is not a valid statute pointer — ${HINT}`;
}

/**
 * Apply a status transition + its stamps in one splice pass. Pure: caller supplies `today`.
 *
 *   claim:   open    → active    + dateStarted
 *   resolve: active  → resolved  + dateResolved (+ graduatedTo if given)
 *   release: active  → open      (stamps untouched — Progress says where it stopped)
 *
 * Enforces the legal `from` status so a script can't silently double-claim or resolve an open item.
 * Returns `{ content }` on success or `{ error }` if the transition is illegal or unspliceable —
 * the CLI turns the latter into a non-zero exit, never a half-written file.
 *
 * `claim` accepts `as: 'preparing'` (#375) — a decision being *researched* by /prepare, not built. It is
 * a non-`open`, in-flight state (drops from selection exactly like `active`) but reads distinctly on the
 * board; `release` returns either `active` or `preparing` to `open`.
 *
 * **Codification gate (#911 discipline, hard-enforced here):** a `kind: decision` cannot be resolved
 * without a `codifiedIn` — the statute-layer pointer that promotes its reusable rule out of the
 * case-law chain (or the sanctioned `one-off` sentinel for a narrow call). The CLI passes `codifiedTo`
 * to stamp it inline; absent both an existing field and the flag, the resolve is refused. This is what
 * turns G6 from a "candidate pool you sweep later" into a "you can't resolve a decision and walk away
 * from the rule" invariant — the cheapest moment to capture orientation is at resolve, with the
 * deliberation fresh.
 *
 * `unresolve` — #2779-incident (2026-09-26 03:14Z): the drain's resolve-on-land bookkeeping flipped a card to
 * `resolved` on the strength of a branch-name coincidence, not real delivered work, and no product path
 * existed to undo it short of hand-editing `main`. `resolved → open` is the counterpart transition: it exists
 * ONLY for correcting a resolve that should never have happened (an evidence failure, not a status the card
 * ever legitimately outgrows on its own), so it strips `dateResolved`/`graduatedTo`/`codifiedIn` — none of
 * those were legitimately earned either — and requires a `reason` (recorded by the caller, never silent).
 * Always requires the CLI's `--force` (mirrors `release`'s rare-deliberate-abandon gate): reopening a resolved
 * card is uncommon enough that an unintentional call should have to say so explicitly.
 *
 * @param {string} content
 * @param {'claim'|'resolve'|'release'|'unresolve'|'close'|'reopen'} verb
 * @param {{ today: string, graduatedTo?: string, codifiedTo?: string, as?: 'active'|'preparing', reason?: string, into?: string, by?: string }} opts
 * @returns {{ content: string } | { error: string }}
 */
export function applyTransition(content, verb, { today, graduatedTo, codifiedTo, as, reason, into, by } = {}) {
  const status = readField(content, 'status');
  const DATE_ANCHORS = ['dateOpened', 'dateStarted', 'dateResolved', 'status', 'blockedBy', 'size', 'kind'];

  if (verb === 'close') {
    if (status !== 'open' && status !== 'parked') return { error: `status is "${status}", expected "open" or "parked" — in-flight and terminal items cannot close` };
    if (!CLOSED_REASONS.has(reason)) return { error: `reason must be ${[...CLOSED_REASONS].join(' / ')}` };
    if (reason === 'duplicate' && !String(into ?? '').trim()) return { error: 'duplicate requires into' };
    if (into !== undefined && reason !== 'duplicate') return { error: 'into is only allowed for duplicate' };
    if (by !== undefined && reason !== 'fixed-elsewhere') return { error: 'by is only allowed for fixed-elsewhere' };
    let next = setFrontmatterField(content, 'status', 'closed');
    next = setFrontmatterField(next, 'closedReason', quoteScalar(reason), { after: ['status'] });
    if (into !== undefined) next = setFrontmatterField(next, 'closedInto', JSON.stringify(String(into).trim()), { after: ['closedReason'] });
    if (by !== undefined) next = setFrontmatterField(next, 'closedBy', JSON.stringify(String(by)), { after: ['closedReason'] });
    next = setFrontmatterField(next, 'dateClosed', quoteDate(today), { after: ['closedReason', 'closedInto', 'closedBy'] });
    return { content: next };
  }
  if (verb === 'reopen') {
    if (status !== 'closed') return { error: `status is "${status}", expected "closed"` };
    if (!String(reason ?? '').trim()) return { error: 'reopen requires a non-empty reason' };
    let next = setFrontmatterField(content, 'status', 'open');
    for (const field of ['closedReason', 'closedInto', 'closedBy', 'dateClosed']) next = removeFrontmatterField(next, field);
    next = setFrontmatterField(next, 'reopenedReason', JSON.stringify(String(reason).trim()), { after: ['status'] });
    next = setFrontmatterField(next, 'dateReopened', quoteDate(today), { after: ['reopenedReason'] });
    return { content: next };
  }
  if (verb === 'claim') {
    if (status !== 'open') return { error: `status is "${status}", expected "open" — lost the race or already claimed` };
    const target = as === 'preparing' ? 'preparing' : 'active';
    let next = setFrontmatterField(content, 'status', target);
    next = setFrontmatterField(next, 'dateStarted', quoteDate(today), { after: DATE_ANCHORS });
    return next ? { content: next } : { error: 'could not splice frontmatter' };
  }
  if (verb === 'resolve') {
    if (status !== 'active' && status !== 'open') return { error: `status is "${status}", expected "active" — only an in-flight item is resolved` };
    // Codification gate (#911): a decision must carry its rule into the statute layer before it resolves.
    if (readField(content, 'kind') === 'decision') {
      const existing = readField(content, 'codifiedIn');
      const codErr = validateCodifiedIn(codifiedTo ?? existing);
      if (codErr) return { error: codErr };
    }
    let next = setFrontmatterField(content, 'status', 'resolved');
    next = setFrontmatterField(next, 'dateResolved', quoteDate(today), { after: DATE_ANCHORS });
    if (graduatedTo) next = setFrontmatterField(next, 'graduatedTo', quoteScalar(graduatedTo), { after: ['dateResolved', ...DATE_ANCHORS] });
    if (codifiedTo) next = setFrontmatterField(next, 'codifiedIn', quoteScalar(codifiedTo), { after: ['graduatedTo', 'dateResolved', ...DATE_ANCHORS] });
    return next ? { content: next } : { error: 'could not splice frontmatter' };
  }
  if (verb === 'release') {
    if (status !== 'active' && status !== 'preparing') return { error: `status is "${status}", expected "active" or "preparing" — only an in-flight claim is released` };
    const next = setFrontmatterField(content, 'status', 'open');
    return next ? { content: next } : { error: 'could not splice frontmatter' };
  }
  if (verb === 'unresolve') {
    if (status !== 'resolved') return { error: `status is "${status}", expected "resolved" — only a resolved item can be unresolved` };
    if (!reason || !String(reason).trim()) return { error: '`reason` is required — unresolve is a correction, never a silent one (e.g. --reason="resolved without evidence, #2779-incident")' };
    let next = setFrontmatterField(content, 'status', 'open');
    // None of these were legitimately earned by a resolve that should never have happened.
    next = removeFrontmatterField(next, 'dateResolved');
    next = removeFrontmatterField(next, 'graduatedTo');
    next = removeFrontmatterField(next, 'codifiedIn');
    next = setFrontmatterField(next, 'unresolvedReason', quoteScalar(String(reason).trim()), { after: ['status'] });
    next = setFrontmatterField(next, 'dateUnresolved', quoteDate(today), { after: ['unresolvedReason', 'status'] });
    return next ? { content: next } : { error: 'could not splice frontmatter' };
  }
  return { error: `unknown verb "${verb}"` };
}

/**
 * settle — publish a born-active scaffold (`scaffold --session=<slug>`) to `status: open` once its
 * digest+edges+body are authored: active → open, stripping the session-ownership stamps
 * (`scaffoldedBy`/`dateScaffolded`). Only legal from a scaffold that actually carries `scaffoldedBy` — a
 * normally-claimed item is closed by `applyTransition(…, 'resolve', …)`, not this. Extracted out of
 * `scripts/backlog.mjs#settle` (and no longer duplicated in `scripts/mine-golden-corpus.mjs`'s
 * self-validation replay) so there is exactly one implementation the CLI, the corpus miner, and the
 * Tier-A snapshot harness (#2273) all call — a single source of truth immune to two-copy drift.
 *
 * PURE — same contract as `applyTransition`: no fs, no process, no `Date`.
 *
 * @param {string} content
 * @returns {{ content: string } | { error: string }}
 */
export function applySettle(content) {
  if (!/^scaffoldedBy:/m.test(content))
    return { error: 'not a born-active scaffold (no scaffoldedBy) — a claimed item is closed by resolve, not settle' };
  const next = content
    .replace(/^status: active$/m, 'status: open')
    .replace(/^scaffoldedBy: .*\n/m, '')
    .replace(/^dateScaffolded: .*\n/m, '');
  return { content: next };
}
