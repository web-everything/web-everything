import { EVENT_TYPES, verdictClears } from '../../verdict-ledger.mjs';
/** Labels whose hand-application adds a hold. Tighten-only: a hand REMOVAL never releases anything. */
export const HOLD_LABELS = Object.freeze(['review:human', 'review:changes', 'review:pending', 'advisory:ruling-needed']);
/** A hand-added hold label holds until a later clearing verdict or approval is appended. */
export default {
  id: 'label-input',
  evaluate({ view }) {
    const out = [];
    view.events.forEach((e, i) => {
      if (e.type !== EVENT_TYPES.LABEL_INPUT || e.change !== 'added' || !HOLD_LABELS.includes(e.label)) return;
      const later = view.events.slice(i + 1).some(x => x.type === EVENT_TYPES.APPROVAL || ((x.type === EVENT_TYPES.VERDICT || x.type === undefined) && verdictClears(x.verdict)));
      if (!later && !out.some(h => h.code === `label-input:${e.label}`)) out.push({ code: `label-input:${e.label}`, reason: `${e.label} added by hand (${e.sender})` });
    });
    return out.length ? out : null;
  },
};
