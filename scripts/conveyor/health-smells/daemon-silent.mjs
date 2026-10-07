/**
 * Smell (a) / #4077 — a daemon that is ALIVE (its lease is held) but has stopped ticking. 2026-09-25 10:28 ET:
 * the fix-dispatch daemon's pid stayed alive while its log and lease heartbeat went silent for 10+ minutes, and
 * nothing noticed. Subject: the daemon (its log name). Reads the lease files (`leases` probe) and the per-daemon
 * memory the core folds from the logs: a daemon that prints tick lines is judged on its last tick line, a
 * pass-daemon watcher (no tick lines) on its last log growth.
 */
import { MINUTE, fmtAge } from '../health-watch-core.mjs';

export default {
  id: 'daemon-silent',
  scope: 'host',
  cadence: 'every-tick',
  probes: ['daemonLogs', 'leases'],
  openAfter: 1,
  closeAfter: 2,
  severity: 'high',
  action: 'investigate',
  silentMinMs: 10 * MINUTE,
  silentIntervals: 5,
  // A daemon whose real cadence is slower than its configured interval (the review daemon's session reap makes
  // its ticks ~8-10 min apart) must not read as silent: the threshold also scales with the tick gap observed
  // over the last hour. A HUNG daemon is caught separately and sooner: pid alive, lease heartbeat stale (the
  // heartbeat runs on its own 30 s timer, so a stale one means the event loop itself is blocked) and no output
  // for `silentMinMs` — the 2026-09-25 10:28 ET fix-dispatch signature.
  observedGapFactor: 3,
  heartbeatStaleMs: 5 * MINUTE,
  // Ceiling on the observed-gap scaling (live 2026-10-07): when a daemon's ticks themselves slow to a crawl (the
  // fix daemon went 13:03 -> 13:38Z on one tick, every gh call starved), `observedGapFactor x gap` grew with the
  // stall and pushed the threshold to 1.5-3 h — the watchdog learned to tolerate exactly the silence it exists
  // to catch. The scaling now stops at this ceiling; the configured-interval floor still governs slow daemons.
  // Both numbers are knobs: `daemonSilentMinMs` / `daemonSilentCeilingMs` in the health config.json.
  silentCeilingMs: 30 * MINUTE,
  recommendationHint: 'A daemon holds its lease but is not ticking — read its log tail and `ps` the pid; a hung child call is the usual cause.',
  evaluate({ leases }, { now, daemons, config }) {
    const out = [];
    const minMs = Number.isFinite(config?.daemonSilentMinMs) ? config.daemonSilentMinMs : this.silentMinMs;
    const ceilingMs = Number.isFinite(config?.daemonSilentCeilingMs) ? config.daemonSilentCeilingMs : this.silentCeilingMs;
    for (const lease of leases) {
      // A daemon whose log this watch does not read (the plateau drain daemon, or — live 2026-09-27 — any
      // `pass-daemon.mjs` watcher split into its own dedicated clone, e.g. `merge-orphan-sweep` — see
      // `health-watch.mjs#probeDaemonStatus`'s own doc for the root cause this fallback used to hide) is
      // judged on daemon-status's own last-activity timestamp; one with neither is skipped. `lease.intervalMs`
      // (that daemon's REAL configured cadence, when known) replaces a hardcoded 2-minute guess here — the
      // same number the PRIMARY path already derives from `DAEMON_MANIFEST` — so a daemon on a slower cadence
      // does not read as silent on every ordinary tick gap.
      const mem = daemons[lease.log] ?? (lease.lastActivityAt != null
        ? { ticksSeen: 0, lastGrowthAt: lease.lastActivityAt, intervalMs: lease.intervalMs ?? 120_000, recentTicks: [] } : null);
      if (!mem) continue;
      const lastActivity = mem.ticksSeen > 0 && mem.lastTickAt != null ? mem.lastTickAt : mem.lastGrowthAt;
      const lastHour = (mem.recentTicks || []).filter((t) => now - t.at <= 60 * MINUTE).length;
      const observedGap = lastHour > 0 ? (60 * MINUTE) / lastHour : 0;
      const threshold = Math.max(minMs, this.silentIntervals * (mem.intervalMs || 120_000), Math.min(ceilingMs, this.observedGapFactor * observedGap));
      const silentFor = lastActivity == null ? null : now - lastActivity;
      const outputSilentFor = mem.lastGrowthAt == null ? null : now - mem.lastGrowthAt;
      const hbAge = lease.heartbeatAt ? now - lease.heartbeatAt : null;
      const hung = lease.pidAlive && hbAge != null && hbAge > this.heartbeatStaleMs && outputSilentFor != null && outputSilentFor > minMs;
      const breach = !lease.pidAlive || hung || (silentFor != null && silentFor > threshold);
      const state = !lease.pidAlive ? 'dead (lease left behind, pid gone)' : hung ? 'alive but hung (pid up, lease heartbeat stale, no output)' : 'alive but not ticking (heartbeat fresh, no tick)';
      out.push({
        subject: lease.log,
        breach,
        measure: { daemonState: lease.daemonState ?? null, hung, observedGapMin: Math.round(observedGap / MINUTE), silentForMin: silentFor == null ? null : Math.round(silentFor / MINUTE), thresholdMin: Math.round(threshold / MINUTE), pid: lease.pid, pidAlive: lease.pidAlive, heartbeatAgeMin: hbAge == null ? null : Math.round(hbAge / MINUTE), judgedOn: mem.ticksSeen > 0 ? 'last tick line' : 'last log growth', estimated: !!mem.lastTickEstimated },
        summary: `${lease.log}: no ${mem.ticksSeen > 0 ? 'tick' : 'log output'} for ${fmtAge(silentFor)} (threshold ${fmtAge(threshold)}); ${state}.`,
        recommendation: !lease.pidAlive
          ? `${lease.log} is dead but its lease is still on disk — check its launchd job (\`launchctl list | grep ${lease.log}\`); the crash reason is in the last lines of its log.`
          : `${lease.log} (pid ${lease.pid}) is ${state}. Sample its stack (\`sample ${lease.pid} 5\`) or read the log tail to find the blocking call; the product fix is a hard timeout on that call.`,
      });
    }
    return out;
  },
};
