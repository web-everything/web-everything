import { EVENT_TYPES } from '../../verdict-ledger.mjs';
import { sameHead } from '../referrals.mjs';
/** Completed review runs on the current head reached the cap, and nothing cleared. 0 turns the cap off. */
export default {
  id: 'same-head-cap',
  evaluate({ view, facts, settings }) {
    const max = Number.isInteger(settings.sameHeadMaxReviews) ? settings.sameHeadMaxReviews : 1;
    const head = facts?.head?.sha;
    if (max === 0 || !head || view.clears) return null;
    const runs = view.events.filter(e => e.type === EVENT_TYPES.REVIEW_RUN && e.phase === 'completed'
      && sameHead(head, e.headSha)).length;
    if (runs < max) return null;
    const bounced = view.folded?.current?.verdict === 'changes'; // the author owns the next move; no one else is needed
    return { code: 'same-head-cap', reason: `${runs} completed review run(s) on ${head.slice(0, 8)} (cap ${max})`,
      needsYou: bounced ? null : 'review cap reached on an unchanged head; push a new head or rule' };
  },
};
