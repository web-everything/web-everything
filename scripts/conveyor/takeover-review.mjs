/**
 * we:scripts/conveyor/takeover-review.mjs — a takeover head earns ONE review beyond the round cap.
 *
 * Before: a takeover (automatic, card xx0055i, or an operator-approved manual one) runs only AFTER a PR spent its
 * rounds, so the head it pushes is already over the cap. The planner refused that head as `cap-exhausted` every
 * tick and nothing ever judged the takeover's work (live: #4708, takeover head 7e29b95c4 at 5/5, stuck at
 * review:changes). Now a head pushed after a takeover gets exactly `review.takeoverReviewAttempts` (default 1)
 * review dispatches beyond the cap. Once a review verdict lands after the takeover, every later head is capped
 * again — until the NEXT takeover of the PR's `fix.takeoverBudget` (we:scripts/conveyor/takeover-budget.mjs), whose
 * head earns its own review: the grant is anchored on the LATEST takeover. The merge gate and the human ceremony are untouched: this only lets the REVIEW run; `review:human`
 * still needs the operator.
 *
 * A takeover is identified by a TRUSTED comment only (automation or the operator, never a forgeable body):
 *   - the fix daemon's takeover marker `<!-- conveyor-fix-takeover head=<sha> -->` (we:scripts/conveyor/fix-takeover.mjs);
 *   - the operator-approved takeover comment, leading line `**Takeover (operator OK)`.
 *
 * PURE: reads only the PR's own comment thread and head sha.
 */
// Takeover budget — each takeover is an EPISODE (its signals with no verdict between them); the grant is per episode.
import { takeoverEpisodes, OPERATOR_TAKEOVER_PREFIX, isPausedReview } from './takeover-budget.mjs';
// A conflict-watch bounce asks for a rebase and judges nothing, so it never spends the takeover's review (live:
// #4631, whose takeover head was bounced for a merge conflict and then refused 6/5 as if reviewed).
import { isReviewVerdictComment as isVerdict } from './mechanical-round-cap.mjs';

export { OPERATOR_TAKEOVER_PREFIX };

import { RULING_NOT_ADDRESSED_MARKER } from '../lib/ruling-ledger.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';

const bodyOf = (c) => (typeof c?.body === 'string' ? c.body : '');
const timeOf = (c) => { const t = Date.parse(c?.createdAt ?? ''); return Number.isFinite(t) ? t : NaN; };
/** A trusted fixer turn that pushed work (a re-arm, an advisory fix). */
const isFixerTurn = (c) => /^🔧 conveyor fix —/.test(bodyOf(c).trimStart()) && isTrustedMarkerAuthor(c);
/** A trusted escalation-ladder dispatch notice (`reconcile-fix-dispatch.mjs#postRulingNotice`): the system itself sent
 *  a fixer past the cap on a rung of the fixer-escalation ladder (live: #4689 round 6, rung 2, head 6e0d241df). */
export const isEscalationDispatch = (c) => bodyOf(c).trimStart().startsWith(RULING_NOT_ADDRESSED_MARKER) && isTrustedMarkerAuthor(c);

/**
 * PURE: the system's own escalation dispatches, oldest first: `[{ at, via }]` — every takeover (an episode, voids
 * honoured) and every escalation-ladder dispatch notice. Each one may push a head past the round cap.
 */
export function escalationDispatches(comments) {
  const list = Array.isArray(comments) ? comments : [];
  return [
    ...takeoverEpisodes(list).map((e) => ({ at: e.end, via: 'takeover' })),
    ...list.filter(isEscalationDispatch).map((c) => ({ at: timeOf(c), via: 'escalation-rung' })),
  ].filter((d) => Number.isFinite(d.at)).sort((a, b) => a.at - b.at);
}

/** How many paused reviews (referrals awaiting a ruling) one escalation head may take before its grant is spent. */
export const PAUSED_REVIEW_LIMIT = 2;

/**
 * PURE: may this PR's CURRENT head get a review although the round cap is spent?
 * `{ ok: true, anchor, allowance, used, via }` or `{ ok: false, reason }`. ANY fix the system itself dispatched past
 * the cap — a takeover (of the PR's `fix.takeoverBudget`) or a fixer-escalation ladder rung — earns
 * `takeoverReviewAttempts` review(s) for the head it pushes. The anchor is the LATEST such dispatch, moved to the
 * first fixer push after it (a verdict on the OLD head that lands between the dispatch and the push spends nothing).
 * How many dispatches run at all stays bounded by the takeover budget/progress guard and the ladder's own human rung.
 * Reasons: `off` (setting 0), `no-takeover` (no escalation dispatch), `head-already-reviewed` (a verdict names this
 * head), `takeover-review-spent` (verdicts after the anchor already used the allowance).
 * @param {{pr:{headRefOid?:string, comments?:Array<object>}, takeoverReviewAttempts?:number}} o
 */
export function takeoverReviewGrant({ pr, takeoverReviewAttempts = 0 } = {}) {
  const allowance = Number.isInteger(takeoverReviewAttempts) && takeoverReviewAttempts > 0 ? takeoverReviewAttempts : 0;
  if (!allowance) return { ok: false, reason: 'off' };
  const comments = Array.isArray(pr?.comments) ? pr.comments : [];
  const dispatches = escalationDispatches(comments);
  if (!dispatches.length) return { ok: false, reason: 'no-takeover' };
  const latest = dispatches.at(-1);
  const push = comments.filter(isFixerTurn).map(timeOf).filter((t) => Number.isFinite(t) && t > latest.at).sort((a, b) => a - b)[0];
  const anchor = Number.isFinite(push) ? push : latest.at;
  const head = String(pr?.headRefOid ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(head)) return { ok: false, reason: 'no-head' };
  // A review that only PAUSED on referrals awaiting a ruling neither reviews the head nor spends the grant: the
  // ruling wakes it and the woken review is the one owed (live #4708, 483aab1e2 refused 6/5). Bounded: a head whose
  // review paused PAUSED_REVIEW_LIMIT times has spent its grant.
  const verdicts = comments.filter((c) => isVerdict(c) && !isPausedReview(c));
  if (verdicts.some((c) => bodyOf(c).toLowerCase().includes(head))) return { ok: false, reason: 'head-already-reviewed' };
  const used = verdicts.filter((c) => timeOf(c) > anchor).length;
  if (used >= allowance) return { ok: false, reason: 'takeover-review-spent', used, allowance };
  const paused = comments.filter((c) => isPausedReview(c) && timeOf(c) > anchor).length;
  if (paused >= PAUSED_REVIEW_LIMIT) return { ok: false, reason: 'takeover-review-spent', used, paused, allowance };
  return {
    ok: true, anchor: new Date(anchor).toISOString(), allowance, used, via: latest.via,
    takeover: takeoverEpisodes(comments).length,
  };
}
