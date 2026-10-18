/**
 * @file Referral lifecycle over ledger events (plan 3.3; the #5083 rule). Pure.
 * A finding key is `open` after a referral event names it, `ruled` after a `not-real` or `card` ruling,
 * `blocking` after a `block` ruling (the operator confirmed it; it keeps holding until a fix is observed),
 * `retired` after a clearing ruling on {@link REFERRAL_RETIRED_CHANNEL} (its seat was disabled; a re-referral reopens it), and
 * `resolved-by-fix` when a LATER clearing verdict on a DIFFERENT head is appended while the key is still `open`
 * or `blocking`. A newer referral naming the key again re-opens it (the finding was reproduced), so a
 * still-reproduced finding keeps holding, except when the earlier ruling was `not-real` or `card` (the operator
 * already overruled it; plateau-app #202). A non-clearing verdict, or an accept on the same head, never closes a
 * referral. Nor does a clear the verdict fold left as history (a delayed accept of a superseded head): it never
 * counted for the current head, so it cannot be the fix.
 */
import { createHash } from 'node:crypto';
import { EVENT_TYPES, verdictClears, appliedVerdictHistory } from '../verdict-ledger.mjs';

const HASHED_KEY = /^sha256:[0-9a-f]{64}$/;
/**
 * The ONE form a finding key takes in a ledger row: `sha256:<hex>` of the full raw key (what `review-pr-io` writes on a
 * referral row). Hashing is what makes a ruling row and a referral row name the same finding; an already-hashed key is
 * returned as is, so calling it twice is harmless. Hash the FULL key before the row is built: the row builder caps a
 * string field at 200 characters, so a raw key stored in a row may be a truncated one whose hash matches nothing.
 */
export const ledgerFindingKey = k => (HASHED_KEY.test(String(k ?? '')) ? String(k) : `sha256:${createHash('sha256').update(String(k ?? '')).digest('hex')}`);

/** The channel of a clearing ruling row that retires a finding its seat no longer reports (seat disabled by config). */
export const REFERRAL_RETIRED_CHANNEL = 'mandatory-referral-retired';
const RULING_STATE = new Map([['block', 'blocking'], ['not-real', 'ruled'], ['card', 'ruled']]); // a Map: a raw name like 'toString' or '__proto__' must never resolve through the prototype chain
const normSha = v => (typeof v === 'string' ? v.trim().toLowerCase() : '');
/** A head SHA a rule may act on: 7 to 64 hex characters. Anything else (garbage, a number, 'abc') is an UNKNOWN head, never "a different head". */
export const isSha = v => /^[0-9a-f]{7,64}$/.test(normSha(v));
/** Two head SHAs name the same commit (either may abbreviate the other, 7+ chars each, case and padding ignored). False when either is absent, too short, or not a SHA. */
export const sameHead = (a, b) => {
  const x = normSha(a), y = normSha(b);
  return isSha(x) && isSha(y) && (x.startsWith(y) || y.startsWith(x));
};
/** The head a verdict row was witnessed at (v1 rows keep it under `coverage`). */
export const verdictHead = row => (row?.coverage ? row.coverage.headSha : row?.headSha) ?? null; // a coverage object that names no head is not rescued by a top-level headSha

/** The verdict rows the fold applied, for every PR in `events` (complete streams: a filtered one can forget a superseded head). */
export const appliedVerdictRows = events => new Set([...new Set((events ?? []).map(e => e?.pr))].flatMap(pr => appliedVerdictHistory(events, pr)));

/** Every head SHA a row names (its verdict head, a transition's from-head, an event's head). */
const rowHeads = e => [verdictHead(e), e?.fromHead, e?.headSha].filter(isSha);

/**
 * @param {object[]} events One PR's ledger events in append order.
 * @param {{applied?: Set<object>, history?: object[], liveHead?: string|null}} [options]
 *   `applied`: {@link appliedVerdictRows} of the COMPLETE stream when `events` is a filtered view of it; defaults to
 *   the rows applied within `events` itself. `history`: that complete stream (default `events`). A clear resolves a
 *   finding only at a head no row named before the referral: an older head is not a fix, even when the move away from
 *   it was never recorded. `liveHead`: when given, a resolving head must be the live head or lead to it through
 *   recorded transitions; a late accept of a head that is not the PR's code holds the finding as it was.
 * @returns {Map<string,{key:string,state:'open'|'ruled'|'blocking'|'resolved-by-fix'|'retired',head:string|null,ruling:string|null,resolvedAtHead:string|null}>}
 */
