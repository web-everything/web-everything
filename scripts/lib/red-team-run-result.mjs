/** A successful seat execution can have a failing verdict. Reuse it without another model call. */
export function completedRedTeamSeat(row) {
  return row?.status === 'ok' && (row.seatStatus === undefined || row.seatStatus === 'ok');
}

/** Review-job stores its review run as loopPayload; that alone is not a red-team run. */
export function reviewOnlyRedTeamResult(result) {
  return (result?.op === 'review-pr' || result?.loopPayload?.op === 'review-pr')
    && !Array.isArray(result.findings) && !result.provider && !result.model;
}

/** Empty completions and historical review-job strings carry no seat result or comment evidence. */
export function redTeamStatusWithoutRun(row) {
  if (row?.status !== 'finished') return false;
  return row.result === null || row.result === 'ran' || row.result === 'resumed'
    || (row.result?.status === 'resumed'
      && !Array.isArray(row.result.findings) && !row.result.provider && !row.result.model);
}
