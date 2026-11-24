/** Read-only runner report. The IO shell supplies observations; both declared steps are compute. */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';

export const RUNNER_ACTIVITY_OP = 'runner-activity';

/**
 * The three-way (four-state) health vocabulary for ONE daemon entry — `down` / `dead` / `alive-and-stalled` /
 * `alive-and-idle` — computed identically for every daemon in `runners[]`, not just the dispatcher. `lastTick`
 * is passed only for the dispatcher (the only daemon with a tick/driver-status concept of its own); the
 * fix-dispatch and review daemons are assessed on heartbeat freshness alone, since they have no tick to
 * corroborate against. A quiet daemon is not a stall — only stale heartbeat/tick evidence or the tick core's
 * own held-work diagnosis says stalled.
 * @param {{ present: boolean|null, alive: boolean, heartbeatAt: string|null, error?: string }} entry
 * @param {{ observedAt: string, staleAfterMs: number, lastTick: object|null }} ctx
 */
export function assessDaemonState(entry, { observedAt, staleAfterMs, lastTick = null }) {
  if (entry.present === null) {
    return { state: 'down', stalled: false,
      stalledReason: `This daemon's lease could not be read reliably: ${entry.error || 'unknown error'}.` };
  }
  if (!entry.present) {
    return { state: 'down', stalled: false, stalledReason: 'No singleton lease exists; no daemon is registered.' };
  }
  if (!entry.alive) {
    return { state: 'dead', stalled: false,
      stalledReason: 'The recorded PID is absent or no longer identifies this daemon process.' };
  }
  const heartbeatAge = Date.parse(observedAt) - Date.parse(entry.heartbeatAt);
  if (lastTick) {
    const tickAge = lastTick.at == null ? heartbeatAge : Date.parse(observedAt) - Date.parse(lastTick.at);
    const stale = !Number.isFinite(heartbeatAge) || !Number.isFinite(tickAge)
      || heartbeatAge > staleAfterMs || tickAge > staleAfterMs;
    const stalled = stale || lastTick.stalled.length > 0;
    const stalledReason = stale
      ? 'Daemon process exists, but its heartbeat or last tick exceeds the lease window (or is unreadable).'
      : lastTick.stalled.length
        ? `Tick reports held-work stalls: ${lastTick.stalled.map((s) => `#${s.num}: ${s.reason}`).join('; ')}`
        : lastTick.at == null
          ? 'Daemon heartbeat is fresh; no completed tick recorded yet. No stall established.'
          : 'Daemon heartbeat and tick are fresh; the tick reports no stall. Quiet work is not a stall.';
    return { state: stalled ? 'alive-and-stalled' : 'alive-and-idle', stalled, stalledReason };
  }
  const stale = !Number.isFinite(heartbeatAge) || heartbeatAge > staleAfterMs;
  return {
    state: stale ? 'alive-and-stalled' : 'alive-and-idle', stalled: stale,
    stalledReason: stale
      ? 'Daemon process exists, but its heartbeat exceeds the lease window (or is unreadable).'
      : 'Daemon heartbeat is fresh; no stall established.',
  };
}

/**
 * Assess the raw `collectRunnerActivity` snapshot: each `runners[]` entry gets its own `state`/`stalled`/
 * `stalledReason` via {@link assessDaemonState}. The top-level `state`/`stalled`/`stalledReason`/`dispatching`
 * fields mirror the `dispatcher` entry specifically (the pre-existing "driver health" vocabulary the
 * `runner-status` skill and `docs/agent/testing.d/036-runner-activity-report.md#runner-activity-report` already document) — a consumer that only cares about the
 * conveyor dispatcher, as every caller did before this operation reported on three daemons, reads exactly the
 * same top-level shape as before. A consumer that wants the fix-dispatch or review daemon's health reads
 * `runners[]` by `name`.
 */
export function assessRunnerActivity(read) {
  if (!read || !Array.isArray(read.runners) || !Array.isArray(read.inFlightDispatches) || !Array.isArray(read.completedDispatches)) {
    throw new TypeError('runner-activity: unreadable snapshot is not a down runner');
  }
  const { lastTick, observedAt, staleAfterMs } = read;
  const runners = read.runners.map((entry) => ({
    ...entry,
    ...assessDaemonState(entry, { observedAt, staleAfterMs, lastTick: entry.name === 'dispatcher' ? lastTick : null }),
  }));
  const dispatcher = runners.find((r) => r.name === 'dispatcher');
  // Dispatch activity is a separate axis from driver health, independent of any daemon's own state.
  const dispatching = read.inFlightDispatches.some((r) => r.live === true);
  return {
    ...read, runners,
    state: dispatcher?.state, stalled: dispatcher?.stalled, stalledReason: dispatcher?.stalledReason,
    dispatching,
  };
}

export function runnerActivityOperation({ readActivity } = {}) {
  if (typeof readActivity !== 'function') throw new TypeError('runner-activity needs a readActivity reader');
  return op(RUNNER_ACTIVITY_OP, {
    input: { limit: { type: 'number', required: false, default: 10 } },
    verdictFrom: 'assess',
    read: compute({
      reads: ['input.limit'],
      fn: ({ input }) => {
        if (!Number.isInteger(input.limit) || input.limit < 0 || input.limit > 1000) {
          throw new TypeError('runner-activity: limit must be an integer from 0 to 1000');
        }
        return readActivity(input);
      },
    }),
    assess: compute({ reads: ['findings.read'], fn: ({ findings }) => assessRunnerActivity(findings.read) }),
  });
}
