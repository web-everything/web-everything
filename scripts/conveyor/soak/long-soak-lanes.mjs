/**
 * @file long-soak-lanes.mjs — lane pool size for the long soak (`run.mjs#runLongSoak`). Kept in its own leaf so a
 * unit test can read it without loading the break registry.
 *
 * The soak's own sessions strand lanes — a crashed, hung or failed session never releases the lane it acquired,
 * and the pool only gets it back on a wall-clock reclaim — while a new PR opens every 3 rounds and each
 * review/fix/ci-heal session holds a lane for several ticks. With the 4-lane default the pool could run dry for a
 * few ticks, and then WHICH owed PR starved depended on how fast the host ran. Main went red 2026-11-18 (first red
 * commit 325a7f76f) twice on one commit: `review` deferredForLanes=1 left PR #10 unreviewed behind a higher-ranked
 * `review:human` advisory, and (reproduced locally) `fix-dispatch` refused PR #11 `no-lane`; both passed on a
 * re-run. That is a pool-sizing artefact of the harness, not a daemon fault, so the soak provisions headroom and
 * the `owed` invariant keeps judging dispatch.
 */
export const LONG_SOAK_LANES = 8;
