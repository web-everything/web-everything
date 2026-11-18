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

/** Fixed routing: only pending publication is non-blocking. */
export const RED_TEAM_HOLDS = Object.freeze(Object.fromEntries(Object.entries({
  break: [true, 'post-accept red team confirmed a break requiring send-back'],
  'evidence-unknown': [true, 'post-accept red team evidence unknown; hold and inspect run evidence'],
  'carry-conflict': [true, 'post-accept red team carry conflicts with head evidence; hold and inspect run evidence'],
  'unreviewable-read': [true, 'post-accept red team read is unreviewable (unreviewable-read); hold and inspect scored head-bound diff evidence'],
  'seat-rows-invalid': [true, 'post-accept red team seat rows invalid; hold and inspect scorecard evidence before retrying'],
  'result-incomplete': [true, 'post-accept red team result incomplete; hold and inspect completed review and seat evidence'],
  'pending-publish': [false, 'post-accept red team result is not published yet (stored evidence not sealed); hold until the sweep publishes it'],
  'pass-owed': [true, 'post-accept red team has no recorded result on the live head'],
}).map(([kind, [blocking, message]]) => [kind, Object.freeze({ kind, blocking, message })])));

/** Empty or unscored reads cannot prove either a pass or a card-only exemption. */
export function redTeamReadReviewable(read, head) {
  return typeof head === 'string' && !!head && read?.netBasis?.rev === head
    && Array.isArray(read.netRenameSources)
    && read.diffScored === true && typeof read.diffText === 'string' && !!read.diffText.trim();
}

/** Every exemption prerequisite is positive proof; missing values never mean idle/empty/clean. */
export const RED_TEAM_EXEMPTION_INPUTS = Object.freeze({
  head: x => typeof x.head === 'string' && !!x.head,
  'read.netBasis.rev': x => x.read?.netBasis?.rev === x.head,
  'read.diffScored': x => x.read?.diffScored === true,
  'read.diffText': x => typeof x.read?.diffText === 'string' && !!x.read.diffText.trim(),
  'read.netChangedFiles': x => Array.isArray(x.read?.netChangedFiles) && x.read.netChangedFiles.length > 0 && redTeamCardOnly(x.read),
  'read.netRenameSources': x => Array.isArray(x.read?.netRenameSources) && redTeamCardOnly(x.read),
  seats: x => Array.isArray(x.seats) && x.seats.length === 0,
  ok: x => x.ok === true,
  result: x => x.result === null,
  carry: x => x.carry === null,
  carryConflict: x => x.carryConflict === false,
  hasBreak: x => x.hasBreak === false,
  blocked: x => x.blocked === false || x.breakResolved === true,
  storedVerdict: x => x.storedVerdict === null || x.breakResolved === true,
  pendingPublish: x => x.pendingPublish === false,
  'scheduling.skipCardOnly': x => x.scheduling?.skipCardOnly === true,
  'scheduling.settingsReadable': x => x.scheduling?.settingsReadable === true,
  'scheduling.commentsReadable': x => x.scheduling?.commentsReadable === true,
  'scheduling.sealClear': x => x.scheduling?.sealClear === true,
  'scheduling.execution': x => x.scheduling?.execution === 'none',
  'scheduling.recorded': x => x.scheduling?.recorded === false,
  'scheduling.inFlight': x => x.scheduling?.inFlight === false,
  'scheduling.queued': x => x.scheduling?.queued === false,
  'scheduling.scheduled': x => x.scheduling?.scheduled === false,
  runs: x => !!x.runs && ['result', 'comment', 'seats', 'execution', 'verdict', 'carry'].every(key => Array.isArray(x.runs[key]) && x.runs[key].length === 0),
});

/** These exemption predicates also govern every completed pass, including carried proof. */
export const RED_TEAM_CLEARANCE_INPUTS = Object.freeze({
  'scheduling.settingsReadable': 'evidence-unknown',
  'scheduling.commentsReadable': 'evidence-unknown',
  'scheduling.inFlight': 'pass-owed',
  'scheduling.queued': 'pass-owed',
});

/** Recorded rejections remain breaks until an explicit resolution or a completed pass proves otherwise. */
export const RED_TEAM_BREAK_INPUTS = Object.freeze({
  blocked: x => x.blocked === true && x.breakResolved !== true,
  storedVerdict: x => x.storedVerdict === 'changes' && x.breakResolved !== true,
});

