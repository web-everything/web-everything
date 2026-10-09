/**
 * @file scripts/conveyor/review-hold-ledger-shadow.mjs
 * @description LEDGER PLAN SLICE H (card xqh3tkh; #5054 first edge): the review daemon's hold decisions, derived
 *   from the verdict ledger by the ONE pure derive (`we:scripts/lib/pr-state.mjs#derivePrState`), next to today's
 *   comment + run-store decisions, behind a per-family read-source setting.
 *
 * FAMILIES (each one a hold decision the reconcile pass makes today):
 *   - `referralHold`  the "review paused: N referrals need a ruling" pause (`review-referral-hold.mjs#decideReferralHold`).
 *   - `sameHeadHold`  the "already reviewed N times on this head" pause (`decideSameHeadHold`).
 *   - `blockRuled`    block-ruled referrals owed a fix (`blockRuledReferralsFor`).
 *   - `rulingNeeded`  the `advisory:ruling-needed` view (`ruling-ledger.mjs#rulingNeeded`, the sweep's input).
 *
 * SETTING `verdictLedger.readSource.<family>` = `labels` | `both` | `ledger` (plan F6; default `both`).
 *   Env: `WE_VERDICT_LEDGER_READ_SOURCE_<FAMILY>` (e.g. `..._SAME_HEAD_HOLD`), else `WE_VERDICT_LEDGER_READ_SOURCE`
 *   for every family; an unknown value is the default.
 *   - `labels`: today's decision; the ledger is not read.
 *   - `both` (SHADOW): today's decision stands, byte-identical; the ledger answer is computed too and every change
 *     of (head, old, ledger, cause) per PR + family is journaled. Nothing the daemon does changes.
 *   - `ledger`: the ledger answer decides. Only `referralHold` and `sameHeadHold` can flip in this slice (the
 *     other two need data the ledger does not carry yet: the block fix needs finding text, and the label is the
 *     G2 mirror's). For them `ledger` acts as `both` and the summary says so. In `ledger` mode an unreadable
 *     ledger or a crashed derive HOLDS the review (fail closed); it never releases.
 *   A `ledger` family reads FRESH every tick (no TTL cache; an async store, whose answer is read-behind, cannot decide
 *   yet and holds), and a release needs ledger evidence: no rows for the PR, no run on this head, or no referral on
 *   this head keeps today's pause. A referral pause lifted by the ledger asks today's same-head guard when
 *   `sameHeadHold` is not itself on `ledger`.
 *   A family moving to `ledger` can release holds today's reader keeps, so it is a ratified setting change after
 *   the shadow shows agreement, never a default.
 *
 * STORE. Read through the registry (`verdict-ledger-store.mjs#getLedgerStore`): the shared `git` store for the
 *   `dual`/`git` settings, `home` otherwise. The contract is moving to async (lane `ledger-shared-readers`), and
 *   the reconcile pass is synchronous, so a read that returns a promise is used READ-BEHIND: this tick uses the
 *   last completed read (at most {@link SNAPSHOT_MAX_AGE_MS} old) and the next one is started. No completed read
 *   is `pending`: journaled as nothing in `both`, held in `ledger`. A synchronous read is used at once.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { referralCardReadable } from '../lib/referral-card-readable.mjs';
import { derivePrState, ledgerView } from '../lib/pr-state.mjs';
import { getLedgerStore } from '../lib/verdict-ledger-store.mjs';
import { resolveLedgerStore, resolveLedgerBoard, EVENT_TYPES } from '../lib/verdict-ledger.mjs';
import '../lib/verdict-ledger-io.mjs'; // registers the `git` store
import { isUnderTest } from '../lib/under-test.mjs';
import { sharedRunsDir } from '../operations/run-store.mjs';
import { rulingNeeded } from '../lib/ruling-ledger.mjs';
import { sameHead } from '../lib/pr-state/referrals.mjs';
import { resolveSameHeadMaxReviews, decideSameHeadHold, readReviewRunEvidence } from './review-referral-hold.mjs';

export const READ_SOURCES = Object.freeze(['labels', 'both', 'ledger']);
export const DEFAULT_READ_SOURCE = 'both';
export const READ_SOURCE_FAMILIES = Object.freeze(['referralHold', 'sameHeadHold', 'blockRuled', 'rulingNeeded']);
/** Families whose `ledger` setting really decides in this slice. */
export const FLIPPABLE_FAMILIES = Object.freeze(['referralHold', 'sameHeadHold']);
export const SNAPSHOT_TTL_MS = 60_000;
export const SNAPSHOT_MAX_AGE_MS = 10 * 60_000;
const UNREADABLE_CODES = new Set(['ledger-unreadable', 'derive-crashed', 'scope-unknown']);

