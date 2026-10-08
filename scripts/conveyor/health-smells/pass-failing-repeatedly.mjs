/**
 * pass-failing-repeatedly (xkqia1h) — ANY daemon pass (the lease reaper, a watcher, a dispatcher) that keeps failing
 * run after run. Live 2026-10-08: the lease reaper ran out of memory on EVERY pass from ~08:37Z to ~15:57Z — 92
 * crashes, nothing reaped all morning — and nothing was raised: `daemon-silent` saw a growing log (each crash
 * dumped a V8 trace into it) and a live `pass-daemon` lease, and no smell read pass outcomes at all.
 *
 * Input: the per-daemon memory the core folds from the same `daemonLogs` probe every log smell already reads —
 *   - `mem.passFailures` — one entry per `pass-daemon: <script> exited …` / `failed to spawn` line (the line
 *     `pass-daemon.mjs` writes for EVERY failed run, and only for failed runs), with the run's last error line;
 *   - `mem.recentTicks` — a dispatcher's ticks, where `f: 1` marks a whole-tick failure and any other tick is a
 *     successful pass.
 * A pass daemon logs nothing generic on success, so a failure-free stretch longer than `recoverAfterMs` (floor,
 * stretched to 4 of that daemon's pass intervals) is read as "passes succeeding again" and ends the streak.
 *
 * Breach (both knobs in the health config): `passFailingMinStreak` (N) consecutive failed passes, OR still failing
 * with no successful pass for `passFailingNoSuccessMs` (X) — the second catches a slow-cadence pass that would take
 * hours to reach N.
 */
import { MINUTE, fmtAge } from '../health-watch-core.mjs';

const num = (v, d) => (Number.isFinite(v) ? v : d);

/** PURE: the current run of consecutive failed passes for one daemon's memory, newest first. */
export function passFailureStreak(mem, { now, recoverAfterMs }) {
  const events = [
    ...(mem?.passFailures || []).map((f) => ({ at: f.at, ok: false, why: f.why })),
    ...(mem?.recentTicks || []).map((t) => ({ at: t.at, ok: !t.f, why: t.why ?? 'tick failed' })),
  ].filter((e) => Number.isFinite(e.at) && e.at <= now + MINUTE).sort((a, b) => b.at - a.at);
  let streak = 0;
  let since = null;
  let lastError = null;
  let lastFailAt = null;
  let prevAt = now;
  for (const e of events) {
    if (e.ok) break;
    if (prevAt - e.at > recoverAfterMs) break; // a quiet stretch: the passes in between succeeded
    streak += 1;
    since = e.at;
    lastFailAt = lastFailAt ?? e.at;
    lastError = lastError ?? e.why;
    prevAt = e.at;
  }
  return { streak, since, lastFailAt, lastError };
}

export default {
  id: 'pass-failing-repeatedly',
  scope: 'host',
  cadence: 'every-tick',
  probes: ['daemonLogs'],
  openAfter: 1,
  closeAfter: 2,
  severity: 'high',
  action: 'alert',
  recommendationHint: 'A daemon pass is failing run after run — its work is not being done. Read the last error line and the log tail; fix the cause in the pass itself (an OOM wants the input it loads bounded, not a bigger heap).',
  evaluate(_probes, { now, daemons, config }) {
    const minStreak = num(config?.passFailingMinStreak, 3);
    const noSuccessMs = num(config?.passFailingNoSuccessMs, 30 * MINUTE);
    const recoverFloorMs = num(config?.passFailingRecoverAfterMs, 15 * MINUTE);
    const out = [];
    for (const [name, mem] of Object.entries(daemons || {})) {
      const recoverAfterMs = Math.max(recoverFloorMs, 4 * (mem?.intervalMs || 120_000));
      const s = passFailureStreak(mem, { now, recoverAfterMs });
      const failingFor = s.since == null ? 0 : now - s.since;
      const byStreak = s.streak >= minStreak;
      const byTime = s.streak >= 1 && failingFor >= noSuccessMs;
      const breach = byStreak || byTime;
      out.push({
        subject: name,
        breach,
        measure: { streak: s.streak, failingForMin: Math.round(failingFor / MINUTE), minStreak, noSuccessMin: Math.round(noSuccessMs / MINUTE),
          trigger: byStreak ? 'streak' : byTime ? 'no-success' : null, lastError: s.lastError },
        summary: s.streak
          ? `${name}: ${s.streak} consecutive failed pass(es), no successful pass for ${fmtAge(failingFor)} — last error: ${s.lastError}`
          : `${name}: no failing pass streak.`,
        recommendation: `${name}: ${this.recommendationHint}`,
      });
    }
    return out;
  },
};
