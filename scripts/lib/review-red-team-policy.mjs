import { isCardOnlyDiff } from '../ci-card-only.mjs';
/** Shared scheduling policy; importing it never loads a review dispatcher or CLI. */
import { redTeamRequired, VERDICTS } from './jury-core.mjs';
import { ADVISORY_OUTCOMES } from './advisory-labels.mjs';
import { advisoryLabelOutcome } from './review-advisory-outcome.mjs';

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

/** Empty or unscored input cannot support a review or its publication. */
export function redTeamReadReviewable(read) {
  return read?.diffScored === true && typeof read.diffText === 'string' && !!read.diffText.trim();
}

/**
 * One full-evidence decision for admission, publication and recovery. Never reduce evidence before calling:
 * a status/carry read can contradict the selected read, and a historical policy-clear cannot pay current debt.
 * `panelOwed` describes the panel verdict only; `owed` includes execution/publication debt and unknown reads.
 * Head/provenance/live-hold checks remain the caller's responsibility before performing an effect.
 */
export function redTeamOwedDecision({ fullEvidence = {} } = {}) {
  const e = fullEvidence ?? {};
  const status = Object.hasOwn(e, 'liveStatus') ? e.liveStatus : e.status ?? e.rawWriter?.parsed ?? e.rawWriter;
  const payload = e.loopPayload ?? e.storedReview?.newest ?? e.newest ?? e.carry?.loopPayload ?? status?.loopPayload;
  const read = e.read ?? payload?.findings?.read;
  const reads = [read];
  if (Object.hasOwn(e, 'read')) reads.push(e.read);
  if (e.carry != null) reads.push(e.carry.loopPayload?.findings?.read);
  for (const source of [e.loopPayload, e.status?.loopPayload, e.liveStatus?.loopPayload, e.rawWriter?.parsed?.loopPayload, e.rawWriter?.loopPayload, e.storedReview?.newest, e.carry?.loopPayload]) {
    if (source != null) reads.push(source.findings?.read);
  }
  const readReviewable = reads.every(redTeamReadReviewable);
  const panelOwed = redTeamOwedFor(payload);
  const cardOnly = redTeamCardOnly(read);
  const skip = e.skipCardOnly ?? status?.skipCardOnly ?? e.defaultSkipCardOnly ?? true;
  const result = status?.result;
  const prior = typeof result === 'string' ? result : result?.status;
  const executing = !!(e.inFlight || e.recorded || e.seatRecorded || e.completedRecorded
    || e.cleanRecorded || e.seats?.length || ['ran', 'resumed'].includes(prior));
  const unknown = e.ok === false || !!e.carryConflict;
  const deferred = value => value?.deferredByGuard || value?.deferredByCap;
  const policySkip = value => value?.status === 'skipped' && value.policy === 'card-only' && !deferred(value);
  const cardOnlyExempt = skip === true && (cardOnly || (read?.netChangedFiles == null
    && (policySkip(e.redTeam) || policySkip(result) || e.carry?.kind === 'card-only' || e.kind === 'card-only')));
  const notOwedStatus = candidate => candidate?.status === 'finished'
    && (typeof candidate.result === 'string' ? candidate.result : candidate.result?.status) === 'not-owed'
    && !deferred(candidate.result);
  const finishedNotOwed = notOwedStatus(status)
    && (!Object.hasOwn(e, 'liveStatus') || notOwedStatus(e.status));
  const verdict = payload?.verdict;
  const storedNotOwed = Object.values(VERDICTS).includes(verdict?.verdict) && !panelOwed
    && (verdict.verdict !== VERDICTS.NEEDS_HUMAN || verdict.humanRequired !== true
      || advisoryLabelOutcome({ read: payload?.findings?.read, verdict }) === ADVISORY_OUTCOMES.CHANGES);
  const owed = !readReviewable || unknown || executing
    || (!cardOnlyExempt && !!(e.scheduled || e.queued || (prior === 'skipped' && panelOwed)));
  const historicalResult = e.disposition?.result ?? e.historicalResult;
  const settlementEligible = !owed && !e.queued
    && (cardOnlyExempt || finishedNotOwed || storedNotOwed || historicalResult?.policyClear === true || (e.storedReviewPolicyClear === true && e.accepted === true));
  // Settlement provenance is narrower than "nothing owed": only a finished, head-bound card skip can carry.
  const statusRead = status?.loopPayload?.findings?.read;
  const skipNeedsSettlement = settlementEligible && cardOnly && status?.status === 'finished'
    && prior === 'skipped' && (typeof result === 'string' || result?.policy === 'card-only')
    && status.skipCardOnly === true && /^[a-f0-9]{40}$/i.test(status.head ?? '')
    && statusRead?.netBasis?.rev === status.head && redTeamCardOnly(statusRead);
  const carrySettlementEligible = skipNeedsSettlement && e.recorded === false && e.seatRecorded === false;
  const storedReviewSettlementEligible = settlementEligible && e.inFlight === false
    && e.recorded === false && e.seatRecorded === false;
  const cardOnlyBypassEligible = settlementEligible && cardOnlyExempt && !e.scheduled && !result?.foldedVerdict;
  const historicalSkipCandidate = readReviewable && !unknown && !executing && !e.queued && cardOnly
    && status?.status === 'finished' && status.skipCardOnly === true && prior === 'skipped';
  const cardOnlySkipped = cardOnlyBypassEligible && status?.status === 'finished'
    && policySkip(result) && e.skipCardOnly === true;
  const folded = status?.status === 'finished' ? result?.foldedVerdict : null;
  const cleared = readReviewable && !unknown && (historicalResult
    ? historicalResult.policyClear !== true || !owed
    : folded === 'accept');
  const hasWork = e.scheduled || executing || status || e.carry || historicalResult;
  const statusLabel = folded === 'changes' ? 'red-team:blocked' : cleared ? 'red-team:clear'
    : owed && (readReviewable || hasWork) ? 'red-team:pending' : null;
  const reason = !readReviewable ? 'unreviewable-read' : unknown ? 'evidence-unknown'
    : executing ? 'execution-owed' : finishedNotOwed ? 'finished-not-owed'
      : cardOnlyExempt ? 'card-only-exempt' : owed ? 'pass-owed' : 'no-pass-owed';
  return { owed, cleared: !!cleared, settlementEligible, skipNeedsSettlement, panelOwed, cardOnly,
    readReviewable, carrySettlementEligible, storedReviewSettlementEligible, cardOnlyBypassEligible, cardOnlySkipped, historicalSkipCandidate, finishedNotOwed, statusLabel, storedReviewNotOwed: settlementEligible && storedNotOwed, reason };
}

/** Compatibility entry; all decisions still consume the complete evidence. */
export function redTeamOwedOnHead({ read, evidence = {}, skipCardOnly = true } = {}) {
  return redTeamOwedDecision({ fullEvidence: { ...evidence, read, defaultSkipCardOnly: skipCardOnly } }).owed;
}