const envName = family => `WE_VERDICT_LEDGER_READ_SOURCE_${family.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`;
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const sha256Key = k => `sha256:${createHash('sha256').update(String(k)).digest('hex')}`;
const oneLine = e => String(e?.message ?? e).split('\n')[0].slice(0, 200);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The sweep's own reading (the gate's card rule), so `rulingNeeded` compares like for like. */
const sweepNeedsRuling = p => rulingNeeded(p, { cardReadable: ref => referralCardReadable(ref, REPO_ROOT) });

/** `verdictLedger.readSource.<family>`; anything unrecognised is the default. */
export function resolveReadSource(family, env = process.env) {
  for (const raw of [env[envName(family)], env.WE_VERDICT_LEDGER_READ_SOURCE]) {
    const v = String(raw ?? '').trim().toLowerCase();
    if (READ_SOURCES.includes(v)) return v;
  }
  return DEFAULT_READ_SOURCE;
}

/** Every family's setting, plus the EFFECTIVE mode (`ledger` on a non-flippable family acts as `both`). */
export function resolveReadSources(env = process.env) {
  return Object.fromEntries(READ_SOURCE_FAMILIES.map((f) => {
    const configured = resolveReadSource(f, env);
    return [f, { configured, effective: configured === 'ledger' && !FLIPPABLE_FAMILIES.includes(f) ? 'both' : configured }];
  }));
}

// ── PURE: the two answers per PR ─────────────────────────────────────────────────────────────────────────────

/** Today's decisions, read off the PR the reconcile pass already enriched. `null` = not evaluated. */
export function oldDecisions(pr, { needRuling = sweepNeedsRuling } = {}) {
  const hold = pr?.referralHold ?? null;
  let ruling = null;
  try { ruling = !!needRuling(pr); } catch { ruling = null; }
  return {
    referralHold: !!hold && hold.kind !== 'same-head',
    // The same-head guard runs only when no referral pause applies (`enrichPrsWithReferralHolds`).
    sameHeadHold: hold && hold.kind !== 'same-head' ? null : hold?.kind === 'same-head',
    blockRuled: Array.isArray(pr?.blockRuledReferrals) ? pr.blockRuledReferrals.length > 0 : null,
    rulingNeeded: ruling,
  };
}

/**
 * The ledger's answers for one PR, from `derivePrState` (holds) and its `ledgerView` (which referral keys are open
 * on WHICH head: the review pause is per head, because a new push owes a fresh review).
 * @returns {{unreadable:string|null, decisions:object, detail:object}}
 */
export function ledgerDecisions(events, pr, { repo, sameHeadMaxReviews = 1, now = Date.now(), derive = derivePrState } = {}) {
  const head = typeof pr?.headRefOid === 'string' ? pr.headRefOid : null;
  const facts = { pr: Number(pr?.number), repo, head: { sha: head }, state: 'OPEN', now };
  const empty = { referralHold: null, sameHeadHold: null, blockRuled: null, rulingNeeded: null };
  if (!Array.isArray(events)) return { unreadable: 'ledger-unreadable', decisions: empty, detail: {} };
  const derived = derive(events, facts, { sameHeadMaxReviews });
  const bad = derived.holds.find(h => UNREADABLE_CODES.has(h.code));
  if (bad) return { unreadable: bad.code, decisions: empty, detail: { reason: bad.reason } };
  const view = ledgerView(events, facts);
  const onHead = [...view.referrals.values()].filter(k => sameHead(k.head, head));
  const openOnHead = onHead.filter(k => k.state === 'open').map(k => k.key);
  const codes = new Set(derived.holds.map(h => h.code));
  const runs = view.events.filter(e => e.type === EVENT_TYPES.REVIEW_RUN && e.phase === 'completed' && sameHead(head, e.headSha)).length;
  return {
    unreadable: null,
    decisions: {
      referralHold: openOnHead.length > 0,
      sameHeadHold: codes.has('same-head-cap'),
      blockRuled: codes.has('referral-blocked'),
      rulingNeeded: openOnHead.length > 0,
    },
    detail: { rows: view.events.length, runsOnHead: runs, referralsOnHead: onHead.length, openOnHead, holds: [...codes],
      reason: derived.holds.find(h => h.code === 'same-head-cap')?.reason ?? null },
  };
}

