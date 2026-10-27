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
  return (row.result === null && originalStatus?.status === 'queued')
    || row.result === 'ran' || row.result === 'resumed'
    || (row.result?.status === 'resumed'
      && !Array.isArray(row.result.findings) && !row.result.provider && !row.result.model);
}

/** One failed execution may retry; absent counts and completed seats retain their existing guards. */
export function failedRedTeamRetry(status, { failedSeatCount, completedRecorded } = {}) {
  const result = status?.result;
  return (status?.retryCount === undefined || status.retryCount === 0)
    && status?.status === 'finished' && (typeof result === 'string' ? result : result?.status) === 'ran'
    && completedRecorded === false && failedSeatCount === 1
    && (result?.comment?.status ?? result?.comment) !== 'posted';
}

/** The job preflight and shared runner enforce the same fresh-seat history bound. */
export function freshRedTeamRefusal(status, evidence) {
  if (failedRedTeamRetry(status, evidence)) return null;
  if (status != null && !redTeamStatusWithoutRun(status)) return 'prior red-team status; not re-run';
  if (evidence.seatRecorded) return 'prior red-team seat row; not re-run';
  return null;
}
