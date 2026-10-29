import { EVENT_TYPES, verdictClears, ledgerEventId } from '../../verdict-ledger.mjs';
import { approvalValid, approvalBindsHold, acceptanceCovers } from './verdict.mjs';
/** Labels whose hand-application adds a hold. Tighten-only: a hand REMOVAL never releases anything. */
export const HOLD_LABELS = Object.freeze(['review:human', 'review:changes', 'review:pending', 'advisory:ruling-needed']);
/**
 * A hand-added hold label holds until a later VALID approval (the same predicate the verdict-based human hold
 * uses, so an expired delegation lifts nothing) or a later independent clearing verdict that covers the current
 * head. A clear-human ceremony's audit verdict never substitutes for its approval's binding checks.
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
      const later = candidates.some(x => (approvalValid(x, facts?.now) && approvalBindsHold(x, ledgerEventId(e), head))
        || ((x.type === EVENT_TYPES.VERDICT || x.type === undefined) && verdictClears(x.verdict) && acceptanceCovers(x, head)));
      if (!later && !out.some(h => h.code === `label-input:${e.label}`)) out.push({ code: `label-input:${e.label}`, reason: `${e.label} added by hand (${e.sender})` });
    });
    return out.length ? out : null;
  },
};
