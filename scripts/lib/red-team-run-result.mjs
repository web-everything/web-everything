import { redTeamOwedFor, redTeamReadReviewable } from './review-red-team-policy.mjs';
/** A successful seat execution can have a failing verdict. Reuse it without another model call. */
export function completedRedTeamSeat(row) {
  return row?.status === 'ok' && (row.seatStatus === undefined || row.seatStatus === 'ok');
}

/** Review-job stores its review run as loopPayload; that alone is not a red-team run. */
export function reviewOnlyRedTeamResult(result) {
  return (result?.op === 'review-pr' || result?.loopPayload?.op === 'review-pr')
    && !Array.isArray(result.findings) && !result.provider && !result.model;
}

/** Null completions require the original queued record from confirmed-dead recovery.
 * Without that provenance, a null result may conceal a run whose seat evidence was lost.
 */
export function redTeamStatusWithoutRun(row, { originalStatus } = {}) {
  if (row?.status !== 'finished') return false;
  // The durable retry spend survives missing seat rows and legacy placeholder results.
  if (row.retryCount !== undefined && row.retryCount !== 0) return false;
  return (row.result === null && originalStatus?.status === 'queued')
    || row.result === 'ran' || row.result === 'resumed'
    || (row.result?.status === 'resumed'
      && !Array.isArray(row.result.findings) && !row.result.provider && !row.result.model);
}

/** One evidenced failed execution or non-policy skip may retry. `ran` is the historical failure encoding;
 * new writers use `failed`. Failures require one failed seat; skips require zero seats. Both spend one retry.
 */
export function failedRedTeamRetry(status, proof = {}) {
  if (proof?.ok === false) return false;
  const { failedSeatCount, completedRecorded } = proof;
  const result = status?.result;
  return (status?.retryCount === undefined || status.retryCount === 0)
    && (skippedRedTeamRetry(status, { failedSeatCount, completedRecorded }) || (status?.status === 'finished' && ['failed', 'ran'].includes(typeof result === 'string' ? result : result?.status)
    && completedRecorded === false && failedSeatCount === 1
    && (result?.comment?.status ?? result?.comment) !== 'posted'));
}

/** A non-policy skip launched no seat. Retired/unknown policies never clear it; retry spends the durable budget. */
export function skippedRedTeamRetry(status, proof = {}) {
  if (proof?.ok === false) return false;
  const { failedSeatCount, completedRecorded } = proof;
  const result = status?.result;
  const read = status?.loopPayload?.findings?.read;
  return status?.status === 'finished' && (typeof result === 'string' ? result : result?.status) === 'skipped'
    && result?.policy !== 'card-only' && !result?.deferredByGuard && !result?.deferredByCap
    && (result?.comment?.status ?? result?.comment) !== 'posted'
    && completedRecorded === false && failedSeatCount === 0
    && typeof status.head === 'string' && /^[a-f0-9]{40}$/i.test(status.head)
    && read?.netBasis?.rev === status.head && redTeamReadReviewable(read)
    && redTeamOwedFor(status.loopPayload);
}
