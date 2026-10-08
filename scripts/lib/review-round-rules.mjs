/**
 * @file scripts/lib/review-round-rules.mjs
 * @description The review-round RULES for card 5469 (fixer/review proposal B1 part 1, operator rulings P3/P4/P5 and the
 *   cross-cutting "pure rule + declared settings + replay fixtures" requirement, 2026-10-08). Pure decisions over plain
 *   facts, written to move into the delivery standard as-is (protocol card 5468): no forge, label, process, clock or file
 *   detail inside a rule. The core around them (we:scripts/operations/review-pr-io.mjs, the `review.ledger-events` sink)
 *   reads git and the ledger, calls these rules, appends the ledger rows and writes the shadow journal.
 *
 * WHY. Every review round re-reads the full net diff and keeps only a COUNT of past rounds, so round N+1 samples new
 * findings on code round N already saw (`later-round-find` 9 → 29 on 2026-10-08). These rules give a finding a stable
 * identity across rounds and say what a scoped re-review with a binding prior round WOULD decide. In shadow they change
 * no verdict: the live review stays the full one (card 5469 [A4], [N1]).
 *
 * THE RULES
 *   R1 finding-identity     — identity = path + symbol + defect class, scoped per repo and PR. Never free text: the
 *                             summary, quote and prevention prose are data and never enter the id ([A2], edge 1).
 *   R2 enclosing-symbol     — the symbol is the nearest top-level declaration above the cited line in the file at the
 *                             reviewed head (or the nearest Markdown heading). Deterministic, and stable when the line
 *                             moves; a renamed symbol is a new identity (edge 5).
 *   R3 last-reviewed-head   — read from the ledger's review-run rows, never from the clock (edge 6).
 *   R4 review-scope         — round N+1's scope = the diff since the last reviewed head + the sent-back findings + the
 *                             card's Acceptance list. Round 1, or an unknown/unreadable prior head, is a FULL review
 *                             (the fail-closed direction, edges 2 and 4).
 *   R5 finding-status       — this head's status per identity: raised | tolerated | carded, plus `fixed` for an identity
 *                             raised before, not reported now, whose cited code the fix range changed.
 *   R6 binding-prior-round  — P3, as a SHADOW decision for each finding that held the live verdict: on code unchanged
 *                             since the last reviewed head, a late or tolerated finding becomes a card; it still blocks when
 *                             it is CONFIRMED + broken (or worse), when it carries a sent-back finding, when it sits on
 *                             changed code, or when its position cannot be placed. Confirmed-broken ALWAYS blocks.
 *   R7 shadow-round         — the round's journal entry: per-finding would-block / would-card, and whether the round
 *                             (and so the next one) would have been avoided.
 *
 * THE SETTING (declared in we:scripts/review-settings.json, resolved by we:scripts/lib/review-settings.mjs):
 *   scopedRereview  env WE_REVIEW_SCOPED_REREVIEW  built-in `off` (today: full re-review, no ledger finding rows, no
 *                   journal) | `shadow` (compute + journal; no verdict changes). `on` is card 5470's, after 3 days of
 *                   shadow (P3).
 */
import { createHash } from 'node:crypto';
import { exactCitedPath, findingChangeState, normalizeFinding, earnsRound, isFindingOutstanding,
  requiresMandatoryReferral, MANDATORY_LENSES } from './jury-core.mjs';
import { FINDING_STATUS_VALUES } from './verdict-ledger.mjs';

/** The statuses, by name (R5). The ledger schema owns the closed set. */
export const FINDING_STATUSES = Object.freeze({
  RAISED: FINDING_STATUS_VALUES[0], TOLERATED: FINDING_STATUS_VALUES[1], FIXED: FINDING_STATUS_VALUES[2], CARDED: FINDING_STATUS_VALUES[3],
});

/** R6's two answers. */
export const ROUND_DECISIONS = Object.freeze({ BLOCK: 'block', CARD: 'card' });

