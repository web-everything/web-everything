import { readRedTeamTiming } from './red-team-gate.mjs';
import { isCardOnlyDiff } from '../ci-card-only.mjs';
import { CARD_REVIEW_CLASS, cardReviewClass } from './card-review-class.mjs';
import { resolveCardClassSettings } from './review-seat-settings.mjs';

/**
 * The card-class red-team mode for this read — `off` | `advisory` | `on` (`review.cardClass.redTeam`) — or `null`
 * when the head is not in the card class, the class is switched off, or the red team is not on `panel-seat`
 * timing (post-accept keeps its own `skipCardOnly` rule unchanged), i.e. today's red-team rules apply.
 */
export function cardClassRedTeamMode(read, env = process.env, settings = resolveCardClassSettings({ env }).value) {
  if (readRedTeamTiming({ env }).value.timing !== 'panel-seat') return null;
  return cardReviewClass(read, settings).class === CARD_REVIEW_CLASS.CARD ? settings.redTeam : null;
}
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

/**
 * Red team owed after acceptance. The caller must first verify a live `review:accepted` label.
 * An operator may accept a pinned review whose panel verdict still says needs-human.
 * @param {object|null} loopPayload - The completed review's payload.
 * @returns {boolean}
 */
export function redTeamOwedForAcceptedPr(loopPayload) {
  return redTeamOwedFor(loopPayload) || (!!loopPayload?.verdict && typeof loopPayload.verdict === 'object'
    && /^[a-f0-9]{40}$/i.test(loopPayload?.findings?.read?.netBasis?.rev ?? ''));
}

/**
 * The red-team pass's own owed gate: a panel accept ({@link redTeamOwedFor}), or a drain request for an accepted PR.
 * `acceptedPrHead` is stamped only by the drain request consumer after it read a live `review:accepted` on that exact
 * head; it counts only when it names the payload's pinned head. Live gap #5549: the consumer ran, the pass said
 * `not-owed`, and the head stayed red-team-pending.
 * @param {object|null} loopPayload
 * @returns {boolean}
 */
export function redTeamOwedForPass(loopPayload) {
  if (redTeamOwedFor(loopPayload)) return true;
  const rev = loopPayload?.findings?.read?.netBasis?.rev;
  return typeof loopPayload?.acceptedPrHead === 'string' && typeof rev === 'string'
    && loopPayload.acceptedPrHead.toLowerCase() === rev.toLowerCase() && redTeamOwedForAcceptedPr(loopPayload);
}


/**
 * A pinned reviewed head owes the panel seat regardless of the panel verdict — except a head in the `card` review
 * class whose `review.cardClass.redTeam` mode is `off` (skipped) or `advisory` (runs, never owed or blocking).
 * A decision card, a ratified rule, anything not provably card-only, or the class switched off still owes it.
 */
export function redTeamPanelSeatOwed(loopPayload, env = process.env) {
  const read = loopPayload?.findings?.read;
  if (readRedTeamTiming({ env }).value.timing !== 'panel-seat' || !/^[a-f0-9]{40}$/i.test(read?.netBasis?.rev ?? '')) return false;
  return !['off', 'advisory'].includes(cardClassRedTeamMode(read, env));
}

/** Net diff includes rename/copy sources; unknown paths cannot justify skipping.
 * Drain consumers (drain-red-team-review/evidence, drain-merge-strategy and drain-queue-safety)
 * read saved review-pr evidence pinned by netBasis.rev, whose netChangedFiles comes from git.
 * Never substitute GitHub view.files here. The separate replay producer resolves its GitHub
 * list through pr-real-files before constructing this read. */
export function redTeamCardOnly(read) {
  const paths = Array.isArray(read?.netChangedFiles) && read.netChangedFiles.length
    && (read.netRenameSources == null || Array.isArray(read.netRenameSources))
    ? [...read.netChangedFiles, ...(read.netRenameSources ?? [])] : null;
  return isCardOnlyDiff(paths);
}

/**
 * Is a red-team result owed on this head? An in-flight pass or recorded result is always owed its result. A card-only
 * head with only an attempt is exempt while the producer skips it. The producer's recorded skip decision
 * (`evidence.skipCardOnly`) wins over `skipCardOnly`, the caller's own resolved setting.
 */
export function redTeamOwedOnHead({ read, evidence = {}, skipCardOnly = true } = {}) {
  if (evidence.inFlight || evidence.recorded) return true;
  const skip = typeof evidence.skipCardOnly === 'boolean' ? evidence.skipCardOnly : skipCardOnly;
  if (skip && redTeamCardOnly(read)) return false;
  if (evidence.attempted) return true;
  return !!evidence.scheduled;
}
