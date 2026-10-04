/**
 * A lane's verify marker sits at `running` for HEAD and nothing will ever settle it — so every session polling
 * `verify-lane.mjs check --wait=` on that lane loops on `wait-timeout` forever.
 *
 * Live 2026-10-04: a plain file at the pool root (`.metadata_never_index`) made every verify-daemon tick throw
 * ENOTDIR before dispatching anything. Five `request`ed markers stranded at `running`; PR #3890's fixer looped
 * 9 x 540 s waits (80+ min), each answer telling it to "re-run the same bounded check". The daemon looked alive
 * (it logged a "tick failed (non-fatal)" line every 2 min), so `daemon-silent` never fired. This smell reads the
 * consequence instead of the cause, so it catches ANY reason a verify never settles.
 *
 * Two shapes, both keyed to `sha === HEAD` (a marker for an old sha is just stale, never waited on):
 *   - never dispatched: no `runId`. The dispatcher's child stamps `runId` the moment it spawns (BEFORE heavy
 *     admission), so a `running` marker without one, older than `undispatchedMaxMs`, is a request no daemon
 *     picked up. (A foreground `verify` also writes no runId, but it runs inside one agent Bash call, ≤10 min.)
 *   - dispatched but outlived every ceiling: has `runId`, older than the dispatcher's own queue + gate ceilings
 *     (125 + 30 min) plus slack — the dispatcher should already have recorded an infrastructure-failure.
 */
import { MINUTE, fmtAge } from '../health-watch-core.mjs';

export default {
  id: 'fixer-verify-never-settles',
  scope: 'host',
  cadence: 'every-tick',
  probes: ['laneVerifyMarkers'],
  openAfter: 1,
  closeAfter: 2,
  severity: 'high',
  action: 'investigate',
  undispatchedMaxMs: 20 * MINUTE,
  dispatchedMaxMs: 170 * MINUTE,
  recommendationHint: 'A lane verify request is stuck at running and nothing will settle it; anyone waiting on it loops forever.',
  evaluate({ laneVerifyMarkers }, { now }) {
    const out = [];
    for (const m of laneVerifyMarkers || []) {
      if (!m.sha || !m.head || m.sha !== m.head) continue;
      const started = Date.parse(m.startedAt || '');
      if (!Number.isFinite(started)) continue;
      const ageMs = now - started;
      const dispatched = !!m.runId;
      const limit = dispatched ? this.dispatchedMaxMs : this.undispatchedMaxMs;
      const breach = ageMs > limit;
      const lane = `${m.pool}/lane-${m.lane}`;
      out.push({
        subject: `lane:${lane}`,
        breach,
        measure: { pool: m.pool, lane: m.lane, sha: m.sha, startedAt: m.startedAt, runId: m.runId, dispatched, ageMin: Math.round(ageMs / MINUTE), limitMin: Math.round(limit / MINUTE) },
        summary: dispatched
          ? `${lane}: verify run ${m.runId} for ${String(m.sha).slice(0, 9)} still running after ${fmtAge(ageMs)} — past every dispatcher ceiling.`
          : `${lane}: verify request for ${String(m.sha).slice(0, 9)} never dispatched after ${fmtAge(ageMs)} — any \`check --wait\` on it can only time out.`,
        recommendation: dispatched
          ? `The dispatched gate outlived its ceilings: \`ps\` for \`verify-lane.mjs --repo=…/${lane}\` and read the verify-daemon log tail; the fix is in verify-dispatch's ceiling/kill path.`
          : 'No verify daemon is dispatching: read the tail of `~/workspace/.operations/coordination/verify-daemon.log` (a repeating "tick failed" line is the usual cause) and fix that pass; the stranded request is picked up on the next good tick.',
      });
    }
    return out;
  },
};
