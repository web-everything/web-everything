/** @file scripts/lib/daemon-rebuild-early-launch.mjs — Pure trailing-edge rebuild launch policy. */
export function decideEarlyLaunch({ enabled, mainMovedAtMs, lastLaunchAtMs, jobInFlightForTarget, nowMs, debounceMs = 60_000 }) {
  const no = (reason) => ({ launch: false, reason });
  if (enabled !== true) return no('disabled');
  if (!Number.isFinite(nowMs) || !Number.isFinite(mainMovedAtMs) || mainMovedAtMs > nowMs
    || !Number.isFinite(debounceMs) || debounceMs < 0
    || (lastLaunchAtMs != null && !Number.isFinite(lastLaunchAtMs))) return no('unknown-signal');
  if (jobInFlightForTarget !== false) return no('job-in-flight-or-unknown');
  if (lastLaunchAtMs != null && lastLaunchAtMs >= mainMovedAtMs) return no('already-launched');
  if (nowMs - mainMovedAtMs < debounceMs) return no('debouncing');
  if (lastLaunchAtMs != null && nowMs - lastLaunchAtMs < debounceMs) return no('launch-spaced');
  return { launch: true, reason: 'main-moved' };
}
