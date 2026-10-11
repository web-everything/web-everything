/**
 * we:scripts/conveyor/takeover-review.mjs — a takeover head earns ONE review beyond the round cap.
 *
 * Before: a takeover (automatic, card xx0055i, or an operator-approved manual one) runs only AFTER a PR spent its
 * rounds, so the head it pushes is already over the cap. The planner refused that head as `cap-exhausted` every
 * tick and nothing ever judged the takeover's work (live: #4708, takeover head 7e29b95c4 at 5/5, stuck at
 * review:changes). Now a head pushed after a takeover gets exactly `review.takeoverReviewAttempts` (default 1)
 * review dispatches beyond the cap. Once a review verdict lands after the takeover, every later head is capped
 * again. The merge gate and the human ceremony are untouched: this only lets the REVIEW run; `review:human`
 * still needs the operator.
 *
 * A takeover is identified by a TRUSTED comment only (automation or the operator, never a forgeable body):
 *   - the fix daemon's takeover marker `<!-- conveyor-fix-takeover head=<sha> -->` (we:scripts/conveyor/fix-takeover.mjs);
 *   - the operator-approved takeover comment, leading line `**Takeover (operator OK)`.
 *
 * PURE: reads only the PR's own comment thread and head sha.
 */
import { takeoverMarkers } from './fix-takeover.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
// A conflict-watch bounce asks for a rebase and judges nothing, so it never spends the takeover's review (live:
// #4631, whose takeover head was bounced for a merge conflict and then refused 6/5 as if reviewed).
import { isReviewVerdictComment as isVerdict } from './mechanical-round-cap.mjs';

export const OPERATOR_TAKEOVER_PREFIX = '**Takeover (operator OK)';

const bodyOf = (c) => (typeof c?.body === 'string' ? c.body : '');
const timeOf = (c) => { const t = Date.parse(c?.createdAt ?? ''); return Number.isFinite(t) ? t : NaN; };

function isOperatorTakeover(c) {
  return bodyOf(c).trimStart().startsWith(OPERATOR_TAKEOVER_PREFIX) && isTrustedMarkerAuthor(c);
}

/**
 * PURE: may this PR's CURRENT head get a review although the round cap is spent?
 * `{ ok: true, anchor, allowance, used }` or `{ ok: false, reason }`. Reasons:
 *   `off` (setting 0), `no-takeover`, `head-already-reviewed` (a verdict names this head — e.g. the head the
 *   automatic takeover started from, before it pushed), `takeover-review-spent` (verdicts after the takeover
 *   already used the allowance — every later head respects the cap).
 * @param {{pr:{headRefOid?:string, comments?:Array<object>}, takeoverReviewAttempts?:number}} o
 */
export function takeoverReviewGrant({ pr, takeoverReviewAttempts = 0 } = {}) {
  const allowance = Number.isInteger(takeoverReviewAttempts) && takeoverReviewAttempts > 0 ? takeoverReviewAttempts : 0;
  if (!allowance) return { ok: false, reason: 'off' };
  const comments = Array.isArray(pr?.comments) ? pr.comments : [];
  // The automatic marker is read through `takeoverMarkers`, which cancels a marker a trusted void marker covers: a
  // takeover that never launched must not anchor a grant for whatever head arrives next.
  const signals = [
    ...comments.filter(isOperatorTakeover).map(timeOf),
    ...takeoverMarkers(comments).map((m) => Date.parse(m.at ?? '')),
  ].filter(Number.isFinite);
  if (!signals.length) return { ok: false, reason: 'no-takeover' };
  const anchor = Math.min(...signals);
  const head = String(pr?.headRefOid ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(head)) return { ok: false, reason: 'no-head' };
  const verdicts = comments.filter(isVerdict);
  if (verdicts.some((c) => bodyOf(c).toLowerCase().includes(head))) return { ok: false, reason: 'head-already-reviewed' };
  const used = verdicts.filter((c) => timeOf(c) > anchor).length;
  if (used >= allowance) return { ok: false, reason: 'takeover-review-spent', used, allowance };
  return { ok: true, anchor: new Date(anchor).toISOString(), allowance, used };
}
