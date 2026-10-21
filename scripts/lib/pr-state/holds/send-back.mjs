import { EVENT_TYPES, sendBackCandidateHeads } from '../../verdict-ledger.mjs';
import { sameHead, isSha } from '../referrals.mjs';

/**
 * A send-back holds the PR until the head SHA differs from every head that may have been sent back: the latest
 * applied witness before the send-back, and each head a review or other non-transition row named before it. A fresh
 * row for a superseded head (a force-push back whose observation append missed) cannot be told from a delayed one,
 * so both bind it. A commit timestamp never releases it (the pusher sets it); a send-back with no recorded head
 * (a later event on the current head proves nothing), or a PR whose current head is unknown, stays held.
 */
export default {
  id: 'send-back',
  evaluate({ view, facts }) {
    // Head-move pruning expires clearances, never the historical head a send-back rejected.
    const events = view.history ?? view.events;
    const at = events.map(e => e.type).lastIndexOf(EVENT_TYPES.SEND_BACK);
    if (at < 0) return null;
    const sb = events[at];
    const sentHeads = sendBackCandidateHeads(events.slice(0, at));
    const head = facts?.head?.sha ?? null;
    // only real SHAs can differ; a garbage or short head is an unknown head
    if (sentHeads.length && isSha(head) && !sentHeads.some(sent => sameHead(head, sent))) return null;
    // No head was recorded before the send-back: the ledger cannot say which head was sent back. A later event that
    // witnesses the current head only shows what the head IS now, never that it differs from the sent-back one, so
    // nothing here releases it: it stays held (NEEDS-OPERATOR) until a baseline exists or an operator acts.
    return { code: 'send-back', reason: `sent back (${sb.cause}) at ${sb.at}; ${sentHeads.length ? `no head other than ${sentHeads.map(h => String(h).slice(0, 8)).join(', ')} yet` : 'the head at send-back is not recorded'}` };
  },
};
