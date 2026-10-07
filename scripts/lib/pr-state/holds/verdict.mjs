import { EVENT_TYPES, ledgerCoversHead } from '../../verdict-ledger.mjs';
import { verdictHead, sameHead } from '../referrals.mjs';

const time = v => (typeof v === 'number' ? v : Date.parse(v));

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

/** Does a later, valid approval exist after position `from` in `events`? An unknown position (-1) answers no. */
export const approvalLiftsAfter = (events, from, now) => from >= 0 && events.slice(from + 1).some(e => approvalValid(e, now));

/** Does a clearing verdict row still cover `head`? Default deny: an unknown current head, or a row that witnessed no head, is NOT covered. */
export function acceptanceCovers(row, head) {
  if (!head) return false;
  const witnessed = verdictHead(row);
  if (!witnessed) return false;
  return sameHead(head, witnessed) || ledgerCoversHead({ record: row, headSha: head }).covers;
}

/** The live verdict holds unless it clears and still covers the current head. */
export default {
  id: 'verdict',
  evaluate({ view, facts }) {
    const cur = view.folded?.current;
    if (!cur) return null; // no verdict yet: not a hold, just not cleared (the PR is in review)
    if (!view.clears) return { code: `verdict:${cur.verdict}`, reason: `live verdict is ${cur.verdict}`, needsYou: cur.verdict === 'human' ? 'a human must clear this PR' : null };
    const head = facts?.head?.sha ?? null;
    const witnessed = verdictHead(cur);
    if (head && !witnessed && cur.clears) return { code: 'stale-acceptance', reason: `acceptance witnessed no head, head is ${String(head).slice(0, 8)}` };
    if (head && witnessed && !sameHead(head, witnessed)) {
      const { covers, reason } = ledgerCoversHead({ record: cur, headSha: head });
      if (!covers) return { code: 'stale-acceptance', reason: reason || `acceptance witnessed ${witnessed.slice(0, 8)}, head is ${String(head).slice(0, 8)}` };
    }
    return null;
  },
};