/** Why R6 decided what it did, one code per branch, in rule order. */
export const ROUND_DECISION_REASONS = Object.freeze({
  FULL_REVIEW: 'full-review',                       // no usable prior head / delta: today's full review stands
  NO_CITATION: 'no-citation',                       // cites no file: cannot be placed against the delta
  CHANGED_CODE: 'changed-code',                     // within the delta (the scoped review would see it)
  CHANGE_UNPLACEABLE: 'change-unplaceable',         // the cited file changed but the change cannot be placed
  CONFIRMED_BROKEN: 'confirmed-broken',             // CONFIRMED + broken/unrecoverable: always blocks
  SENT_BACK_CARRY: 'sent-back-carry',               // the same identity was raised (sent back) last round
  RERAISE_OF_FIXED: 'reraise-of-fixed',             // re-raise of a fixed identity on unchanged code, no stated cause
  TOLERATED_UNCHANGED: 'tolerated-on-unchanged-code',
  CARDED_UNCHANGED: 'carded-on-unchanged-code',
  LATE_UNCHANGED: 'late-on-unchanged-code',         // first raised in a later round on code round N already saw
});

/** A stable finding id: `fi-` + 12 hex (the ledger's STABLE_FINDING_ID_PATTERN). */
const ID_PREFIX = 'fi-';

/**
 * R1 — the defect class of a finding: the part of its `category` after the lens (`security/fail-open` → `fail-open`),
 * lower-cased; the lens itself when the category has no class; `unknown` when it has neither. PURE.
 * @param {object} finding
 * @returns {string}
 */
export function findingDefectClass(finding) {
  const category = String(finding?.category ?? '').trim().toLowerCase();
  if (!category) return 'unknown';
  const parts = category.split('/').map((p) => p.trim()).filter(Boolean);
  return (parts.length > 1 ? parts.slice(1).join('/') : parts[0]) || 'unknown';
}

