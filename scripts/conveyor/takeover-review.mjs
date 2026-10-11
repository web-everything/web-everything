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
import { takeoverEpisodes, dispatchJudgeRule, verdictHeads, threadMayBeTruncated, OPERATOR_TAKEOVER_PREFIX } from './takeover-budget.mjs';
// A conflict-watch bounce asks for a rebase and judges nothing, so it never spends the takeover's review (live:
// #4631, whose takeover head was bounced for a merge conflict and then refused 6/5 as if reviewed).
import { isReviewVerdictComment as isVerdict, verdictJudged } from './mechanical-round-cap.mjs';

export { OPERATOR_TAKEOVER_PREFIX };

import { RULING_NOT_ADDRESSED_MARKER } from '../lib/ruling-ledger.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';

const bodyOf = (c) => (typeof c?.body === 'string' ? c.body : '');
const timeOf = (c) => { const t = Date.parse(c?.createdAt ?? ''); return Number.isFinite(t) ? t : NaN; };
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
    ...takeoverEpisodes(list).map((e) => ({ at: e.end, start: e.start, via: 'takeover',
      // An automatic-only takeover's marker names the head it started from (takeover-budget.mjs#dispatchJudgeRule).
      startHead: e.kinds.length === 1 && e.kinds[0] === 'marker' ? e.head ?? null : null })),
    ...list.filter(isEscalationDispatch).map((c) => ({ at: timeOf(c), start: timeOf(c), via: 'escalation-rung', startHead: null })),
  ].filter((d) => Number.isFinite(d.at)).sort((a, b) => a.at - b.at);
}

/**
 * PURE: may this PR's CURRENT head get a review although the round cap is spent?
 * `{ ok: true, anchor, allowance, used, via }` or `{ ok: false, reason }`. ANY fix the system itself dispatched past
 * the cap — a takeover (of the PR's `fix.takeoverBudget`) or a fixer-escalation ladder rung — earns
 * `takeoverReviewAttempts` review(s) for the head it pushes. The anchor is the LATEST such dispatch, moved to the
 * first fixer push after it (a verdict on the OLD head that lands between the dispatch and the push spends nothing).
 * How many dispatches run at all stays bounded by the takeover budget/progress guard and the ladder's own human rung.
 * Reasons: `off` (setting 0), `thread-truncated` (the comment list may be cut at the list cap:
 * `takeover-budget.mjs#threadMayBeTruncated`), `no-takeover` (no escalation dispatch), `head-already-reviewed` (a verdict names this
 * head), `takeover-review-spent` (verdicts after the anchor already used the allowance).
 * @param {{pr:{headRefOid?:string, comments?:Array<object>}, takeoverReviewAttempts?:number}} o
 */
export function takeoverReviewGrant({ pr, takeoverReviewAttempts = 0 } = {}) {
  const allowance = Number.isInteger(takeoverReviewAttempts) && takeoverReviewAttempts > 0 ? takeoverReviewAttempts : 0;
  if (!allowance) return { ok: false, reason: 'off' };
  const comments = Array.isArray(pr?.comments) ? pr.comments : [];
  // A cut thread hides the verdicts after comment 100: a head already judged would read as owed its review.
  if (threadMayBeTruncated(comments)) return { ok: false, reason: 'thread-truncated' };
  const dispatches = escalationDispatches(comments);
  if (!dispatches.length) return { ok: false, reason: 'no-takeover' };
  const latest = dispatches.at(-1);
  // The same rule the takeover budget's progress guard uses: a delayed review of the old code spends nothing, so the
  // grant and the guard never disagree about whether the dispatch's own head was reviewed.
  const rule = dispatchJudgeRule(comments, { start: latest.start, end: latest.at, startHead: latest.startHead });
  const anchor = rule.anchor;
  const head = String(pr?.headRefOid ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(head)) return { ok: false, reason: 'no-head' };
  const verdicts = comments.filter(isVerdict);
  if (verdicts.some((c) => bodyOf(c).toLowerCase().includes(head) || verdictJudged(c, head))) return { ok: false, reason: 'head-already-reviewed' };
  const used = verdicts.filter((c) => rule.judges(timeOf(c), verdictHeads(c))).length;
  if (used >= allowance) return { ok: false, reason: 'takeover-review-spent', used, allowance };
  return {
    ok: true, anchor: new Date(anchor).toISOString(), allowance, used, via: latest.via,
    takeover: takeoverEpisodes(comments).length,
  };
}
