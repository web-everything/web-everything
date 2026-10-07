/**
 * @file scripts/conveyor/health-smells/__tests__/daemon-silent.test.mjs
 * @description The PURE `evaluate()` of the `daemon-silent` smell, plus a REGRESSION replay of the live
 *   2026-09-27 false-positive: a HIGH-severity FLAPPING `daemon-silent` episode open 36h+ for
 *   `merge-orphan-sweep`, even though its pass-daemon log was actively growing every tick.
 *
 *   Root cause: `merge-orphan-sweep` now runs from its own dedicated clone (`wev-merge-daemon`, #3383's daemon
 *   split — a daemon that writes to `main` gets its own clone), so its log never appears under this watch's
 *   single `defaultLogsDir()` (pinned to `wev-review-daemon/.conveyor` in the resident health-watch's own
 *   plist). `daemons[lease.log]` is therefore always `undefined` for it, and `evaluate()` falls back to a
 *   synthetic memory built only from the lease — a fallback that hardcoded a 2-minute `intervalMs` regardless
 *   of the daemon's REAL configured cadence (`MERGE_ORPHAN_SWEEP_INTERVAL_MS` = 15 minutes,
 *   `skills-src/conveyor/daemon-manifest.mjs`). A 5x-interval, 10-minute-floor threshold built on a WRONG
 *   2-minute interval (10 min) is tighter than this daemon's perfectly normal ~11-15 minute tick gap, so it
 *   breached on every ordinary cycle — a false positive, not a real silence.
 *
 *   The fix (`health-watch.mjs#probeDaemonStatus` now carries `DAEMON_MANIFEST[log]?.intervalMs` on the
 *   lease; this file's fallback now reads `lease.intervalMs ?? 120_000` instead of a bare `120_000`) is proven
 *   below by evaluating the SAME live-shaped inputs with and without `lease.intervalMs` set — RED (old
 *   behaviour, no interval on the lease) breaches; GREEN (the fix, real interval carried) does not.
 */
import { describe, it, expect } from 'vitest';
import daemonSilent from '../daemon-silent.mjs';

const MINUTE = 60_000;
const NOW = Date.parse('2026-09-27T07:26:00Z');

/** The real live shape: pid alive, heartbeat fresh (fresh launchd job), log last grew ~11 minutes ago (the
 *  next "another drain already holds the whole-process lease" no-op line hasn't logged yet). */
function merchOrphanSweepLease({ intervalMs } = {}) {
  return {
    log: 'merge-orphan-sweep', role: 'pass-daemon', pid: 967, pidAlive: true,
    heartbeatAt: NOW - 1 * MINUTE, // fresh
    lastActivityAt: NOW - 11 * MINUTE, // last log growth
    ...(intervalMs !== undefined ? { intervalMs } : {}),
  };
}

describe('daemon-silent — regression: merge-orphan-sweep false-positive FLAPPING (2026-09-27, open 36h+)', () => {
  it('RED — without a real interval on the lease (the pre-fix shape), an ordinary ~11-minute gap on a dedicated-clone pass-daemon reads as silent', () => {
    const [r] = daemonSilent.evaluate({ leases: [merchOrphanSweepLease({ intervalMs: undefined })] }, { now: NOW, daemons: {} });
    expect(r.breach).toBe(true);
    expect(r.measure.thresholdMin).toBe(10); // the wrong, hardcoded-2-minute-derived threshold
  });

  it('GREEN — carrying the real 15-minute DAEMON_MANIFEST interval on the lease fixes the false positive', () => {
    const [r] = daemonSilent.evaluate({ leases: [merchOrphanSweepLease({ intervalMs: 15 * MINUTE })] }, { now: NOW, daemons: {} });
    expect(r.breach).toBe(false);
    expect(r.measure.thresholdMin).toBe(75); // 5 x the real 15-minute interval
    expect(r.measure.silentForMin).toBe(11);
  });

  it('a daemon with no known interval (DAEMON_MANIFEST does not cover it) keeps the old 10-minute-floor behaviour unchanged', () => {
    const [r] = daemonSilent.evaluate({ leases: [{ ...merchOrphanSweepLease({ intervalMs: null }), lastActivityAt: NOW - 25 * MINUTE }] }, { now: NOW, daemons: {} });
    expect(r.breach).toBe(true);
    expect(r.measure.thresholdMin).toBe(10);
  });
});

describe('daemon-silent — evaluate() basics', () => {
  it('reports nothing for an empty lease list', () => {
    expect(daemonSilent.evaluate({ leases: [] }, { now: NOW, daemons: {} })).toEqual([]);
  });

  it('a dead lease (pid gone) always breaches', () => {
    const [r] = daemonSilent.evaluate({ leases: [{ log: 'x', pid: 1, pidAlive: false, heartbeatAt: NOW, lastActivityAt: NOW }] }, { now: NOW, daemons: {} });
    expect(r.breach).toBe(true);
    expect(r.measure.pidAlive).toBe(false);
  });

  it('uses the PRIMARY daemons[lease.log] memory (real ticksSeen/intervalMs) when the daemonLogs probe found it, ignoring lease.intervalMs', () => {
    const daemons = { x: { ticksSeen: 10, lastTickAt: NOW - 2 * MINUTE, intervalMs: 120_000, recentTicks: [] } };
    const [r] = daemonSilent.evaluate({ leases: [{ log: 'x', pid: 1, pidAlive: true, heartbeatAt: NOW, lastActivityAt: NOW }] }, { now: NOW, daemons });
    expect(r.breach).toBe(false);
    expect(r.measure.judgedOn).toBe('last tick line');
  });
});

describe('daemon-silent — live 2026-10-07: slow ticks must not teach the watchdog to tolerate the stall', () => {
  // The fix daemon ticked 12:58, 13:03, then 13:38Z (one 35-minute tick: every gh call starved), then nothing.
  // Its heartbeat timer kept the lease fresh between blocking calls, so only the tick gap can catch it.
  const T = Date.parse('2026-10-07T14:05:00Z');
  const lease = { log: 'fix-dispatch-daemon', pid: 67216, pidAlive: true, heartbeatAt: T - 1 * MINUTE };
  const mem = {
    ticksSeen: 4, intervalMs: 30_000, lastGrowthAt: T - 2 * MINUTE, lastTickAt: Date.parse('2026-10-07T13:38:36Z'),
    recentTicks: [{ at: Date.parse('2026-10-07T13:38:36Z') }],
  };

  it('a 26-minute silence breaches at the default 30-minute ceiling (old code: 3 x 60 min observed gap = 180 min, no breach)', () => {
    const [r] = daemonSilent.evaluate({ leases: [lease] }, { now: T, daemons: { 'fix-dispatch-daemon': mem } });
    expect(r.measure.silentForMin).toBe(26);
    expect(r.measure.thresholdMin).toBeLessThanOrEqual(30);
    expect(r.breach).toBe(false); // 26 < 30: not yet...
    const [later] = daemonSilent.evaluate({ leases: [lease] }, { now: T + 5 * MINUTE, daemons: { 'fix-dispatch-daemon': mem } });
    expect(later.breach).toBe(true); // ...31 min: flagged, where old code waited until 3 h
  });

  it('the floor and the ceiling are knobs in the health config', () => {
    const config = { daemonSilentMinMs: 5 * MINUTE, daemonSilentCeilingMs: 15 * MINUTE };
    const [r] = daemonSilent.evaluate({ leases: [lease] }, { now: T, daemons: { 'fix-dispatch-daemon': mem }, config });
    expect(r.measure.thresholdMin).toBe(15);
    expect(r.breach).toBe(true);
  });
});
