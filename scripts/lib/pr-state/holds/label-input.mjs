import { EVENT_TYPES, verdictClears } from '../../verdict-ledger.mjs';
import { approvalValid, acceptanceCovers } from './verdict.mjs';
/** Labels whose hand-application adds a hold. Tighten-only: a hand REMOVAL never releases anything. */
export const HOLD_LABELS = Object.freeze(['review:human', 'review:changes', 'review:pending', 'advisory:ruling-needed']);
/**
 * A hand-added hold label holds until a later VALID approval (the same predicate the verdict-based human hold
 * uses, so an expired delegation lifts nothing) or a later clearing verdict that covers the current head.
 */
export default {
  id: 'label-input',
  evaluate({ view, facts }) {
    const head = facts?.head?.sha ?? null;
    const out = [];
    view.events.forEach((e, i) => {
      if (e.type !== EVENT_TYPES.LABEL_INPUT || e.change !== 'added' || !HOLD_LABELS.includes(e.label)) return;
      const later = view.events.slice(i + 1).some(x => approvalValid(x, facts?.now)
        || ((x.type === EVENT_TYPES.VERDICT || x.type === undefined) && verdictClears(x.verdict) && acceptanceCovers(x, head)));
      if (!later && !out.some(h => h.code === `label-input:${e.label}`)) out.push({ code: `label-input:${e.label}`, reason: `${e.label} added by hand (${e.sender})` });
    });
    return out.length ? out : null;
  },
};
