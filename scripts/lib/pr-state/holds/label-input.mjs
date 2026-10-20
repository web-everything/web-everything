import { EVENT_TYPES, appliedVerdictHistory, verdictClears, ledgerEventId } from '../../verdict-ledger.mjs';
import { approvalValid, acceptanceCovers } from './verdict.mjs';
import { isSha, sameHead, verdictHead } from '../referrals.mjs';
/** Labels whose hand-application adds a hold. Tighten-only: a hand REMOVAL never releases anything. */
export const HOLD_LABELS = Object.freeze(['review:human', 'review:changes', 'review:pending', 'advisory:ruling-needed']);

/** Follow equivalent-head witnesses from a fresh answer to a hold, never from a carry's append position.
 * A new content head or a bearing hold ends this chain. Restamps are the legacy equivalent-head witness;
 * carried rows additionally name their source head. Only rows applied by the ledger fold participate.
 * A human clearance moves only through a carry its writer proved under the human-clearance policy (`carryHuman`). */
function clearanceCovers(row, events, head) {
  const at = events.indexOf(row);
  if (at < 0) return false;
  if (acceptanceCovers(row, head)) return true;
  let witnessed = verdictHead(row);
  if (!isSha(witnessed)) return false;
  const human = row.verdict === 'clear-human' || row.state === 'clear-human';
  for (const e of events.slice(at + 1)) {
    const next = verdictHead(e);
    if (e.verdict === 'carried') {
      if (!sameHead(e.fromHead, witnessed)) continue;
      if (human && e.carryHuman !== true) return false;
      witnessed = next;
      continue;
    }
    if (!verdictClears(e.verdict)) return false;
    if (e.verdict === 'restamped') witnessed = next;
    else if (!sameHead(next, witnessed)) return false;
  }
  return sameHead(witnessed, head);
}

/** An approval has no head of its own: for a manual review:human hold, an applied carry its writer did not prove under
 *  the human-clearance policy (`carryHuman`) ends its scope, as such a carry ends a clear-human verdict's. An approval
 *  whose position in `events` is unknown answers nothing. */
const approvalCarriedAway = (row, events, applied) => {
  const at = Array.isArray(events) ? events.indexOf(row) : -1;
  return at < 0 || events.slice(at + 1).some(e => e.verdict === 'carried' && e.carryHuman !== true && applied.includes(e));
};

/** Shared by hold evaluation and timeline ingestion: only a fresh answer can discharge a manual hold. */
export function clearanceAnswersHold(row, { label, head, now, applied, events }) {
  return (approvalValid(row, now) && (label !== 'review:human' || !approvalCarriedAway(row, events, applied)))
    || ((row.type === EVENT_TYPES.VERDICT || row.type === undefined) && verdictClears(row.verdict)
      && !['carried', 'restamped'].includes(row.verdict)
      && (label !== 'review:human' || row.verdict === 'clear-human') && clearanceCovers(row, applied, head));
}
/**
 * A hand-added hold label holds until a later VALID approval (the same predicate the verdict-based human hold
 * uses, so an expired delegation lifts nothing) or a later fresh clearing verdict that covers the current head.
 * A carry/restamp reuses an earlier decision: its append position is never a new answer to a manual hold.
 * A manual review:human hold requires an explicit human clearance; an ordinary acceptance cannot answer it.
 */
export default {
  id: 'label-input',
  evaluate({ view, facts }) {
    const head = facts?.head?.sha ?? null;
    const applied = appliedVerdictHistory(view.history ?? view.events, Number(facts?.pr));
    const out = [];
    view.events.forEach((e, i) => {
      if (e.type !== EVENT_TYPES.LABEL_INPUT || e.change !== 'added' || !HOLD_LABELS.includes(e.label)) return;
      // Legacy inputs retain append ordering. Mirrored inputs carry a causal baseline: clearances
      // not yet observed when this hold was planned win regardless of the eventual append order.
      const candidates = e.clearanceBaseline === undefined ? view.events.slice(i + 1)
        : view.events.filter(x => (x.type === EVENT_TYPES.APPROVAL || ((x.type === EVENT_TYPES.VERDICT || x.type === undefined) && verdictClears(x.verdict)))
          && !e.clearanceBaseline.includes(ledgerEventId(x)));
      const later = candidates.some(x => clearanceAnswersHold(x, { label: e.label, head, now: facts?.now, applied, events: view.events }));
      if (!later && !out.some(h => h.code === `label-input:${e.label}`)) out.push({ code: `label-input:${e.label}`, reason: `${e.label} added by hand (${e.sender})` });
    });
    return out.length ? out : null;
  },
};
