/** Pure, fail-closed plan for a pending red-team head. No publication without a finished ran result. */
export function planPendingRedTeam(input) {
  const wait = reason => ({ kind: 'wait', reason });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return wait('unreadable evidence');
  const { ageMinutes, status, ownerAlive = null, restarts = 0, minutesSinceLastRestart = null,
    thresholdMinutes = 60, maxRestarts = 2, staleRunMinutes = 120, now = Date.now() } = input;
  const duration = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!duration(ageMinutes) || !duration(thresholdMinutes) || !duration(staleRunMinutes)
    || !Number.isSafeInteger(maxRestarts) || maxRestarts < 0 || !Number.isSafeInteger(restarts) || restarts < 0
    || ![true, false, null].includes(ownerAlive) || (restarts > 0 && !duration(minutesSinceLastRestart))) return wait('unreadable timing or restart evidence');
  if (status !== null && (!status || typeof status !== 'object' || Array.isArray(status)
    || status.unreadable || !['queued', 'running', 'finished', 'failed', 'skipped'].includes(status.status))) return wait('unreadable status');
  if (ageMinutes < thresholdMinutes) return wait('pending head is below the age threshold');
  if (status?.status === 'finished' && status.result && typeof status.result === 'object'
    && !Array.isArray(status.result) && status.result.status === 'ran') return { kind: 'publish-result', reason: 'finished red-team ran result awaits publication' };
  if (['queued', 'running'].includes(status?.status)) {
    if (ownerAlive === true) return wait('red-team owner is alive');
    if (ownerAlive === null) {
      const started = [status.pidStart, status.startedAt, status.createdAt]
        .map(value => typeof value === 'string' && value.trim() ? Date.parse(value) : NaN)
        .find(Number.isFinite);
      if (!Number.isFinite(now) || started === undefined || started > now) return wait('red-team run age is unreadable; operator must inspect the pending head');
      const runAgeMinutes = (now - started) / 60_000;
      if (runAgeMinutes < staleRunMinutes) return wait('red-team owner is unknown before stale deadline');
      return { kind: 'owner-unknown', reason: `red-team run age is ${runAgeMinutes} minutes; ownership could not be proven; operator must inspect the pending head (needs-you)` };
    }
  }
  if (maxRestarts === 0) return { kind: 'exhausted', reason: 'red-team restarts disabled by maxRedTeamRestartsPerHead=0; operator must inspect the pending head' };
  if (restarts >= maxRestarts) return { kind: 'exhausted', reason: `${restarts} red-team restarts exhausted at age ${ageMinutes} minutes; operator must inspect the pending head` };
  if (restarts > 0 && minutesSinceLastRestart < thresholdMinutes) return wait('last red-team restart is too recent');
  return { kind: 'restart', reason: `pending red-team head is ${ageMinutes} minutes old without a live owner or finished result; restart ${restarts + 1}` };
}