/** The required streams participate in one identity/order comparison, including carried proof. */
export const RED_TEAM_RUN_INPUTS = Object.freeze(['result', 'comment', 'seats', 'execution', 'verdict', 'carry']);
export function redTeamRunProof({ runs, carry, breakResolved } = {}) {
  if (!runs || RED_TEAM_RUN_INPUTS.some(key => !Array.isArray(runs[key]))) return 'evidence-unknown';
  const records = RED_TEAM_RUN_INPUTS.flatMap(key => runs[key]);
  if (records.some(row => typeof row?.runId !== 'string' || !row.runId.trim()
    || !Number.isSafeInteger(row.order) || row.order < 0 || !['complete', 'break', 'changes', 'pending'].includes(row.outcome))) return 'evidence-unknown';
  // Different runs cannot share an append position; one run cannot change its position between stores.
  const byRun = new Map(), byOrder = new Map();
  for (const row of records) {
    if ((byRun.has(row.runId) && byRun.get(row.runId) !== row.order)
      || (byOrder.has(row.order) && byOrder.get(row.order) !== row.runId)) return 'evidence-unknown';
    byRun.set(row.runId, row.order); byOrder.set(row.order, row.runId);
  }
  for (const key of RED_TEAM_RUN_INPUTS) for (let i = 1; i < runs[key].length; i++) {
    if (runs[key][i].order < runs[key][i - 1].order) return 'evidence-unknown';
  }
  const candidate = runs.result.at(-1);
  const latestOrder = records.reduce((latest, row) => Math.max(latest, row.order), -1);
  if (!candidate) return records.some(row => row.order === latestOrder && ['break', 'changes'].includes(row.outcome)) ? 'break' : 'evidence-unknown';
  if (records.some(row => row.order >= candidate.order && (row.outcome === 'break'
    || (row.outcome === 'changes' && !(breakResolved === true && row.order === candidate.order))))) return 'break';
  if (carry && (carry.proof?.runs?.comment?.at(-1)?.runId !== candidate.runId
    || carry.proof?.runs?.comment?.at(-1)?.order !== candidate.order)) return 'evidence-unknown';
  const required = carry ? ['result', 'comment', 'carry'] : ['result', 'comment', 'seats', 'execution', 'verdict'];
  if (required.some(key => !runs[key].length)) return 'evidence-unknown';
  if (records.some(row => row.order > candidate.order || (row.order === candidate.order && row.runId !== candidate.runId))
    || required.some(key => runs[key].at(-1).runId !== candidate.runId
      || !(runs[key].at(-1).outcome === 'complete'
        || (breakResolved === true && runs[key].at(-1).outcome === 'changes')))) return 'evidence-unknown';
  return null;
}

/** One decision for admission, recovery and carry. Inputs are normalized by the evidence reader. */
export function redTeamOwedDecision(input = {}) {
  const { head, read, seats, result, carry, scheduling = {},
    ok, reason, carryConflict, hasBreak = false, pendingPublish = false } = input;
  const reasons = [];
  const hold = kind => reasons.push(RED_TEAM_HOLDS[kind]);
  if (hasBreak) hold('break');
  if (ok === false) reasons.push({ ...RED_TEAM_HOLDS['evidence-unknown'],
    message: `post-accept red team evidence unknown (${reason}); hold and inspect run evidence` });
  if (carryConflict) hold('carry-conflict');
  const completeInput = Array.isArray(input.missingInputs) && input.missingInputs.length === 0;
  if (!completeInput && !reasons.some(hold => hold.kind === 'evidence-unknown')) reasons.push({
    ...RED_TEAM_HOLDS['evidence-unknown'], message: `${RED_TEAM_HOLDS['evidence-unknown'].message}; missing or invalid decision inputs: ${input.missingInputs?.join?.(', ') ?? 'input contract'}` });
  const reviewable = redTeamReadReviewable(read, head);
  if (pendingPublish) hold('pending-publish');
  if (!reviewable) hold('unreviewable-read');
  const validSeats = Array.isArray(seats) && Array.from(seats).every(row => row?.valid === true);
  if (!validSeats) hold('seat-rows-invalid');
  const recordedBreak = Object.values(RED_TEAM_BREAK_INPUTS).some(proven => proven(input));
  const exempt = !recordedBreak && Object.values(RED_TEAM_EXEMPTION_INPUTS).every(proven => proven(input));
  let owed = !exempt || reasons.length > 0;
  const completedResult = isPublishableRedTeamResult(result) && result.completedReview === true && result.rev === head;
  const runHold = !exempt ? completeInput ? redTeamRunProof(input) : 'evidence-unknown' : null;
  let carried = false;
  if (carry) {
    const sourceDecision = completedResult && carry.fromRev && carry.fromRev !== head && carry.proof
      ? redTeamOwedDecision({ ...carry.proof, head: carry.fromRev }) : null;
    for (const kind of ['break', 'evidence-unknown']) {
      if (sourceDecision?.reasons.some(hold => hold.kind === kind) && !reasons.some(hold => hold.kind === kind)) hold(kind);
    }
    carried = !runHold && completedResult && !!carry.fromRev && carry.fromRev !== head && !!carry.proof
      && !!redTeamResultId(result) && redTeamResultId(result) === redTeamResultId(carry.proof.result)
      && sourceDecision?.cleared;
    if (!carried && !carryConflict) hold('carry-conflict');
    if (!carried) owed = true;
  }
  const completedPass = !runHold && completedResult && reviewable && read.netBasis.rev === result.rev
    && validSeats && seats.some(completedRedTeamSeat);
  if (recordedBreak && !completedPass && !carried && !hasBreak) reasons.unshift(RED_TEAM_HOLDS.break);
  if (runHold && completedResult && reviewable && validSeats && seats.some(completedRedTeamSeat)
    && !reasons.some(reason => reason.kind === runHold)) hold(runHold);
  if (owed && !carried) {
    if (!result) hold(scheduling.recorded ? 'result-incomplete' : 'pass-owed');
    else if (!completedPass) hold('result-incomplete');
  }
  if (runHold && !reasons.some(reason => reason.kind === runHold)) hold(runHold);
  for (const [key, kind] of Object.entries(RED_TEAM_CLEARANCE_INPUTS)) {
    if (!RED_TEAM_EXEMPTION_INPUTS[key](input) && !reasons.some(hold => hold.kind === kind)) hold(kind);
  }
  return { owed, cleared: reasons.length === 0, reasons };
}
