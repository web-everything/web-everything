import { redTeamOwedFor } from './review-red-team-policy.mjs';
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

/** One evidenced failed execution may retry. `ran` is the historical failure encoding; new writers use
 * `failed`. Both require exactly one failed seat, no completed seat, and an unspent durable retry.
 */
export function failedRedTeamRetry(status, { failedSeatCount, completedRecorded } = {}) {
  const result = status?.result;
  return (status?.retryCount === undefined || status.retryCount === 0)
    && (skippedRedTeamRetry(status, { failedSeatCount, completedRecorded }) || (status?.status === 'finished' && ['failed', 'ran'].includes(typeof result === 'string' ? result : result?.status)
    && completedRecorded === false && failedSeatCount === 1
    && (result?.comment?.status ?? result?.comment) !== 'posted'));
}

/** A deterministic non-policy skip launched no seat. Its single fresh retry still spends the durable budget. */
export function skippedRedTeamRetry(status, { failedSeatCount, completedRecorded } = {}) {
  const result = status?.result;
  const read = status?.loopPayload?.findings?.read;
  return status?.status === 'finished' && (typeof result === 'string' ? result : result?.status) === 'skipped'
    && !result?.policy && !result?.deferredByGuard && !result?.deferredByCap
    && (result?.comment?.status ?? result?.comment) !== 'posted'
    && completedRecorded === false && failedSeatCount === 0
    && typeof status.head === 'string' && /^[a-f0-9]{40}$/i.test(status.head)
    && read?.netBasis?.rev === status.head && typeof read.diffText === 'string' && read.diffText.trim().length > 0
    && redTeamOwedFor(status.loopPayload);
}
