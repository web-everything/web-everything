import { isCardOnlyDiff } from '../ci-card-only.mjs';
/** Shared scheduling policy; importing it never loads a review dispatcher or CLI. */
import { redTeamRequired, VERDICTS } from './jury-core.mjs';
import { ADVISORY_OUTCOMES } from './advisory-labels.mjs';
import { advisoryLabelOutcome } from './review-advisory-outcome.mjs';
import { isPublishableRedTeamResult, redTeamResultId } from './red-team-gate.mjs';
import { completedRedTeamSeat } from './red-team-run-result.mjs';

/** Kill switch: `0` (or `off`/`false`) turns every added seat off. Unset = on. */
export const EXTRA_SEATS_ENV = 'WE_REVIEW_EXTRA_SEATS';
export const RED_TEAM_ENV = 'WE_REVIEW_RED_TEAM';

/** @returns {boolean} false only when the kill switch is explicitly thrown. PURE. */
export function extraSeatsEnabled(env = process.env) {
  const raw = String(env?.[EXTRA_SEATS_ENV] ?? '').trim().toLowerCase();
  return !['0', 'off', 'false', 'no'].includes(raw);
}

/** @returns {boolean} false when either kill switch is thrown. PURE. */
export function redTeamEnabled(env = process.env) {
  const raw = String(env?.[RED_TEAM_ENV] ?? '').trim().toLowerCase();
  return extraSeatsEnabled(env) && !['0', 'off', 'false', 'no'].includes(raw);
}

/**
 * Card xyyuvyz — IS THE RED TEAM OWED FOR THIS FINISHED REVIEW? PURE. The one gate the job, the sequential pass and
 * the speculative finish all read, so they can never disagree. Owed on EVERY head the panel accepts:
 *   - a recorded accept ({@link redTeamRequired}); or
 *   - a `review:human` ADVISORY accept: the run reduced to `needs-human` only because the human gate applies
 *     (`verdict.humanRequired`), and the panel itself reduces to accept — the SAME `advisoryLabelOutcome` the advisory
 *     note states and the `advisory:accepted` label applies (a pinned, non-degraded read; no blocked or pending
 *     referral). Live gap #4722: the red team broke head ea117e881, the fix landed as e125ac999, the panel accepted
 *     it under `review:human`, and no red team ran on the fixed head.
 * Once per head is not decided here: the pass keys its row and comment by `(pr, netBasis.rev)` and resumes, never
 * re-runs, a head that already has a clean row.
 * @param {object|null} loopPayload - `review-loop-cli.mjs --json`'s payload.
 * @returns {boolean}
 */
export function redTeamOwedFor(loopPayload) {
  const verdict = loopPayload?.verdict;
  if (!verdict || typeof verdict !== 'object') return false;
  if (redTeamRequired(verdict.verdict ?? null)) return true;
  if (verdict.verdict !== VERDICTS.NEEDS_HUMAN || verdict.humanRequired !== true) return false;
  return advisoryLabelOutcome({ read: loopPayload?.findings?.read, verdict }) === ADVISORY_OUTCOMES.ACCEPT;
}


/** Net diff includes rename/copy sources; unknown paths cannot justify skipping. */
export function redTeamCardOnly(read) {
  const paths = Array.isArray(read?.netChangedFiles) && read.netChangedFiles.length
    && (read.netRenameSources == null || Array.isArray(read.netRenameSources))
    ? [...read.netChangedFiles, ...(read.netRenameSources ?? [])] : null;
  return isCardOnlyDiff(paths);
}

/** Fixed routing: prose is operator output, never a machine discriminator. */
export const RED_TEAM_HOLDS = Object.freeze(Object.fromEntries(Object.entries({
  break: [true, 'post-accept red team confirmed a break requiring send-back'],
  'evidence-unknown': [true, 'post-accept red team evidence unknown; hold and inspect run evidence'],
  'carry-conflict': [true, 'post-accept red team carry conflicts with head evidence; hold and inspect run evidence'],
  'unreviewable-read': [true, 'post-accept red team read is unreviewable (unreviewable-read); hold and inspect scored head-bound diff evidence'],
  'seat-rows-invalid': [true, 'post-accept red team seat rows invalid; hold and inspect scorecard evidence before retrying'],
  'result-incomplete': [true, 'post-accept red team result incomplete; hold and inspect completed review and seat evidence'],
  'pending-publish': [false, 'post-accept red team result is not published yet (stored evidence not sealed); hold until the sweep publishes it'],
  'pass-owed': [false, 'post-accept red team has no recorded result on the live head'],
}).map(([kind, [blocking, message]]) => [kind, Object.freeze({ kind, blocking, message })])));

/** Empty or unscored reads cannot prove either a pass or a card-only exemption. */
export function redTeamReadReviewable(read, head) {
  return typeof head === 'string' && !!head && read?.netBasis?.rev === head
    && read.diffScored === true && typeof read.diffText === 'string' && !!read.diffText.trim();
}

/** One decision for admission, recovery and carry. Inputs are normalized by the evidence reader. */
export function redTeamOwedDecision({ head, read, seats, result, carry, scheduling = {},
  ok, reason, carryConflict, hasBreak = false, pendingPublish = false } = {}) {
  const reasons = [];
  const hold = kind => reasons.push(RED_TEAM_HOLDS[kind]);
  if (hasBreak) hold('break');
  if (ok === false) reasons.push({ ...RED_TEAM_HOLDS['evidence-unknown'],
    message: `post-accept red team evidence unknown (${reason}); hold and inspect run evidence` });
  if (carryConflict) hold('carry-conflict');
  const reviewable = redTeamReadReviewable(read, head);
  if (pendingPublish) hold('pending-publish');
  if (!reviewable) hold('unreviewable-read');
  const validSeats = Array.isArray(seats) && seats.every(row => row?.valid === true);
  if (!validSeats) hold('seat-rows-invalid');
  const exempt = reviewable && validSeats && seats.length === 0 && scheduling.skipCardOnly === true
    && redTeamCardOnly(read) && !scheduling.inFlight && !scheduling.queued;
  let owed = !exempt || reasons.length > 0;
  const completedResult = isPublishableRedTeamResult(result) && result.completedReview === true && result.rev === head;
  let carried = false;
  if (carry) {
    carried = completedResult && !!carry.fromRev && carry.fromRev !== head && !!carry.proof
      && !!redTeamResultId(result) && redTeamResultId(result) === redTeamResultId(carry.proof.result)
      && redTeamOwedDecision({ ...carry.proof, head: carry.fromRev }).cleared;
    if (!carried && !carryConflict) hold('carry-conflict');
    if (!carried) owed = true;
  }
  if (owed && !carried) {
    if (!result) hold('pass-owed');
    else if (!(completedResult && read?.netBasis?.rev === result.rev && validSeats && seats.some(completedRedTeamSeat))) hold('result-incomplete');
  }
  return { owed, cleared: reasons.length === 0, reasons };
}
