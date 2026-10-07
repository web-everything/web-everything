/**
 * @file Referral lifecycle over ledger events (plan 3.3; the #5083 rule). Pure.
 * A finding key is `open` after a referral event names it, `ruled` after a ruling event, and `resolved-by-fix`
 * when a LATER clearing verdict on a DIFFERENT head is appended while the key is still open. A newer referral
 * naming the key again re-opens it (the finding was reproduced), so a still-reproduced finding keeps holding,
 * except when the earlier ruling was `not-real` or `card` (the operator already overruled it; plateau-app #202).
 * A non-clearing verdict, or an accept on the same head, never closes a referral.
 */
import { EVENT_TYPES, verdictClears } from '../verdict-ledger.mjs';

const same = (a, b) => !!a && !!b && (String(a).startsWith(String(b)) || String(b).startsWith(String(a)));
/** The head a verdict row was witnessed at (v1 rows keep it under `coverage`). */
export const verdictHead = row => row?.coverage?.headSha ?? row?.headSha ?? null;

/**
 * @param {object[]} events One PR's ledger events in append order.
 * @returns {Map<string,{key:string,state:'open'|'ruled'|'resolved-by-fix',head:string|null,ruling:string|null,resolvedAtHead:string|null}>}
 */
export function deriveReferrals(events) {
  const keys = new Map();
  for (const e of events ?? []) {
    if (e.type === EVENT_TYPES.REFERRAL) {
      for (const key of e.findingKeys) {
        const prior = keys.get(key);
        // An overruled finding (not-real, card) coming back is not new news (live plateau-app #202); a `block` that
        // comes back, or a fix that did not hold, re-opens the key.
        if (prior?.state === 'ruled' && prior.ruling !== 'block') continue;
        keys.set(key, { key, state: 'open', head: e.headSha, ruling: null, resolvedAtHead: null });
      }
    } else if (e.type === EVENT_TYPES.RULING) {
      const k = keys.get(e.findingKey);
      if (k) keys.set(e.findingKey, { ...k, state: 'ruled', ruling: e.ruling });
    } else if ((e.type === EVENT_TYPES.VERDICT || e.type === undefined) && verdictClears(e.verdict)) {
      const head = verdictHead(e);
      for (const [key, k] of keys) {
        if (k.state === 'open' && head && k.head && !same(head, k.head)) keys.set(key, { ...k, state: 'resolved-by-fix', resolvedAtHead: head });
      }
    }
  }
  return keys;
}

/** Keys still awaiting a ruling. */
export const openReferralKeys = referrals => [...referrals.values()].filter(k => k.state === 'open').map(k => k.key);