/** Why the two answers differ, best effort, from the ledger rows alone. Pure. */
export function disagreementCause(family, oldAnswer, ledger, events, pr) {
  if (ledger.unreadable) return ledger.unreadable;
  if (!ledger.detail.rows) return 'no-ledger-rows';
  const mine = events.filter(e => e.pr === Number(pr.number));
  if (family === 'sameHeadHold') {
    if (oldAnswer && ledger.detail.runsOnHead === 0) return 'review-run-rows-missing';
    if (oldAnswer && ledger.detail.holds.length === 0) return 'ledger-clears';
    if (oldAnswer) return 'run-count-differs';
    return pr.referralHold === null ? 'old-released-or-retried' : 'run-count-differs';
  }
  const open = new Set(ledger.detail.openOnHead);
  // A ruling row naming the RAW finding key while referral rows carry `sha256:<hex>` never closes the referral.
  if (!oldAnswer && mine.some(e => e.type === EVENT_TYPES.RULING && open.has(sha256Key(e.findingKey)))) return 'ruling-key-unhashed';
  if (!oldAnswer && family !== 'blockRuled') return mine.some(e => e.type === EVENT_TYPES.RULING) ? 'ruling-not-matched' : 'ruling-not-in-ledger';
  if (oldAnswer && family !== 'blockRuled') return mine.some(e => e.type === EVENT_TYPES.REFERRAL && sameHead(e.headSha, pr.headRefOid)) ? 'referral-closed-in-ledger' : 'no-referral-row-on-head';
  return oldAnswer ? 'block-ruling-not-in-ledger' : 'block-ruling-only-in-ledger';
}

/**
 * Compare every family for every PR. Pure.
 * @returns {Array<{pr:number, head:string|null, family:string, mode:string, old:boolean|null, ledger:boolean|null,
 *   agree:boolean|null, cause:string|null, detail:object}>}
 */
export function compareHolds(prs, events, { repo, sources, sameHeadMaxReviews = 1, now = Date.now(), needRuling, derive } = {}) {
  const out = [];
  for (const pr of prs ?? []) {
    if (!Number.isInteger(Number(pr?.number))) continue;
    const old = oldDecisions(pr, needRuling ? { needRuling } : {});
    const led = ledgerDecisions(events, pr, { repo, sameHeadMaxReviews, now, ...(derive ? { derive } : {}) });
    // A readable ledger with no rows for this PR knows nothing about it: that is no evidence, never an agreement.
    const noRows = !led.unreadable && !led.detail.rows;
    for (const family of READ_SOURCE_FAMILIES) {
      const mode = sources[family].effective;
      if (mode === 'labels') continue;
      const o = old[family]; const l = led.unreadable ? null : led.decisions[family];
      const agree = o === null || l === null || noRows ? null : o === l;
      out.push({ pr: Number(pr.number), head: pr.headRefOid ?? null, family, mode, old: o, ledger: l, agree,
        cause: agree === false || led.unreadable || (noRows && o !== null) ? disagreementCause(family, o, led, events ?? [], pr) : null,
        detail: { runsOnHead: led.detail.runsOnHead ?? null, openOnHead: led.detail.openOnHead?.length ?? null, holds: led.detail.holds ?? [] } });
    }
  }
  return out;
}

/** A hold object the reconcile plan already understands (same shape as `review-referral-hold.mjs` builds). */
function ledgerHold({ kind, repo, pr, why, count, cause }) {
  return { kind, head: pr.headRefOid, episode: hash([repo, pr.number, pr.headRefOid, 'ledger', kind, cause ?? '']), count,
    why, retryAt: null, persistenceFailed: false, exhausted: false, source: 'ledger', ...(cause ? { cause } : {}) };
}

/**
 * Apply the `ledger`-mode families to the enriched PRs. Pure. Families in `labels`/`both` keep today's decision
 * exactly. A ledger that cannot answer (unreadable, crashed derive, no read yet) HOLDS: a silent `same-head`
 * class pause (no PR comment, logged every tick by the daemon) whose `why` names the cause.
 *
 * A ledger RELEASE needs ledger evidence. Zero rows for the PR, no completed run on this head (same-head pause) or
 * no referral row on this head (referral pause) is a ledger that does not know, so today's pause stands: the ledger
 * can add a hold or lift one it has seen the end of, never lift one it has not seen. A PR with no rows and no
 * pause stays free (it still owes its first review).
 *
 * `sameHeadToday(pr)` is today's same-head guard (the run store). A referral pause hides that guard, so when the
 * ledger lifts a referral pause and `sameHeadHold` is not itself on `ledger`, the guard is asked then. Without it the
 * pause stays (the guard cannot be asked, so nothing is released).
 */
