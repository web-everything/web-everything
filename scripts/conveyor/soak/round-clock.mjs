/**
 * @file round-clock.mjs — the long soak's virtual time per round, independent of how fast the host runs.
 *
 * The sim clock reads `realNow + offset` (`sim/clock.mjs`). The soak used to `advance('3m')` per round, so a round
 * really took 3 virtual minutes PLUS however long its two daemon ticks and sessions took on the wall clock — 570 s
 * in one CI run, 655 s in the rerun, 863 s on a loaded host. Every time-dependent decision a daemon or the lane pool
 * makes (lease TTLs, hung-session and cool-off windows) therefore flipped at a different round per run, so the same
 * seeded soak starved a different owed PR on a slow host (main red 2026-11-18, first red commit 325a7f76f: review
 * `deferredForLanes=1` left PR #10 unreviewed in CI; `fix-dispatch` `no-lane` for PR #11 on a loaded host; the CI
 * rerun of the same commit passed).
 *
 * The round now ends at a fixed virtual instant: `advanceMsForRound` takes the 3-minute budget minus the real time the
 * round already used, so round `k` ends at `start + k × 3m` on any host.
 */

/** Virtual milliseconds one soak round occupies. */
export const ROUND_VIRTUAL_MS = 3 * 60_000;

/**
 * How far to move the sim clock at the end of a round so the round occupied exactly `roundMs` of virtual time.
 * @param {number} realElapsedMs - wall-clock ms since the previous round ended (the sim clock already advanced by this).
 * @param {number} [roundMs]
 * @returns {number} ms to advance (never negative: a round slower than its budget is not rewound, it just overruns)
 */
export function advanceMsForRound(realElapsedMs, roundMs = ROUND_VIRTUAL_MS) {
  const elapsed = Number.isFinite(realElapsedMs) && realElapsedMs > 0 ? realElapsedMs : 0;
  return Math.max(0, roundMs - elapsed);
}
