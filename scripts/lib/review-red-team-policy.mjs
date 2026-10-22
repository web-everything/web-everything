import { readRedTeamTiming } from './red-team-gate.mjs';
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


/** A pinned reviewed head owes the panel seat regardless of the panel verdict. */
export function redTeamPanelSeatOwed(loopPayload, env = process.env) {
  return readRedTeamTiming({ env }).value.timing === 'panel-seat'
    && /^[a-f0-9]{40}$/i.test(loopPayload?.findings?.read?.netBasis?.rev ?? '');
}

/** Net diff includes rename/copy sources; unknown paths cannot justify skipping. */
export function redTeamCardOnly(read) {
  const paths = Array.isArray(read?.netChangedFiles) && read.netChangedFiles.length
    && (read.netRenameSources == null || Array.isArray(read.netRenameSources))
    ? [...read.netChangedFiles, ...(read.netRenameSources ?? [])] : null;
  return isCardOnlyDiff(paths);
}

/**
 * Is a red-team result owed on this head? A pass that started or finished is always owed its result. A card-only
 * head is exempt only while the producer skips it: the skip decision the producer's process recorded with the
 * head's status (`evidence.skipCardOnly`) wins over `skipCardOnly`, the caller's own resolved setting.
 */
export function redTeamOwedOnHead({ read, evidence = {}, skipCardOnly = true } = {}) {
  if (evidence.inFlight || evidence.recorded) return true;
  const skip = typeof evidence.skipCardOnly === 'boolean' ? evidence.skipCardOnly : skipCardOnly;
  if (skip && redTeamCardOnly(read)) return false;
  return !!evidence.scheduled;
}
