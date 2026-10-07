import { EVENT_TYPES } from '../../verdict-ledger.mjs';
import { verdictHead, sameHead, isSha } from '../referrals.mjs';

/** The head an event witnessed, if it names one (a verdict row, a referral, a review run). */
const headOf = e => (e.type === EVENT_TYPES.VERDICT || e.type === undefined ? verdictHead(e) : e.headSha) ?? null;

/**
 * A send-back holds the PR until the head SHA differs from the head that was sent back. That head is the latest
 * one a ledger event witnessed before the send-back. A commit timestamp never releases it (the pusher sets it); a
 * send-back with no recorded head (a later event on the current head proves nothing), or a PR whose current head
 * is unknown, stays held.
 */
export default {
  id: 'send-back',
  evaluate({ view, facts }) {
    const at = view.events.map(e => e.type).lastIndexOf(EVENT_TYPES.SEND_BACK);
    if (at < 0) return null;
    const sb = view.events[at];
    const sentHead = view.events.slice(0, at).reverse().map(headOf).find(isSha) ?? null;
    const head = facts?.head?.sha ?? null;
    if (sentHead && isSha(head) && !sameHead(head, sentHead)) return null; // only two real SHAs can differ; a garbage or short head is an unknown head
    // No head was recorded before the send-back: the ledger cannot say which head was sent back. A later event that
    // witnesses the current head only shows what the head IS now, never that it differs from the sent-back one, so
    // nothing here releases it: it stays held (NEEDS-OPERATOR) until a baseline exists or an operator acts.
    return { code: 'send-back', reason: `sent back (${sb.cause}) at ${sb.at}; ${sentHead ? `no head other than ${String(sentHead).slice(0, 8)} yet` : 'the head at send-back is not recorded'}` };
  },
};
