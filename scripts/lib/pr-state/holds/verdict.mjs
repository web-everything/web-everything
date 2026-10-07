import { EVENT_TYPES, ledgerCoversHead } from '../../verdict-ledger.mjs';
import { verdictHead, sameHead, isSha } from '../referrals.mjs';

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

/**
 * Does a clearing verdict row still cover `head`? THE one coverage predicate (the verdict rule and the label-input
 * rule both use it). Default deny: an unknown current head, a row that witnessed no head, and a row with no
 * `coverage` object that witnessed a different head are NOT covered (`ledgerCoversHead` answers `covers: true`
 * for a coverage-less record, so it is only asked when there is a coverage object to read).
 */
export function acceptanceCovers(row, head) {
  return coverage(row, head).covers;
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
    if (!view.clears) return { code: `verdict:${cur.verdict}`, reason: `live verdict is ${cur.verdict}`, needsYou: cur.verdict === 'human' ? 'a human must clear this PR' : null };
    const { covers, reason } = coverage(cur, facts?.head?.sha ?? null);
    return covers ? null : { code: 'stale-acceptance', reason };
  },
};
