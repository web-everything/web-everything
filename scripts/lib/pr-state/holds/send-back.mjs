import { EVENT_TYPES } from '../../verdict-ledger.mjs';
import { verdictHead, sameHead } from '../referrals.mjs';

/** The head an event witnessed, if it names one (a verdict row, a referral, a review run). */
const headOf = e => (e.type === EVENT_TYPES.VERDICT || e.type === undefined ? verdictHead(e) : e.headSha) ?? null;

/**
 * A send-back holds the PR until the head SHA differs from the head that was sent back. That head is the latest
 * one a ledger event witnessed before the send-back. A commit timestamp never releases it (the pusher sets it); a
 * send-back with no recorded head, or a PR whose current head is unknown, stays held.
 */
export default {
  id: 'send-back',
  evaluate({ view, facts }) {
    const at = view.events.map(e => e.type).lastIndexOf(EVENT_TYPES.SEND_BACK);
    if (at < 0) return null;
    const sb = view.events[at];
    const sentHead = view.events.slice(0, at).reverse().map(headOf).find(Boolean) ?? null;
    const head = facts?.head?.sha ?? null;
    if (sentHead && head && !sameHead(head, sentHead)) return null;
    // No head was recorded before the send-back: the ledger cannot say which head was sent back, so a later event
    // that witnesses the current head (a review run or verdict after the send-back) is the proof of a new head.
    if (!sentHead && head && view.events.slice(at + 1).some(e => sameHead(headOf(e), head))) return null;
    return { code: 'send-back', reason: `sent back (${sb.cause}) at ${sb.at}; ${sentHead ? `no head other than ${String(sentHead).slice(0, 8)} yet` : 'the head at send-back is not recorded'}` };
  },
};
