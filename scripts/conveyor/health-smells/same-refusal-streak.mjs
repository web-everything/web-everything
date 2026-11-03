/** Same normalized reason on the last N attempts per PR, within the shared one-hour
 * evidence window. Uses daemon memory only, not duplicate operation-record evidence.
 * Health-dir config.json: sameRefusalStreak.streakLength (integer 2–10, default 3).
 * Invalid/out-of-range overrides fall back to 3, reported with source 'default'.
 * Explicitly notifies on medium openings; persistent streaks escalate to high
 * and notify again after 30 minutes. No retries or dispatch mutations.
 */
import { MINUTE, normalizeReason } from '../health-watch-core.mjs';
import { ATTEMPT_WINDOW_MS, isExpectedPrWait } from '../health-pr-attempts.mjs';

export default {
  id: 'same-refusal-streak', scope: 'repo', cadence: 'every-tick',
  probes: ['daemonLogs'], openAfter: 1, closeAfter: 2,
  severity: 'medium', action: 'alert', notifyOnOpen: true, escalateAfterMs: 30 * MINUTE,
  evaluate({ daemonLogs } = {}, { now, daemons, config } = {}) {
    if (!daemons || typeof daemons !== 'object' || Array.isArray(daemons)
      || !Object.keys(daemons).length || !Number.isFinite(now)) {
      throw new Error('Incomplete daemon attempt evidence; inspect daemonLogs probe errors and run why-not-dispatching on the affected PR.');
    }
    const override = config?.sameRefusalStreak?.streakLength;
    const overridden = Number.isSafeInteger(override) && override >= 2 && override <= 10;
    const streakLength = overridden ? override : 3;
    const groups = new Map();
    const sampled = new Set(Array.isArray(daemonLogs) ? daemonLogs.map(s => s?.name) : []);
    for (const [name, daemon] of Object.entries(daemons)) {
      // Only an explicit empty array proves that no attempts were observed.
      const attempts = daemon?.prAttempts;
      if (!Array.isArray(attempts)) throw new Error('Invalid daemon attempt evidence; inspect daemonLogs.');
      // Remembered attempts only count as evidence while that daemon's log was actually sampled this tick.
      if (!sampled.has(name)) {
        throw new Error(`Daemon log ${name} was not sampled this tick (incomplete evidence); inspect daemonLogs and run why-not-dispatching on the affected PR.`);
      }
      for (const row of attempts) {
        if (!row || typeof row.pr !== 'string' || !row.pr || !Number.isFinite(row.at)
          || typeof row.reason !== 'string' || !normalizeReason(row.reason)) {
          throw new Error('Incomplete PR attempt evidence; inspect daemonLogs and run why-not-dispatching on the affected PR.');
        }
        if (row.at <= now - ATTEMPT_WINDOW_MS || row.at > now || isExpectedPrWait(row)) continue;
        if (!groups.has(row.pr)) groups.set(row.pr, []);
        groups.get(row.pr).push(row);
      }
    }
    return [...groups].map(([pr, attempts]) => {
      attempts.sort((a, b) => a.at - b.at);
      const tail = attempts.slice(-streakLength);
      const reason = normalizeReason(tail.at(-1).reason);
      const breach = tail.length === streakLength && tail.every(row => normalizeReason(row.reason) === reason);
      return {
        subject: pr, breach,
        measure: { streakLength, source: overridden ? 'health config' : 'default', attempts: attempts.length, reason },
        summary: `${pr}: last ${tail.length}/${streakLength} attempts ${breach ? 'share' : 'checked for'} the same normalized reason: ${reason}`,
        recommendation: `Run why-not-dispatching on ${pr} and resolve the reported blocker before retrying.`,
      };
    });
  },
};
