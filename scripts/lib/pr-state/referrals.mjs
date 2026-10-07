/**
 * @file Referral lifecycle over ledger events (plan 3.3; the #5083 rule). Pure.
 * A finding key is `open` after a referral event names it, `ruled` after a `not-real` or `card` ruling,
 * `blocking` after a `block` ruling (the operator confirmed it; it keeps holding until a fix is observed), and
 * `resolved-by-fix` when a LATER clearing verdict on a DIFFERENT head is appended while the key is still `open`
 * or `blocking`. A newer referral naming the key again re-opens it (the finding was reproduced), so a
 * still-reproduced finding keeps holding, except when the earlier ruling was `not-real` or `card` (the operator
 * already overruled it; plateau-app #202). A non-clearing verdict, or an accept on the same head, never closes a
 * referral.
 */
import { EVENT_TYPES, verdictClears } from '../verdict-ledger.mjs';

const RULING_STATE = Object.freeze({ block: 'blocking', 'not-real': 'ruled', card: 'ruled' });
const normSha = v => String(v ?? '').trim().toLowerCase();
/** Two head SHAs name the same commit (either may abbreviate the other, 7+ chars each, case and padding ignored). False when either is absent or too short to identify a commit. */
export const sameHead = (a, b) => {
  const x = normSha(a), y = normSha(b);
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
};
/** The head a verdict row was witnessed at (v1 rows keep it under `coverage`). */
export const verdictHead = row => row?.coverage?.headSha ?? row?.headSha ?? null;

/**
 * @param {object[]} events One PR's ledger events in append order.
 * @returns {Map<string,{key:string,state:'open'|'ruled'|'blocking'|'resolved-by-fix',head:string|null,ruling:string|null,resolvedAtHead:string|null}>}
 */
export function deriveReferrals(events) {
  const keys = new Map();
  for (const e of events ?? []) {
    if (e.type === EVENT_TYPES.REFERRAL) {
      for (const key of e.findingKeys) {
        // An overruled finding (not-real, card) coming back is not new news (live plateau-app #202); a `block` that
        // comes back, or a fix that did not hold, re-opens the key.
        if (keys.get(key)?.state === 'ruled') continue;
        keys.set(key, { key, state: 'open', head: e.headSha, ruling: null, resolvedAtHead: null });
      }
    } else if (e.type === EVENT_TYPES.RULING) {
      const k = keys.get(e.findingKey);
      // Only the closed set of rulings moves a key; an unknown value (a forged or mis-cased row) changes nothing.
      const state = RULING_STATE[e.ruling];
      if (k && state) keys.set(e.findingKey, { ...k, state, ruling: e.ruling });
    } else if ((e.type === EVENT_TYPES.VERDICT || e.type === undefined) && verdictClears(e.verdict)) {
      const head = verdictHead(e);
      for (const [key, k] of keys) {
        if ((k.state === 'open' || k.state === 'blocking') && head && k.head && !sameHead(head, k.head)) keys.set(key, { ...k, state: 'resolved-by-fix', resolvedAtHead: head });
      }
    }
  }
  return keys;
}

const keysIn = (referrals, state) => [...referrals.values()].filter(k => k.state === state).map(k => k.key);
/** Keys still awaiting a ruling. */
export const openReferralKeys = referrals => keysIn(referrals, 'open');
/** Keys the operator ruled `block` and no fix has been observed for yet. */
export const blockedReferralKeys = referrals => keysIn(referrals, 'blocking');