export function applyLedgerHolds(prs, events, { repo, sources, sameHeadMaxReviews = 1, now = Date.now(), unreadable = null,
  derive, sameHeadToday = null } = {}) {
  const flipRef = sources.referralHold.effective === 'ledger';
  const flipSame = sources.sameHeadHold.effective === 'ledger';
  if (!flipRef && !flipSame) return prs;
  const heldCrashed = pr => ({ ...pr, referralHold: ledgerHold({ kind: 'same-head', repo, pr, count: 0, cause: 'derive-crashed',
    why: 'review paused: the verdict ledger cannot answer for this PR (derive-crashed); an unreadable ledger is a hold, never a release' }) });
  // One PR that crashes the derive holds that PR, not the whole repo.
  return prs.map(pr => (!pr || typeof pr !== 'object' ? pr : (() => {
    try { return decideOne(pr); } catch { return heldCrashed(pr); }
  })()));
  function decideOne(pr) {
    const led = unreadable ? { unreadable, decisions: {}, detail: {} }
      : ledgerDecisions(events, pr, { repo, sameHeadMaxReviews, now, ...(derive ? { derive } : {}) });
    if (led.unreadable) {
      return { ...pr, referralHold: ledgerHold({ kind: 'same-head', repo, pr, count: 0, cause: led.unreadable,
        why: `review paused: the verdict ledger cannot answer for this PR (${led.unreadable}); an unreadable ledger is a hold, never a release` }) };
    }
    if (!led.detail.rows) return pr; // no rows for this PR: no evidence either way, today's decision stands
    const old = pr.referralHold ?? null;
    let hold = old;
    if (flipRef) {
      if (led.decisions.referralHold) {
        const n = led.detail.openOnHead.length;
        hold = ledgerHold({ kind: 'referral', repo, pr, count: n,
          why: `review paused: ${n} referrals need a ruling; it resumes on a new push, a ruling, or a send-back` });
      } else if (old && old.kind !== 'same-head' && covers(led.detail.referralsOnHead, old)) {
        hold = null;
        if (!flipSame) {
          // The guard the referral pause hid: ask today's reader for it, and keep the pause if it cannot be asked.
          try { hold = sameHeadToday ? sameHeadToday(pr) ?? null : old; } catch { hold = old; }
        }
      }
    }
    if (flipSame && !(hold && hold.kind !== 'same-head')) {
      hold = led.decisions.sameHeadHold
        ? ledgerHold({ kind: 'same-head', repo, pr, count: led.detail.runsOnHead,
          why: `review paused: head ${String(pr.headRefOid).slice(0, 9)} was already reviewed ${led.detail.runsOnHead} time(s) (ledger: ${led.detail.reason}); it resumes on a new push` })
        : (hold?.kind === 'same-head' && covers(led.detail.runsOnHead, hold) ? null : hold);
    }
    return { ...pr, referralHold: hold };
  }
}

/** The ledger saw at least as many rows as the pause it would lift counts (and at least one): enough to release on. */
const covers = (seen, hold) => seen > 0 && (!Number.isFinite(hold?.count) || seen >= hold.count);

/** True when a family's `ledger` setting decides (not just shadows) in this env. */
export function ledgerDeciding(env = process.env) {
  try { return FLIPPABLE_FAMILIES.some(f => resolveReadSources(env)[f].effective === 'ledger'); } catch { return false; }
}

/**
 * The fail-closed answer for a step that threw: every PR is held when a family is on `ledger`, and the PRs come back
 * untouched when none is (the default `both` never changes a decision). Never throws.
 */
export function failClosedHolds(prs, { repo, env = process.env } = {}) {
  try {
    return applyLedgerHolds(prs, null, { repo, sources: resolveReadSources(env), unreadable: 'derive-crashed' });
  } catch { return prs; }
}

// ── IO: the read-behind snapshot, and the journal ──────────────────────────────────────────────────────────

const snapshots = new Map(); // repo -> {status, rows?, reason?, at, inflight?}

/** The store name readers use: the shared `git` store whenever the ledger writes there (`dual` or `git`). */
export function readStoreName(env = process.env) {
  const named = String(env.WE_VERDICT_LEDGER_READ_STORE ?? '').trim().toLowerCase();
  if (named) return named;
  const store = resolveLedgerStore(undefined, env);
  return store === 'dual' ? 'git' : store;
}

