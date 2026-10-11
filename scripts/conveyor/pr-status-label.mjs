/**
 * we:scripts/conveyor/pr-status-label.mjs — ONE `status:*` label per open PR: what is it waiting on right now.
 *
 * Before: #4708, #4689 and #4631 sat at the reviewer's round cap with no takeover, and nothing on the PR said so —
 * the `review-status:*` label only names a LIVE agent, and `review:*` names the review verdict. The operator had to
 * read the thread to learn a PR was stuck at the round limit.
 *
 * Now the review daemon's existing label writer (`review-status-tag.mjs#tagReviewStatus`, the one owner of the
 * derived PR labels — D5: labels render derived state, one writer) also keeps exactly one of these current every
 * tick, derived from the same facts it already reads plus the planner's rows for that PR:
 *
 *   status:needs-you        the operator queue would list it (NEEDS YOU / RULING NEEDED), or the system escalated
 *                           it to a person (takeover budget spent, takeover not converging, ruling dispute, …);
 *   status:takeover-running a live fixer is working the PR and the latest takeover has not been judged yet;
 *   status:fixing           a live fixer / CI-heal is working it, or a fix is owed;
 *   status:at-round-limit   the round cap is reached and the system's next step is a takeover (planned or awaiting);
 *   status:awaiting-base    stacked on a base PR that has not landed;
 *   status:awaiting-ci      waiting for CI (draft-first, or the review is held for checks);
 *   status:awaiting-review  a review is owed or running;
 *   status:ready-to-merge   accepted (`review:accepted`).
 *
 * PURE: {@link derivePrStatusLabel} and {@link planPrStatusLabel}. The IO is the caller's existing label write.
 */
import { rulingNeeded } from '../lib/ruling-ledger.mjs';
import { ADVISORY_LABELS, latestAdvisory, advisoryCoversHead, ADVISORY_OUTCOMES } from '../lib/advisory-labels.mjs';
import { takeoverEpisodes } from './takeover-budget.mjs';
import { isReviewVerdictComment } from './mechanical-round-cap.mjs';

export const PR_STATUS_PREFIX = 'status:';
export const PR_STATUS_STATES = Object.freeze([
  'needs-you', 'takeover-running', 'fixing', 'at-round-limit', 'awaiting-base', 'awaiting-ci', 'awaiting-review', 'ready-to-merge',
]);
export const PR_STATUS_LABEL_RE = new RegExp(`^status:(${PR_STATUS_STATES.join('|')})$`);
export const PR_STATUS_DESCRIPTIONS = Object.freeze({
  'needs-you': 'Waiting on the operator (operator queue: NEEDS YOU / RULING NEEDED, or escalated) — auto-managed',
  'takeover-running': 'A takeover fixer is working this PR past the round limit — auto-managed',
  fixing: 'A fixer is working this PR, or a fix is owed — auto-managed',
  'at-round-limit': 'Round limit reached; a takeover is planned or its review is owed — auto-managed',
  'awaiting-base': 'Waiting for the base PR to land — auto-managed',
  'awaiting-ci': 'Waiting for CI — auto-managed',
  'awaiting-review': 'A review is owed or running — auto-managed',
  'ready-to-merge': 'Accepted; waiting to land — auto-managed',
});

