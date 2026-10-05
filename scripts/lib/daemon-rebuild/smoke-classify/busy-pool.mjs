/** @file scripts/lib/daemon-rebuild/smoke-classify/busy-pool.mjs — the busy-pool classifier: which checks of a
 * PASSING smoke were skipped because the lane pool was busy (`skipReason: 'busy-pool'`). A build adopted with
 * such a skip was never live-verified on those checks. Split out of daemon-rebuild.mjs (move-only).
 */

/** Names of the checks a smoke result skipped under a busy pool (`[]` for none or a missing result). */
export function busyPoolSkippedChecks(smokeResult) {
  return (smokeResult?.smoke?.results || []).filter((r) => r.skipReason === 'busy-pool').map((r) => r.name);
}