function defaultReadRange(repo, env) {
  const name = readStoreName(env);
  const store = getLedgerStore(name);
  if (!store) return { sync: { status: 'unreadable', reason: `no-store:${name}` } };
  const range = { repo, ...(name === 'git' ? { board: resolveLedgerBoard(repo, {}, env) } : {}) };
  if (name === 'git' && !range.board) return { sync: { status: 'unreadable', reason: 'no-board' } };
  let r;
  try { r = store.read(range); } catch (e) { return { sync: { status: 'unreadable', reason: `read-threw: ${oneLine(e)}` } }; }
  return r && typeof r.then === 'function' ? { promise: r } : { sync: r };
}

/**
 * This repo's ledger rows for the shadow. A synchronous store answers at once (cached {@link SNAPSHOT_TTL_MS});
 * an async one answers with its last completed read and refreshes behind. Never throws.
 * @returns {{status:'ok', rows:object[], at:number} | {status:'unreadable'|'pending', reason:string}}
 */
export function ledgerSnapshot(repo, { now = Date.now(), env = process.env, read = defaultReadRange, fresh = false } = {}) {
  const cur = snapshots.get(repo);
  if (fresh) return freshSnapshot(repo, cur, { now, env, read });
  const cached = cur && cur.status !== 'pending' && now - cur.at < SNAPSHOT_TTL_MS;
  if (!cached && !cur?.inflight) {
    const started = read(repo, env);
    if (started.promise) {
      const entry = { ...(cur ?? { status: 'pending', reason: 'no completed read yet', at: now }), inflight: true };
      snapshots.set(repo, entry);
      started.promise.then(
        r => snapshots.set(repo, settle(r, Date.now())),
        e => snapshots.set(repo, { status: 'unreadable', reason: `read-rejected: ${oneLine(e)}`, at: Date.now() }));
    } else snapshots.set(repo, settle(started.sync, now));
  }
  const s = snapshots.get(repo);
  if (s.status === 'ok' && now - s.at > SNAPSHOT_MAX_AGE_MS) return { status: 'unreadable', reason: 'snapshot-stale' };
  return s.status === 'ok' ? { status: 'ok', rows: s.rows, at: s.at } : { status: s.status, reason: s.reason };
}
/**
 * A read that DECIDES (`ledger` mode) sees every row written since the last tick: no TTL cache, and a read-behind
 * answer is by definition older than that, so an async store cannot decide yet (it is unreadable, which holds).
 * The read still completes in the background, so the shadow's cache stays warm.
 */
function freshSnapshot(repo, cur, { now, env, read }) {
  const behind = { status: 'unreadable', reason: 'async-store-read-behind' };
  if (cur?.inflight) return behind;
  const started = read(repo, env);
  if (started.promise) {
    snapshots.set(repo, { ...(cur ?? { status: 'pending', reason: 'no completed read yet', at: now }), inflight: true });
    started.promise.then(
      r => snapshots.set(repo, settle(r, Date.now())),
      e => snapshots.set(repo, { status: 'unreadable', reason: `read-rejected: ${oneLine(e)}`, at: Date.now() }));
    return behind;
  }
  const s = settle(started.sync, now);
  snapshots.set(repo, s);
  return s.status === 'ok' ? { status: 'ok', rows: s.rows, at: s.at } : { status: 'unreadable', reason: s.reason };
}
function settle(r, at) {
  return r?.status === 'ok' && Array.isArray(r.rows) ? { status: 'ok', rows: r.rows, at }
    : { status: 'unreadable', reason: r?.reason ?? 'unreadable', at };
}
/** Test seam. */
export function resetLedgerSnapshots() { snapshots.clear(); journaled.clear(); }

const journaled = new Map(); // `${repo}#${pr}:${family}` -> signature of the last row written by this process

export function defaultJournalPath(env = process.env) {
  const named = String(env.WE_LEDGER_SHADOW_JOURNAL ?? '').trim();
  return named || join(dirname(sharedRunsDir(env)), 'ledger-shadow', 'review-holds.jsonl');
}

/** Rows whose (head, old, ledger, cause) changed since this process last journaled that PR + family. */
export function journalChanges(rows, { repo, at = new Date().toISOString(), proc = basename(process.argv[1] ?? 'node') } = {}) {
  const out = [];
  for (const r of rows) {
    const key = `${repo}#${r.pr}:${r.family}`;
    const sig = JSON.stringify([r.head, r.old, r.ledger, r.cause, r.mode]);
    if (journaled.get(key) === sig) continue;
    journaled.set(key, sig);
    out.push({ at, proc, repo, ...r });
  }
  return out;
}