/** Takeover reasons that hand the PR to a person (the note says "a person must decide/take it over"). */
const ESCALATED = new Set(['takeover-budget-spent', 'takeover-not-converging', 'takeover-spent', 'takeover-void-limit', 'ruling-dispute', 'setting-person', 'setting-disabled']);
const names = (labels) => (Array.isArray(labels) ? labels : []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
const timeOf = (c) => { const t = Date.parse(c?.createdAt ?? c?.created_at ?? ''); return Number.isFinite(t) ? t : NaN; };

/** PURE: the operator queue's NEEDS YOU label gate (`we:scripts/operations/operator-queue.mjs#evaluatePr`, labels +
 *  advisory on this head; CI and mergeability are the queue's own late checks and do not change whose turn it is). */
export function operatorQueueNeedsYou(pr) {
  const l = names(pr?.labels);
  if (!l.includes('review:human') || !l.includes(ADVISORY_LABELS.ACCEPTED)) return false;
  if (l.includes('review:pending') || l.includes('review:changes')) return false;
  const adv = latestAdvisory(Array.isArray(pr?.comments) ? pr.comments : []);
  return Boolean(adv) && advisoryCoversHead(adv, String(pr?.headRefOid ?? '').toLowerCase()) && adv.outcome === ADVISORY_OUTCOMES.ACCEPT;
}

/** PURE: the latest takeover has not been judged yet (no review verdict after it). */
export function takeoverUnjudged(comments) {
  const latest = takeoverEpisodes(comments).at(-1);
  if (!latest) return false;
  return !(Array.isArray(comments) ? comments : []).some((c) => isReviewVerdictComment(c) && timeOf(c) > latest.end);
}

/**
 * PURE: the ONE `status:*` state for a PR, or null when none applies.
 * @param {{pr?:object, labels?:Array, reviewStatus?:{role?:string,state?:string}|null, rows?:Array<object>, defaultBranch?:string, humanAt?:number}} o
 *   `rows` = this tick's planner rows for the PR (dispatch rows, refusals, notes).
 */
export function derivePrStatusLabel({ pr = {}, labels, reviewStatus = null, rows = [], defaultBranch = 'main', humanAt } = {}) {
  const l = names(labels ?? pr?.labels);
  const comments = Array.isArray(pr?.comments) ? pr.comments : [];
  const rs = reviewStatus?.state ?? null;
  const list = Array.isArray(rows) ? rows : [];
  if (l.includes('review:accepted')) return 'ready-to-merge';
  let ruling = null;
  try { ruling = rulingNeeded({ ...pr, labels: l.map((name) => ({ name })) }, humanAt === undefined ? {} : { humanAt }); } catch { ruling = null; }
  const escalated = list.some((r) => (r.kind === 'cap-exhausted' && ESCALATED.has(r.takeover))
    || r.kind === 'ruling-dispute' || r.kind === 'stood-down' || r.takeoverNotConverging === true);
  if (ruling || escalated || operatorQueueNeedsYou({ ...pr, labels: l.map((name) => ({ name })) }) || rs === 'needs-human') return 'needs-you';
  if (reviewStatus?.role === 'fix' || reviewStatus?.role === 'ci-heal') return takeoverUnjudged(comments) && reviewStatus.role === 'fix' ? 'takeover-running' : 'fixing';
  if (list.some((r) => r.mode === 'takeover' || r.takeoverReview?.ok || r.kind === 'cap-exhausted' || r.kind === 'takeover-awaiting-review')) return 'at-round-limit';
  if (rs === 'awaiting-base' || l.includes('review-status:awaiting-base')
    || list.some((r) => r.kind === 'stacked-awaiting-base' || (r.kind === 'gate-hold' && /base/.test(String(r.hold ?? ''))))) return 'awaiting-base';
  if (rs === 'awaiting-ci' || list.some((r) => ['review-ci', 'owed-ci-rerun'].includes(r.kind))) return 'awaiting-ci';
  if (rs === 'reviewing' || rs === 'review-stalled' || list.some((r) => r.kind === 'review') || l.includes('review:pending')) return 'awaiting-review';
  if (list.some((r) => r.kind === 'fix' || r.kind === 'ci-heal') || l.includes('review:changes')) return 'fixing';
  return null;
}

/** PURE: what to add/remove so the PR carries exactly `status:<state>` (or no `status:*` label when null). */
export function planPrStatusLabel({ state, currentLabels = [] } = {}) {
  const l = names(currentLabels);
  const desired = state ? `${PR_STATUS_PREFIX}${state}` : null;
  const stale = l.filter((n) => PR_STATUS_LABEL_RE.test(n) && n !== desired);
  const has = desired ? l.includes(desired) : true;
  return { add: has ? null : desired, remove: stale };
}