const DECLARATION_PATTERNS = Object.freeze([
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/,
  /^(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^(?:describe|it|test)(?:\.\w+)?\(\s*(['"`])((?:(?!\1).){1,120})\1/,
]);

/**
 * R2 — the symbol a cited line sits in: the nearest TOP-LEVEL declaration at or above `line` (column 0: function,
 * class, const/let/var, interface/type/enum, or a top-level `describe`/`it`/`test` block), or the nearest heading in a
 * Markdown file. Top-level only, on purpose: an inner `const` a fixer adds above the line must not change the identity.
 * Empty string when the line is absent, out of range, or under no declaration. PURE.
 * @param {string} text - the file at the reviewed head.
 * @param {number} line - 1-based.
 * @param {string} [path] - only its extension is read.
 * @returns {string}
 */
export function enclosingSymbol(text, line, path = '') {
  if (typeof text !== 'string' || !Number.isInteger(line) || line < 1) return '';
  const lines = text.split('\n');
  if (line > lines.length) return '';
  const markdown = /\.(md|markdown)$/i.test(String(path));
  for (let i = line - 1; i >= 0; i--) {
    const l = lines[i];
    if (markdown) {
      const h = l.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (h) return `${h[1]} ${h[2]}`.slice(0, 200);
      continue;
    }
    if (!l || /^\s/.test(l)) continue;
    for (const re of DECLARATION_PATTERNS) {
      const m = l.match(re);
      if (m) return (m[2] !== undefined ? `${l.match(/^\w+/)[0]}:${m[2]}` : m[1]).slice(0, 200);
    }
  }
  return '';
}

/**
 * R1 — a finding's stable identity. `symbol` comes from R2 (the caller reads the file); a finding with no file has
 * an empty path and symbol and is identified by its class alone within the PR. Scoped per repo and PR: the same
 * triple on another PR is another id. `null` for a value that is not a finding. PURE.
 * @param {object} finding
 * @param {{repo: string, pr: number|string, symbol?: string}} o
 * @returns {{findingId: string, path: string, symbol: string, defectClass: string}|null}
 */
export function findingIdentity(finding, { repo, pr, symbol = '' } = {}) {
  const f = normalizeFinding(finding);
  if (!f) return null;
  const path = f.file ? exactCitedPath(f.file) : '';
  const sym = path ? String(symbol ?? '') : '';
  const defectClass = findingDefectClass(f);
  const findingId = `${ID_PREFIX}${createHash('sha256').update(JSON.stringify([String(repo ?? ''), String(pr ?? ''), path, sym, defectClass])).digest('hex').slice(0, 12)}`;
  return { findingId, path, symbol: sym, defectClass };
}

/**
 * R3 — the last head reviewed BEFORE `head`, from the PR's review-run rows in append order: the latest row whose
 * head differs from `head`. A same-head re-run therefore scopes against the head before it. `null` when no earlier
 * head is recorded (round 1, or rows missing — the caller then runs the full review). PURE.
 * @param {Array<{headSha?: string}>} reviewRuns
 * @param {string} head
 * @returns {string|null}
 */
export function lastReviewedHead(reviewRuns, head) {
  const current = String(head ?? '').toLowerCase();
  const rows = Array.isArray(reviewRuns) ? reviewRuns : [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const h = typeof rows[i]?.headSha === 'string' ? rows[i].headSha.toLowerCase() : '';
    if (h && h !== current) return h;
  }
  return null;
}

/**
 * The review round on `head`: 1 + the number of distinct heads reviewed before it. PURE.
 * @param {Array<{headSha?: string}>} reviewRuns
 * @param {string} head
 * @returns {number}
 */
export function reviewRoundOf(reviewRuns, head) {
  const current = String(head ?? '').toLowerCase();
  const seen = new Set((Array.isArray(reviewRuns) ? reviewRuns : [])
    .map((r) => (typeof r?.headSha === 'string' ? r.headSha.toLowerCase() : '')).filter((h) => h && h !== current));
  return seen.size + 1;
}

/**
 * R4 — what round N+1 reviews. `full` when there is no prior head or the delta is unknown/unreadable (today's
 * behaviour, the safe direction); otherwise `delta`: the changed files and lines since the last reviewed head, plus
 * the identities sent back last round (`carried`), plus the card's Acceptance ids. PURE.
 * @param {{priorHead: string|null, head: string, delta: object|null, sentBack?: string[], acceptance?: string[]}} facts
 * @returns {{kind: 'full'|'delta', reason: string, priorHead: string|null, head: string,
 *   files: Record<string, number[]|null>, carried: string[], acceptance: string[]}}
 */
export function reviewScope({ priorHead = null, head = '', delta = null, sentBack = [], acceptance = [] } = {}) {
  const base = { priorHead: priorHead || null, head: String(head ?? ''), files: {}, carried: [], acceptance: [] };
  if (!priorHead) return { kind: 'full', reason: 'round-1', ...base };
  // The delta must be the range from exactly this prior head, and readable: a probe on an empty finding answers
  // `null` for any unreadable or malformed range.
  if (!delta || delta.priorHead !== priorHead || findingChangeState({}, delta) === null) {
    return { kind: 'full', reason: delta?.error ? `delta-unreadable: ${delta.error}` : 'delta-unknown', ...base };
  }
  return {
    kind: 'delta', reason: 'delta', ...base, files: delta.files,
    carried: [...new Set((Array.isArray(sentBack) ? sentBack : []).filter((x) => typeof x === 'string'))],
    acceptance: [...new Set((Array.isArray(acceptance) ? acceptance : []).filter((x) => typeof x === 'string'))],
  };
}

/**
 * Did this finding hold the LIVE verdict? A finding from a verdict-basis lens that is outstanding and earns a round,
 * or any finding that forces a mandatory referral (CONFIRMED + broken/unrecoverable, which parks the PR). PURE.
 * @param {object} finding - lens-tagged (`category: '<lens>/<class>'`).
 * @param {{basisLenses?: string[]}} [o] - the lenses whose seats reduce into the verdict (not advisory seats).
 * @returns {boolean}
 */
export function findingHeldVerdict(finding, { basisLenses = MANDATORY_LENSES } = {}) {
  const f = normalizeFinding(finding);
  if (!f) return false;
  if (requiresMandatoryReferral(f)) return true;
  const lens = String(f.category ?? '').split('/')[0].trim().toLowerCase();
  return (Array.isArray(basisLenses) ? basisLenses : MANDATORY_LENSES).includes(lens) && isFindingOutstanding(f) && earnsRound(f);
}

/**
 * R5 — a reported finding's status on this head. PURE.
 * @param {{heldVerdict: boolean, deferred?: boolean}} facts
 * @returns {'raised'|'tolerated'|'carded'}
 */
export function roundFindingStatus({ heldVerdict, deferred = false } = {}) {
  if (deferred) return FINDING_STATUSES.CARDED;
  return heldVerdict ? FINDING_STATUSES.RAISED : FINDING_STATUSES.TOLERATED;
}

/**
 * Fold prior ledger finding rows into the latest status per identity, for one PR, EXCLUDING rows on `head` (this
 * round's own rows, on a replay). Rows from another PR or with an unknown status are ignored. PURE.
 * @param {Array<object>} rows - ledger events in append order.
 * @param {{pr: number, head?: string}} o
 * @returns {Map<string, {status: string, headSha: string, round: number, path: string, symbol: string, defectClass: string}>}
 */
export function foldFindingStatuses(rows, { pr, head = '' } = {}) {
  const out = new Map();
  const current = String(head ?? '').toLowerCase();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r?.type !== 'finding' || Number(r.pr) !== Number(pr)) continue;
    if (!FINDING_STATUS_VALUES.includes(r.status) || typeof r.findingId !== 'string') continue;
    if (current && String(r.headSha ?? '').toLowerCase() === current) continue;
    out.set(r.findingId, { status: r.status, headSha: r.headSha, round: r.round, path: r.path, symbol: r.symbol, defectClass: r.defectClass });
  }
  return out;
}

/**
 * R6 — the binding-prior-round decision (P3) for ONE finding that held the live verdict, under a delta scope. In rule
 * order; the first matching branch decides. Every uncertainty blocks: the rule may only turn a block into a card on
 * POSITIVE evidence that the cited code is unchanged since the last reviewed head. PURE.
 * @param {{finding: object, identity: object|null, prior?: {status: string}|null, scope: object}} facts
 * @returns {{decision: 'block'|'card', reason: string, change: string|null}}
 */
export function bindingRoundDecision({ finding, identity, prior = null, scope } = {}) {
  const R = ROUND_DECISION_REASONS;
  const block = (reason, change = null) => ({ decision: ROUND_DECISIONS.BLOCK, reason, change });
  const card = (reason, change) => ({ decision: ROUND_DECISIONS.CARD, reason, change });
  if (!scope || scope.kind !== 'delta') return block(R.FULL_REVIEW);
  const f = normalizeFinding(finding);
  if (!f || !identity) return block(R.FULL_REVIEW);
  if (requiresMandatoryReferral(f)) return block(R.CONFIRMED_BROKEN);
  if (!identity.path) return block(R.NO_CITATION);
  const change = findingChangeState(f, { priorHead: scope.priorHead, head: scope.head, files: scope.files });
  if (change === null) return block(R.FULL_REVIEW);
  if (change === 'near') return block(R.CHANGED_CODE, change);
  if (change === 'inconclusive') return block(R.CHANGE_UNPLACEABLE, change);
  // `far` or `untouched`: the cited code is unchanged since the last reviewed head.
  if ((scope.carried ?? []).includes(identity.findingId) || prior?.status === FINDING_STATUSES.RAISED) {
    return block(R.SENT_BACK_CARRY, change);
  }
  if (prior?.status === FINDING_STATUSES.FIXED) return card(R.RERAISE_OF_FIXED, change);
  if (prior?.status === FINDING_STATUSES.TOLERATED) return card(R.TOLERATED_UNCHANGED, change);
  if (prior?.status === FINDING_STATUSES.CARDED) return card(R.CARDED_UNCHANGED, change);
  return card(R.LATE_UNCHANGED, change);
}

/**
 * R7 — one round in shadow. Builds the ledger finding rows (R5) and, for a later round, the per-finding R6 decision
 * for every finding that held the live verdict, plus the round summary. Round 1 is never scoped ([N3]): it gets
 * finding rows and no shadow decisions. PURE.
 *
 * `roundAvoided` is true only when the live round blocked (the PR goes back for another round) and the shadow would
 * have blocked nothing, with no human requirement in play — i.e. the NEXT round would not have happened.
 *
 * @param {{repo: string, pr: number, head: string, round: number, scope: object,
 *   findings: Array<{finding: object, symbol?: string, heldVerdict: boolean, deferred?: boolean}>,
 *   prior?: Map<string, object>, liveVerdict?: string, humanRequired?: boolean}} facts
 * @returns {{rows: Array<object>, entries: Array<object>, summary: object}}
 */
export function shadowRound({ repo, pr, head, round, scope, findings = [], prior = new Map(), liveVerdict = '', humanRequired = false } = {}) {
  const rows = [];
  const entries = [];
  const seenIds = new Set();
  const priorMap = prior instanceof Map ? prior : new Map();
  for (const item of Array.isArray(findings) ? findings : []) {
    const identity = findingIdentity(item?.finding, { repo, pr, symbol: item?.symbol ?? '' });
    if (!identity) continue;
    const status = roundFindingStatus({ heldVerdict: item.heldVerdict === true, deferred: item.deferred === true });
    // One row per identity per head: a stronger status wins (raised > carded > tolerated).
    const rank = { raised: 3, carded: 2, tolerated: 1 };
    const existing = rows.find((r) => r.findingId === identity.findingId);
    if (existing) { if (rank[status] > rank[existing.status]) existing.status = status; }
    else rows.push({ ...identity, status, round });
    seenIds.add(identity.findingId);
    if (item.heldVerdict === true && round > 1) {
      const p = priorMap.get(identity.findingId) ?? null;
      const d = bindingRoundDecision({ finding: item.finding, identity, prior: p, scope });
      const f = normalizeFinding(item.finding);
      entries.push({ ...identity, line: f?.line ?? null, lens: String(f?.category ?? '').split('/')[0] || null,
        verdict: f?.verdict ?? null, impact: f?.impactIfUnfixed ?? null, priorStatus: p?.status ?? null, ...d });
    }
  }
  // `fixed`: an identity raised before, not reported on this head, whose cited code the delta changed.
  if (scope?.kind === 'delta') {
    for (const [findingId, p] of priorMap) {
      if (p.status !== FINDING_STATUSES.RAISED || seenIds.has(findingId) || !p.path) continue;
      const touched = Object.hasOwn(scope.files ?? {}, p.path);
      if (touched) rows.push({ findingId, path: p.path, symbol: p.symbol ?? '', defectClass: p.defectClass ?? 'unknown', status: FINDING_STATUSES.FIXED, round });
    }
  }
  const liveBlocked = ['changes', 'needs-human'].includes(String(liveVerdict)) || entries.length > 0;
  const blocked = entries.filter((e) => e.decision === ROUND_DECISIONS.BLOCK).length;
  const carded = entries.filter((e) => e.decision === ROUND_DECISIONS.CARD).length;
  // Fail closed: a live block with no finding we could attribute it to stays a block in shadow.
  const shadowBlocked = round > 1
    ? liveBlocked && (humanRequired || blocked > 0 || entries.length === 0 || scope?.kind !== 'delta')
    : liveBlocked;
  return {
    rows,
    entries,
    summary: {
      round, scope: scope?.kind ?? 'full', scopeReason: scope?.reason ?? null, liveVerdict: String(liveVerdict || ''),
      liveBlocked, shadowBlocked, blocked, carded,
      roundAvoided: round > 1 && liveBlocked && !shadowBlocked,
    },
  };
}

/**
 * The Acceptance ids of a card (`- [A1] …` lines under `## Acceptance`), for R4's scope. PURE; the text is data.
 * @param {string} cardText
 * @returns {string[]}
 */
export function acceptanceIds(cardText) {
  const text = String(cardText ?? '');
  const start = text.search(/^##\s+Acceptance\b/m);
  if (start < 0) return [];
  const rest = text.slice(start).split('\n').slice(1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return [...new Set((end < 0 ? rest : rest.slice(0, end)).map((l) => l.match(/^\s*[-*]\s*\[(A\d+)\]/)?.[1]).filter(Boolean))];
}

/**
 * Project the avoided rounds over a PR's ordered round summaries: the first later round whose live block the shadow
 * would have turned into cards ends the loop there, so every round after it is avoided. PURE.
 * @param {Array<{round: number, roundAvoided: boolean}>} summaries - one PR, in round order.
 * @returns {{rounds: number, laterRounds: number, avoided: number, stopAt: number|null}}
 */
export function projectAvoidedRounds(summaries) {
  const list = Array.isArray(summaries) ? summaries : [];
  const idx = list.findIndex((s) => s?.roundAvoided === true);
  const laterRounds = list.filter((s) => Number(s?.round) > 1).length;
  return { rounds: list.length, laterRounds, avoided: idx < 0 ? 0 : list.length - 1 - idx, stopAt: idx < 0 ? null : list[idx].round };
}