/**
 * The reconcile pass's step: compare (shadow) and, for `ledger` families, decide. NEVER throws and never changes
 * a `labels`/`both` decision: any failure in here returns `prs` untouched (and, for `ledger` families, holds).
 * @returns {{prs:object[], summary:object|null}}
 */
export function ledgerHoldStep(prs, { repo, env = process.env, now = Date.now(), snapshot = ledgerSnapshot,
  journal = defaultJournalWriter(env), needRuling, derive, readRuns = readReviewRunEvidence } = {}) {
  const sources = resolveReadSources(env);
  if (READ_SOURCE_FAMILIES.every(f => sources[f].effective === 'labels')) return { prs, summary: null };
  const sameHeadMaxReviews = resolveSameHeadMaxReviews(env);
  let snap;
  const deciding = FLIPPABLE_FAMILIES.some(f => sources[f].effective === 'ledger');
  try { snap = snapshot(repo, { now, env, ...(deciding ? { fresh: true } : {}) }); } catch (e) { snap = { status: 'unreadable', reason: `snapshot-threw: ${oneLine(e)}` }; }
  const events = snap.status === 'ok' ? snap.rows : null;
  let rows = [];
  let error = null;
  try {
    if (snap.status !== 'pending') rows = compareHolds(prs, events, { repo, sources, sameHeadMaxReviews, now, ...(needRuling ? { needRuling } : {}), ...(derive ? { derive } : {}) });
    if (rows.length) journal(journalChanges(rows, { repo, at: new Date(now).toISOString() }));
  } catch (e) { error = `compare: ${oneLine(e)}`; }
  let out = prs;
  try {
    let runs = null; // today's run store, read once and only when a ledger referral release needs the guard it hid
    out = applyLedgerHolds(prs, events, { repo, sources, sameHeadMaxReviews, now, ...(derive ? { derive } : {}),
      sameHeadToday: p => decideSameHeadHold(p, runs ??= readRuns(), { repo, env, now }),
      unreadable: snap.status === 'ok' ? null : (snap.status === 'pending' ? 'ledger-read-pending' : `ledger-unreadable:${snap.reason}`) });
  } catch (e) {
    error = `${error ? `${error}; ` : ''}apply: ${oneLine(e)}`;
    out = failClosedHolds(prs, { repo, env });
  }
  const counted = rows.filter(r => r.agree !== null);
  const summary = { repo, store: snap.status, ...(snap.reason ? { reason: snap.reason } : {}),
    modes: Object.fromEntries(READ_SOURCE_FAMILIES.map(f => [f, sources[f].configured === sources[f].effective ? sources[f].effective : `${sources[f].configured}->${sources[f].effective}`])),
    agree: counted.filter(r => r.agree).length, disagree: counted.filter(r => !r.agree).length,
    unknown: rows.length - counted.length,
    causes: rows.filter(r => r.agree === false || (r.agree === null && r.cause)).reduce((m, r) => ({ ...m, [`${r.family}:${r.cause}`]: (m[`${r.family}:${r.cause}`] ?? 0) + 1 }), {}),
    ...(error ? { error } : {}) };
  return { prs: out, summary };
}

/** Appends journal rows as JSONL. Off under a test run unless `WE_LEDGER_SHADOW_JOURNAL` names a file. */
export function defaultJournalWriter(env = process.env) {
  if (isUnderTest(env) && !String(env.WE_LEDGER_SHADOW_JOURNAL ?? '').trim()) return () => {};
  return (entries) => {
    if (!entries.length) return;
    const path = defaultJournalPath(env);
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    } catch { /* the shadow is observational: a journal miss never costs the tick */ }
  };
}

/** One log line per repo per tick (the proof channel next to the journal). */
export function renderLedgerShadowSummary(s) {
  if (!s) return null;
  const causes = Object.entries(s.causes).map(([k, n]) => `${k}=${n}`).join(', ');
  return `ledger-shadow ${s.repo}: store ${s.store}${s.reason ? ` (${s.reason})` : ''}; ${s.agree} agree, ${s.disagree} disagree, ${s.unknown} n/a`
    + `${causes ? `; causes: ${causes}` : ''}; modes ${Object.entries(s.modes).map(([f, m]) => `${f}=${m}`).join(' ')}${s.error ? `; error: ${s.error}` : ''}`;
}
