import { EVENT_TYPES, VERDICTS, ledgerCoversHead } from '../../verdict-ledger.mjs';
import { verdictHead, sameHead, isSha } from '../referrals.mjs';

const time = v => (typeof v === 'number' ? v : Date.parse(v));
const fullSha = v => typeof v === 'string' && /^[0-9a-f]{40}(?![\s\S])/i.test(v);

/**
 * THE one approval-validity predicate (the verdict-based and the label-input human holds both use it). An
 * approval with a delegation is valid only while the delegation provably has not expired: a missing or
 * unparseable clock, or a missing or unparseable expiry, is NOT valid (default deny).
 */
export function approvalValid(e, now) {
  if (e?.type !== EVENT_TYPES.APPROVAL) return false;
  if (!e.delegation) return true;
  const expires = time(e.delegation.expires), at = time(now);
  return Number.isFinite(expires) && Number.isFinite(at) && expires > at;
}

/** Delegated approvals bind to one full witnessed head and explicitly named hold events; prefixes never bind. */
export function approvalBindsHold(e, holdId, head) {
  if (e?.type !== EVENT_TYPES.APPROVAL) return false;
  if (!e.delegation) return true;
  return fullSha(head) && fullSha(e.headSha) && head.toLowerCase() === e.headSha.toLowerCase()
    && Array.isArray(e.basis) && e.basis.length > 0 && e.basis.includes(holdId);
}

/** Does a later, valid approval bind this hold? An unknown position (-1) answers no. */
export const approvalLiftsAfter = (events, from, now, head, holdId) => from >= 0 && events.slice(from + 1).some(e => approvalValid(e, now) && approvalBindsHold(e, holdId, head));

/**
 * May a clearing verdict independently lift a hold at `head`? The label-input rule and mirror share this check.
 * A clear-human verdict is the ceremony's audit row: only its approval can lift a hold, after the approval's
 * expiry, head and basis checks. The verdict is written first, so even a missing approval must fail closed.
 * Default deny: an unknown current head, a row that witnessed no head, and a row with no
 * `coverage` object that witnessed a different head are NOT covered (`ledgerCoversHead` answers `covers: true`
 * for a coverage-less record, so it is only asked when there is a coverage object to read).
 */
export function acceptanceCovers(row, head) {
  return row?.verdict !== VERDICTS.CLEAR_HUMAN && coverage(row, head).covers;
}

/** @returns {{covers:boolean, reason:string}} */
function coverage(row, head) {
  if (!isSha(head)) return { covers: false, reason: 'the current head is unknown' };
  const witnessed = verdictHead(row);
  if (!isSha(witnessed)) return { covers: false, reason: `acceptance witnessed no head, head is ${String(head).slice(0, 8)}` };
  if (sameHead(head, witnessed)) return { covers: true, reason: '' };
  const why = `acceptance witnessed ${String(witnessed).slice(0, 8)}, head is ${String(head).slice(0, 8)}`;
  if (!row.coverage) return { covers: false, reason: why };
  const { covers, reason } = ledgerCoversHead({ record: row, headSha: head });
  return { covers, reason: reason || why };
}

/** The live verdict holds unless it clears and still covers the current head. */
export default {
  id: 'verdict',
  evaluate({ view, facts }) {
    const cur = view.folded?.current;
    if (!cur) return null; // no verdict yet: not a hold, just not cleared (the PR is in review)
    const held = view.humanHold ?? cur;
    if (!view.clears) return { code: `verdict:${held.verdict}`, reason: `live verdict is ${held.verdict}`, needsYou: held.verdict === 'human' ? 'a human must clear this PR' : null };
    const { covers, reason } = coverage(cur, facts?.head?.sha ?? null);
    return covers ? null : { code: 'stale-acceptance', reason };
  },
};
