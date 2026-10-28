import { EVENT_TYPES, verdictClears, ledgerEventId } from '../../verdict-ledger.mjs';
import { approvalReleases, acceptanceCovers } from './verdict.mjs';
/** Labels whose hand-application adds a hold. Tighten-only: a hand REMOVAL never releases anything. */
export const HOLD_LABELS = Object.freeze(['review:human', 'review:changes', 'review:pending', 'advisory:ruling-needed']);
/**
 * A hand-added hold label holds until a later VALID approval bound to the current head (the same predicate the
 * verdict-based human hold uses, so an expired delegation or an approval granted for another head lifts nothing)
 * or a later clearing verdict that covers the current head.
 */
export default {
  id: 'label-input',
  evaluate({ view, facts }) {
    const head = facts?.head?.sha ?? null;
    const out = [];
    view.events.forEach((e, i) => {
      if (e.type !== EVENT_TYPES.LABEL_INPUT || e.change !== 'added' || !HOLD_LABELS.includes(e.label)) return;
      // Legacy inputs retain append ordering. Mirrored inputs carry a causal baseline: clearances
      // not yet observed when this hold was planned win regardless of the eventual append order.
      const candidates = e.clearanceBaseline === undefined ? view.events.slice(i + 1)
        : view.events.filter(x => (x.type === EVENT_TYPES.APPROVAL || ((x.type === EVENT_TYPES.VERDICT || x.type === undefined) && verdictClears(x.verdict)))
          && !e.clearanceBaseline.includes(ledgerEventId(x)));
      const later = candidates.some(x => approvalReleases(x, facts?.now, head)
        || ((x.type === EVENT_TYPES.VERDICT || x.type === undefined) && verdictClears(x.verdict) && acceptanceCovers(x, head)));
      if (!later && !out.some(h => h.code === `label-input:${e.label}`)) out.push({ code: `label-input:${e.label}`, reason: `${e.label} added by hand (${e.sender})` });
    });
    return out.length ? out : null;
  },
};
