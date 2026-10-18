import { EVENT_TYPES, observedLedgerHead } from '../../verdict-ledger.mjs';
import { sameHead, isSha } from '../referrals.mjs';

/**
 * A send-back holds the PR until the head SHA differs from the head that was sent back. That head is the latest
 * applied witness before the send-back; a delayed row cannot rewind it. Fresh event heads still count when a
 * lifecycle append missed. A commit timestamp never releases it (the pusher sets it); a
 * send-back with no recorded head (a later event on the current head proves nothing), or a PR whose current head
 * is unknown, stays held.
 */
export default {
  id: 'send-back',
  evaluate({ view, facts }) {
    // Head-move pruning expires clearances, never the historical head a send-back rejected.
    const events = view.history ?? view.events;
    const at = events.map(e => e.type).lastIndexOf(EVENT_TYPES.SEND_BACK);
    if (at < 0) return null;
    const sb = events[at];
    const witnessed = observedLedgerHead(events.slice(0, at), { includeEventHeads: true });
    const sentHead = isSha(witnessed) ? witnessed : null;
    const head = facts?.head?.sha ?? null;
    if (sentHead && isSha(head) && !sameHead(head, sentHead)) return null; // only two real SHAs can differ; a garbage or short head is an unknown head
    // No head was recorded before the send-back: the ledger cannot say which head was sent back. A later event that
    // witnesses the current head only shows what the head IS now, never that it differs from the sent-back one, so
    // nothing here releases it: it stays held (NEEDS-OPERATOR) until a baseline exists or an operator acts.
    return { code: 'send-back', reason: `sent back (${sb.cause}) at ${sb.at}; ${sentHead ? `no head other than ${String(sentHead).slice(0, 8)} yet` : 'the head at send-back is not recorded'}` };
  },
};
