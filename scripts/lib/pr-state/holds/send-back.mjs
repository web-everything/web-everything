import { EVENT_TYPES } from '../../verdict-ledger.mjs';
/** A send-back holds the PR until a head is committed after it. */
export default {
  id: 'send-back',
  evaluate({ view, facts }) {
    const sb = [...view.events].reverse().find(e => e.type === EVENT_TYPES.SEND_BACK);
    if (!sb) return null;
    const headAt = Date.parse(facts?.head?.committedAt);
    if (Number.isFinite(headAt) && headAt > Date.parse(sb.at)) return null;
    return { code: 'send-back', reason: `sent back (${sb.cause}) at ${sb.at}; no newer head yet` };
  },
};
