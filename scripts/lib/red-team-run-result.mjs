/** A successful seat execution can have a failing verdict. Reuse it without another model call. */
export function completedRedTeamSeat(row) {
  return row?.status === 'ok' && (row.seatStatus === undefined || row.seatStatus === 'ok');
}

/** Review-job stores its review run as loopPayload; that alone is not a red-team run. */
export function reviewOnlyRedTeamResult(result) {
  return (result?.op === 'review-pr' || result?.loopPayload?.op === 'review-pr')
    && !Array.isArray(result.findings) && !result.provider && !result.model;
}

/** Abandoned stale runs require an explicit opt-in from marker-checked stale recovery. Null completions
 * require the original queued record from confirmed-dead recovery.
 * Without that provenance, a null result may conceal a run whose seat evidence was lost.
 */
export function redTeamStatusWithoutRun(row, { originalStatus, allowAbandonedRunning = false } = {}) {
  // The durable retry spend survives missing seat rows and legacy placeholder results.
  if (row?.retryCount !== undefined && row.retryCount !== 0) return false;
  if (row?.status === 'running' && row.result == null) {
    if (allowAbandonedRunning !== true) return false;
    const abandoned = row.staleAbandoned;
    return abandoned != null && typeof abandoned === 'object' && !Array.isArray(abandoned)
      && Number.isFinite(typeof abandoned.at === 'string' ? Date.parse(abandoned.at) : abandoned.at)
      && Number.isInteger(abandoned.pid) && abandoned.pid === row.pid;
  }
  if (row?.status !== 'finished') return false;
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
    && status?.status === 'finished' && ['failed', 'ran'].includes(typeof result === 'string' ? result : result?.status)
    && completedRecorded === false && failedSeatCount === 1
    && (result?.comment?.status ?? result?.comment) !== 'posted';
}