export function deriveReferrals(events, { applied = appliedVerdictRows(events), history = events, liveHead = null } = {}) {
  const position = new Map((history ?? []).map((e, i) => [e, i]));
  const sightings = (history ?? []).flatMap((e, i) => rowHeads(e).map(h => [i, h]));
  const referralRow = new Map(); // key → the referral row that last (re)opened it
  const resolvedFrom = new Map(); // key → { state before a fix resolved it, every head that qualified as the fix }
  const seenBefore = (head, row) => { const at = position.get(row) ?? -1; return sightings.some(([i, h]) => i < at && sameHead(h, head)); };
  const keys = new Map();
  // A public referral can be ruled on while review-pr is parked before its final ledger step.
  // Retain the latest valid ruling until the FIRST referral supplies the finding's head. Do not
  // create a referral from a ruling alone, or replay this buffer over later reproduced findings.
  const earlyRulings = new Map();
  for (const e of events ?? []) {
    if (e.type === EVENT_TYPES.REFERRAL) {
      for (const key of e.findingKeys) {
        // An overruled finding (not-real, card) coming back is not new news (live plateau-app #202); a `block` that
        // comes back, or a fix that did not hold, re-opens the key.
        if (keys.get(key)?.state === 'ruled') continue;
        const early = earlyRulings.get(key);
        earlyRulings.delete(key);
        keys.set(key, { key, state: early?.state ?? 'open', head: e.headSha,
          ruling: early?.ruling ?? null, resolvedAtHead: null });
        referralRow.set(key, e);
        resolvedFrom.delete(key);
      }
    } else if (e.type === EVENT_TYPES.RULING) {
      // Only a ruling that names the key exactly as the referral does (the hashed form) closes it. A legacy ruling row
      // that names the RAW key closes nothing; `ledger-backfill-rulings --migrate-raw` appends its hashed equivalent.
      const k = keys.get(e.findingKey);
      // Only the closed set of rulings moves a key; an unknown value (a forged or mis-cased row) changes nothing.
      // A retirement closes the key without a verdict on it, so a later referral reopens it (never sticky `ruled`).
      // It only closes an open key: it never replaces a recorded ruling, and never pre-closes a referral that a
      // re-enabled seat has yet to make.
      const ruled = RULING_STATE.get(e.ruling);
      const retire = ruled === 'ruled' && e.source === 'review-pr' && e.actor?.channel === REFERRAL_RETIRED_CHANNEL;
      const state = retire ? 'retired' : ruled;
      if (retire && k?.state !== 'open') continue;
      if (k && state) { keys.set(e.findingKey, { ...k, state, ruling: e.ruling }); resolvedFrom.delete(e.findingKey); }
      else if (state) earlyRulings.set(e.findingKey, { state, ruling: e.ruling });
    } else if ((e.type === EVENT_TYPES.VERDICT || e.type === undefined) && verdictClears(e.verdict) && applied.has(e)) {
      const head = verdictHead(e);
      for (const [key, k] of keys) {
        if (!(isSha(head) && isSha(k.head) && !sameHead(head, k.head) && !seenBefore(head, referralRow.get(key)))) continue;
        if (k.state === 'open' || k.state === 'blocking') {
          resolvedFrom.set(key, { state: k.state, heads: [head] });
          keys.set(key, { ...k, state: 'resolved-by-fix', resolvedAtHead: head });
        } else if (k.state === 'resolved-by-fix') resolvedFrom.get(key)?.heads.push(head);
      }
    }
  }
  if (isSha(liveHead)) {
    for (const [key, { state, heads }] of resolvedFrom) {
      const k = keys.get(key);
      if (k?.state !== 'resolved-by-fix') continue;
      const fix = heads.find(h => leadsTo(history ?? [], h, liveHead));
      keys.set(key, fix ? { ...k, resolvedAtHead: fix } : { ...k, state, resolvedAtHead: null });
    }
  }
  return keys;
}

/** `from` is `to`, or recorded transitions (head-moved / carried rows) lead from it to `to`. */
function leadsTo(history, from, to) {
  const seen = [];
  for (let cur = from; isSha(cur) && !seen.some(h => sameHead(h, cur)); ) {
    if (sameHead(cur, to)) return true;
    seen.push(cur);
    cur = verdictHead(history.find(e => ['head-moved', 'carried'].includes(e?.verdict) && sameHead(e.fromHead, cur)
      && !seen.some(h => sameHead(h, verdictHead(e)))));
  }
  return false;
}

const keysIn = (referrals, state) => [...referrals.values()].filter(k => k.state === state).map(k => k.key);
/** Keys still awaiting a ruling. */
export const openReferralKeys = referrals => keysIn(referrals, 'open');
/** Keys the operator ruled `block` and no fix has been observed for yet. */
export const blockedReferralKeys = referrals => keysIn(referrals, 'blocking');
