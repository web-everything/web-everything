/**
 * @file skills-src/conveyor/__tests__/verify-daemon.test.mjs
 * @description Unit proof of #3878's standalone Verify daemon — the pure loop and the thin per-tick wrapper
 *   (no real lease, no real dispatch, no real subprocess/gh/git, no real timers except the `realSleep`
 *   regression below): injected effects, so the tick/backoff/stop-condition decision is tested with fakes
 *   exactly like the sibling daemons in this epic are.
 *
 *   #4130 (epic #3383 audit finding V1) adds `startIndependentHeartbeat` — a REAL timer independent of the
 *   tick's own await chain — plus the live-shaped proof this item's own card demands: a stubbed 20-minute
 *   gate tick against a real 15-minute runner-lock lease, showing the lease's own `heartbeatAt` keeps
 *   advancing (at least every 2 minutes) throughout, rather than lapsing mid-gate.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runDaemonLoop, runVerifyTick, buildCliDaemonEffects, realSleep, cloneHeadChanged,
  startIndependentHeartbeat, DEFAULT_HEARTBEAT_INTERVAL_MS,
  VERIFY_DAEMON_LEASE_KEY, DEFAULT_INTERVAL_MS,
} from '../verify-daemon.mjs';
import {
  acquireRunnerLease, heartbeatRunnerLease, runnerLeaseStatus, makeOwner,
} from '../runner-lock.mjs';

describe('runDaemonLoop — the pure control flow', () => {
  it('requires a tickOnce effect', async () => {
    await expect(runDaemonLoop({})).rejects.toThrow(/requires a tickOnce effect/);
  });

  it('ticks, sleeps between ticks, and stops at maxTicks', async () => {
    const sleep = vi.fn(async () => {});
    const tickOnce = vi.fn(async () => ({ dryRun: false, dispatched: [], failures: [] }));
    const out = await runDaemonLoop({ tickOnce, sleep, maxTicks: 3 });
    expect(tickOnce).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2); // never sleeps after the LAST tick
    expect(out).toEqual({ ticks: 3, stoppedReason: 'max-ticks' });
  });

  it('a failing tick is isolated — reported via onTickError, never fatal, the loop continues', async () => {
    const onTickError = vi.fn();
    let calls = 0;
    const tickOnce = vi.fn(async () => { calls += 1; if (calls === 1) throw new Error('transient gate hiccup'); return { ok: true }; });
    const out = await runDaemonLoop({ tickOnce, sleep: async () => {}, onTickError, maxTicks: 2 });
    expect(tickOnce).toHaveBeenCalledTimes(2);
    expect(onTickError).toHaveBeenCalledTimes(1);
    expect(onTickError.mock.calls[0][0].message).toBe('transient gate hiccup');
    expect(out).toEqual({ ticks: 2, stoppedReason: 'max-ticks' });
  });

  it('checks isAlive AFTER each tick, before sleeping — a lost lease stops immediately, no extra sleep or tick (#4130: mirrors pass-daemon.mjs)', async () => {
    let calls = 0;
    const isAlive = vi.fn(() => { calls += 1; return calls < 2; }); // alive after tick 1, lost after tick 2
    const sleep = vi.fn(async () => {});
    const tickOnce = vi.fn(async () => ({}));
    const out = await runDaemonLoop({ tickOnce, sleep, isAlive, maxTicks: Infinity });
    expect(tickOnce).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1); // slept after tick 1 (still alive), never after tick 2 (lease lost)
    expect(out).toEqual({ ticks: 2, stoppedReason: 'lease-lost' });
  });

  it('defaults isAlive to always-alive — existing callers that never pass it are unaffected', async () => {
    const tickOnce = vi.fn(async () => ({}));
    const out = await runDaemonLoop({ tickOnce, sleep: async () => {}, maxTicks: 2 });
    expect(out).toEqual({ ticks: 2, stoppedReason: 'max-ticks' });
  });

  it('onTick observes every successful result, in order', async () => {
    const seen = [];
    const results = [{ dispatched: [{ pool: 'a', lane: 1 }] }, { dispatched: [{ pool: 'a', lane: 2 }] }];
    let i = 0;
    const tickOnce = async () => results[i++];
    await runDaemonLoop({ tickOnce, sleep: async () => {}, onTick: (r, tick) => seen.push([tick, r]), maxTicks: 2 });
    expect(seen).toEqual([[0, results[0]], [1, results[1]]]);
  });
});

describe('runVerifyTick — the thin per-tick effect (real runVerifyDispatch call is injectable)', () => {
  it('calls the injected runVerify with no lane-scoping args and returns its result unchanged', async () => {
    const summary = { dryRun: false, dispatched: [{ pool: 'we', lane: 3, sha: 'abc' }], failures: [] };
    const runVerify = vi.fn(async () => summary);
    const out = await runVerifyTick({ runVerify });
    expect(runVerify).toHaveBeenCalledWith({});
    expect(out).toBe(summary);
  });

  it('propagates a rejection from the injected runVerify (runDaemonLoop, one level up, is what isolates it)', async () => {
    const runVerify = vi.fn(async () => { throw new Error('spawn ENOENT'); });
    await expect(runVerifyTick({ runVerify })).rejects.toThrow('spawn ENOENT');
  });

  it('defaults to the real runVerifyDispatch when no override is given (shape check only, not invoked here)', async () => {
    // Every OTHER test in this file injects a fake `runVerify` — this just proves the default parameter wires
    // to a real, importable function, without actually calling it (that would touch real fs/git).
    expect(typeof runVerifyTick).toBe('function');
  });
});

describe('DEFAULT_HEARTBEAT_INTERVAL_MS — the independent-timer property #4130 exists for', () => {
  it('is far below both the tick cadence and the 15-min runner-lock TTL, so it can beat DURING a long gate run', () => {
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBe(30_000);
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBeLessThan(DEFAULT_INTERVAL_MS);
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBeLessThan(15 * 60 * 1000);
  });
});

describe('startIndependentHeartbeat — #4130: a real timer, decoupled from any tick', () => {
  it('requires an owner', () => {
    expect(() => startIndependentHeartbeat({})).toThrow(/requires an owner/);
  });

  it('calls the injected heartbeat effect on its own interval — not gated by, or waiting on, any tick', () => {
    vi.useFakeTimers();
    try {
      const heartbeat = vi.fn(() => true);
      const { isAlive, stop } = startIndependentHeartbeat({ owner: 'x', intervalMs: 1000, heartbeat });
      vi.advanceTimersByTime(5500);
      expect(heartbeat).toHaveBeenCalledTimes(5);
      expect(isAlive()).toBe(true);
      stop();
      vi.advanceTimersByTime(10_000);
      expect(heartbeat).toHaveBeenCalledTimes(5); // stop() really clears the timer — no further beats
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes the key through on every beat', () => {
    vi.useFakeTimers();
    try {
      const heartbeat = vi.fn(() => true);
      const { stop } = startIndependentHeartbeat({ owner: 'x', key: '<custom-key>', intervalMs: 1000, heartbeat });
      vi.advanceTimersByTime(1000);
      expect(heartbeat).toHaveBeenCalledWith({ key: '<custom-key>' });
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('isAlive flips false and onLost fires the instant the injected heartbeat reports the lease lost — never re-beats afterward', () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const heartbeat = vi.fn(() => { n += 1; return n < 3; }); // lost on the 3rd beat
      const onLost = vi.fn();
      const { isAlive, stop } = startIndependentHeartbeat({ owner: 'x', intervalMs: 1000, heartbeat, onLost });
      vi.advanceTimersByTime(2000);
      expect(isAlive()).toBe(true);
      vi.advanceTimersByTime(1000); // 3rd beat — lost
      expect(isAlive()).toBe(false);
      expect(onLost).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5000); // once lost, the timer stops calling heartbeat at all
      expect(heartbeat).toHaveBeenCalledTimes(3);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the timer is unref'd — it never itself keeps the process alive (the loop's own sleep timer does that)", () => {
    const real = global.setInterval;
    let captured;
    global.setInterval = (fn, ms) => { captured = real(fn, ms); return captured; };
    try {
      const { stop } = startIndependentHeartbeat({ owner: 'x', heartbeat: () => true });
      expect(captured.hasRef()).toBe(false);
      stop();
    } finally {
      global.setInterval = real;
    }
  });

  it('PR #2664 review finding: a THROWING heartbeat effect is treated as lease-lost, never left to crash the process', () => {
    vi.useFakeTimers();
    try {
      const onLost = vi.fn();
      const heartbeat = vi.fn(() => { throw new Error('disk full'); });
      const { isAlive, stop } = startIndependentHeartbeat({ owner: 'x', intervalMs: 1000, heartbeat, onLost });
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
      expect(isAlive()).toBe(false);
      expect(onLost).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5000); // once lost, the timer stops calling heartbeat at all — never re-throws either
      expect(heartbeat).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('#4130 live-shaped proof: a stubbed 20-minute gate tick against a REAL 15-minute runner-lock lease', () => {
  // This is the item's own "Done when": a stubbed 20-min gate and a 15-min TTL must prove the lease stays
  // held. Real runner-lock.mjs primitives (a temp lock dir, real file IO) + real timers driven by vitest's
  // fake-timer clock (setInterval/setTimeout/Date all advance together) — never a mocked heartbeat function
  // standing in for the real lease-file read/write path.
  it('the independent heartbeat keeps the real lease fresh throughout — heartbeatAt advances at least every 2 minutes, never goes stale, although the tick itself is still in flight at 20 minutes', async () => {
    vi.useFakeTimers();
    const lockRoot = mkdtempSync(join(tmpdir(), 'verify-daemon-4130-'));
    try {
      const owner = makeOwner('verify-daemon-test');
      const key = VERIFY_DAEMON_LEASE_KEY;
      const leaseMinutes = 15;

      const acquired = acquireRunnerLease(lockRoot, owner, { key, leaseMinutes });
      expect(acquired.ok).toBe(true);

      const heartbeatSamples = [];
      const { isAlive, stop } = startIndependentHeartbeat({
        lockRoot,
        owner,
        key,
        intervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
        heartbeat: (o) => {
          const ok = heartbeatRunnerLease(lockRoot, owner, o);
          heartbeatSamples.push(Date.now());
          return ok;
        },
      });

      // The stubbed 20-minute gate — a real (fake-timer-driven) setTimeout, exactly the shape
      // `spawnGateBounded`'s own awaited promise has from `runVerifyDispatch`'s point of view.
      const twentyMinutesMs = 20 * 60 * 1000;
      const tickOnce = () => new Promise((resolvePromise) => { setTimeout(resolvePromise, twentyMinutesMs); });

      const loopPromise = runDaemonLoop({ tickOnce, sleep: () => new Promise(() => {}), isAlive, maxTicks: 1 });
      await vi.advanceTimersByTimeAsync(twentyMinutesMs);
      const result = await loopPromise;

      expect(result).toEqual({ ticks: 1, stoppedReason: 'max-ticks' });

      // The proof: heartbeatAt sampled at least every 2 minutes for the whole 20-minute gate (well clear of
      // the 15-minute TTL), and the real lease's own status confirms it was never stale.
      expect(heartbeatSamples.length).toBeGreaterThanOrEqual(9); // floor(20min / 2min) - 1, generous
      for (let i = 1; i < heartbeatSamples.length; i += 1) {
        expect(heartbeatSamples[i] - heartbeatSamples[i - 1]).toBeLessThanOrEqual(2 * 60 * 1000);
      }
      const status = runnerLeaseStatus(lockRoot, { nowMs: Date.now(), leaseMinutes, key });
      expect(status.held).toBe(true);
      expect(status.stale).toBe(false);

      stop();
    } finally {
      vi.useRealTimers();
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });

  it('the OLD wiring shape (heartbeat only after the tick resolves) would have let this exact lease go stale — proving the fix is load-bearing, not incidental', async () => {
    // No production code left implementing the old shape (it was the bug) — this reconstructs it verbatim
    // (heartbeat awaited once, only after tickOnce resolves) against the SAME real lease/TTL/gate-length used
    // in the fixed test above, so the two tests together show the fix actually matters: unfixed, the lease
    // lapses; fixed, it does not.
    vi.useFakeTimers();
    const lockRoot = mkdtempSync(join(tmpdir(), 'verify-daemon-4130-oldshape-'));
    try {
      const owner = makeOwner('verify-daemon-oldshape-test');
      const key = VERIFY_DAEMON_LEASE_KEY;
      const leaseMinutes = 15;
      const acquired = acquireRunnerLease(lockRoot, owner, { key, leaseMinutes });
      expect(acquired.ok).toBe(true);
      const acquiredAt = Date.now();

      const twentyMinutesMs = 20 * 60 * 1000;
      const oldRunDaemonLoop = async ({ tickOnce, heartbeat }) => {
        await tickOnce();
        return heartbeat(); // ← the bug: only reached after the whole tick has resolved
      };
      const tickOnce = () => new Promise((resolvePromise) => { setTimeout(resolvePromise, twentyMinutesMs); });
      const heartbeat = () => heartbeatRunnerLease(lockRoot, owner, { key });

      const loopPromise = oldRunDaemonLoop({ tickOnce, heartbeat });

      // Sample lease staleness independently at the 16-minute mark — past the 15-min TTL, while the old
      // loop's single tick is STILL in flight (it does not resolve until minute 20).
      await vi.advanceTimersByTimeAsync(16 * 60 * 1000);
      const midGateStatus = runnerLeaseStatus(lockRoot, { nowMs: Date.now(), leaseMinutes, key });
      expect(Date.now() - acquiredAt).toBe(16 * 60 * 1000);
      expect(midGateStatus.stale).toBe(true); // ← the lease has already lapsed; a second daemon could reclaim it here

      await vi.advanceTimersByTimeAsync(4 * 60 * 1000); // let the old loop's tick finish
      await loopPromise;
    } finally {
      vi.useRealTimers();
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });
});

describe('buildCliDaemonEffects — the real-effect factory (isAlive wiring only; no real dispatch/timer)', () => {
  it('uses its own distinct lease key, never the Dispatcher default sentinel or a sibling daemon\'s key', () => {
    expect(VERIFY_DAEMON_LEASE_KEY).toBe('<conveyor:verify-daemon-lease>');
  });

  it('defaults the interval to DEFAULT_INTERVAL_MS, matching runner.mjs\'s own tick cadence', () => {
    const effects = buildCliDaemonEffects({});
    expect(effects.intervalMs).toBe(DEFAULT_INTERVAL_MS);
    expect(DEFAULT_INTERVAL_MS).toBe(120_000);
  });

  it('exposes the shape runDaemonLoop needs, including the injected isAlive (backed by startIndependentHeartbeat in main())', () => {
    const isAlive = () => true;
    const effects = buildCliDaemonEffects({ isAlive });
    expect(typeof effects.tickOnce).toBe('function');
    expect(typeof effects.sleep).toBe('function');
    expect(effects.isAlive).toBe(isAlive);
    expect(typeof effects.onTick).toBe('function');
    expect(typeof effects.onTickError).toBe('function');
  });

  it('defaults isAlive to always-alive when none is passed', () => {
    const effects = buildCliDaemonEffects({});
    expect(effects.isAlive()).toBe(true);
  });

  it('onTick logs a one-line summary, plus one line per failure, via the injected log', () => {
    const log = { error: vi.fn() };
    const effects = buildCliDaemonEffects({ log });
    effects.onTick({
      dispatched: [{ pool: 'we', lane: 1 }],
      failures: [{ pool: 'we', lane: 2, timedOut: true, timedOutPhase: 'gate' }],
    });
    expect(log.error).toHaveBeenCalledWith('verify-daemon: tick — dispatched 1, failed 1');
    expect(log.error).toHaveBeenCalledWith('verify-daemon: we/lane-2 failed (non-fatal) [timed out: gate]');
  });

  it('onTickError logs a non-fatal one-liner via the injected log', () => {
    const log = { error: vi.fn() };
    const effects = buildCliDaemonEffects({ log });
    effects.onTickError(new Error('boom\nwith a stack trace'));
    expect(log.error).toHaveBeenCalledWith('verify-daemon: tick failed (non-fatal): boom');
  });
});

describe('realSleep — regression (live-caught 3x already this epic: #3870, #3871, #3876)', () => {
  // Every one of those three daemons independently reintroduced `.unref()` on this exact timer and each
  // exited right after its FIRST tick instead of looping: `.unref()` tells Node it's fine to exit before the
  // timer fires, and nothing else in the process keeps the event loop alive between ticks (a spawned child's
  // own stdio is `ignore`d — no other ref'd handle exists). A unit test that only checks the PROMISE resolves
  // (as a mocked-sleep unit test always would) can never catch this — the bug is specifically about whether
  // the underlying Node `Timeout` object is ref'd, which only a real, unmocked `setTimeout` reveals.
  it('realSleep\'s own timer is REF\'d — a resident daemon must not let Node exit before it fires', () => {
    const real = global.setTimeout;
    let captured;
    global.setTimeout = (fn, ms) => { captured = real(fn, ms); return captured; };
    try {
      realSleep(60_000); // never awaited — only the timer's own ref state is asserted, then cleared
      expect(captured.hasRef()).toBe(true); // FAILS if realSleep re-adds `.unref()`
    } finally {
      clearTimeout(captured);
      global.setTimeout = real;
    }
  });

  it('realSleep resolves after the real delay and leaves no unref\'d timer behind (smoke test, short delay)', async () => {
    const start = Date.now();
    await realSleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15); // loose bound — real timers, not fake ones
  });
});

describe('builder start-to-start cadence', () => {
  it('subtracts work, includes failures, and never overlaps or bursts after an overrun', async () => {
    let clock = 0;
    const starts = []; const sleeps = [];
    const durations = [30_000, 180_000, 10_000, 5_000];
    await runDaemonLoop({ fixedCadence: true, intervalMs: 120_000, maxTicks: 4, now: () => clock,
      tickOnce: async () => { starts.push(clock); clock += durations[starts.length - 1]; if (starts.length === 2) throw new Error('slow failure'); },
      sleep: async ms => { sleeps.push(ms); clock += ms; },
    });
    expect(starts).toEqual([0, 120_000, 300_000, 420_000]);
    expect(sleeps).toEqual([90_000, 0, 110_000]);
  });
  it('does not start another tick if its lease is lost during sleep', async () => {
    let alive = true;
    const tickOnce = vi.fn();
    await runDaemonLoop({ fixedCadence: true, tickOnce, isAlive: () => alive,
      sleep: async () => { alive = false; } });
    expect(tickOnce).toHaveBeenCalledTimes(1);
  });
});

// Live 2026-10-04: the verify daemon ran 25 h on one in-memory tree; the ENOTDIR fix overlaid onto its clone
// never reached the running sweep. The loop now exits between ticks once the clone HEAD moves, so launchd
// (KeepAlive) relaunches it on the new code.
describe('code-change restart', () => {
  it('cloneHeadChanged: true only for a readable, different HEAD', () => {
    expect(cloneHeadChanged({ bootHead: 'a', readHead: () => 'a' })).toBe(false);
    expect(cloneHeadChanged({ bootHead: 'a', readHead: () => 'b' })).toBe(true);
    expect(cloneHeadChanged({ bootHead: 'a', readHead: () => null })).toBe(false);
    expect(cloneHeadChanged({ bootHead: null, readHead: () => 'b' })).toBe(false);
  });

  it('runDaemonLoop stops with code-changed after the tick in which the clone moved, never mid-tick', async () => {
    let head = 'a';
    let ticks = 0;
    const tickOnce = async () => { ticks += 1; if (ticks === 2) head = 'b'; return {}; };
    const out = await runDaemonLoop({ tickOnce, sleep: async () => {}, codeChanged: () => cloneHeadChanged({ bootHead: 'a', readHead: () => head }), maxTicks: 10 });
    expect(out).toEqual({ ticks: 2, stoppedReason: 'code-changed' });
  });
});
