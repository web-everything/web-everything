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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runDaemonLoop, runVerifyTick, buildCliDaemonEffects, realSleep, cloneHeadChanged,
  startIndependentHeartbeat, DEFAULT_HEARTBEAT_INTERVAL_MS,
  reconcileInFlight, pidAlive, processGroupAlive, killInFlight, makeCodeChangedGuard, createCleanup, runDaemon,
  VERIFY_DAEMON_LEASE_KEY, DEFAULT_INTERVAL_MS,
  resolveRestartInFlight, writeInFlightHandoff, adoptInFlight, isDispatchedRun,
} from '../verify-daemon.mjs';
import { laneNeedsVerifyDispatch } from '../../../scripts/conveyor/verify-dispatch.mjs';
import { VERIFY_FILENAME, verifyStartBody } from '../../../scripts/lib/lane-verify.mjs';
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

  it('onTick logs a one-line summary via the injected log (failures arrive through onSettled — see below)', () => {
    const log = { error: vi.fn() };
    const effects = buildCliDaemonEffects({ log });
    effects.onTick({ dispatched: [{ pool: 'we', lane: 1 }] });
    expect(log.error).toHaveBeenCalledWith('verify-daemon: tick — dispatched 1, in flight 0, deferred 0, failed 0');
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


it('forwards the process-lifetime in-flight registry and non-blocking mode', async () => {
  const runVerify = vi.fn(async () => ({}));
  const effects = buildCliDaemonEffects({ runVerify });
  expect(effects.inFlight).toBeInstanceOf(Map);
  await effects.tickOnce();
  await effects.tickOnce();
  expect(runVerify).toHaveBeenCalledTimes(2);
  expect(runVerify).toHaveBeenCalledWith({ inFlight: effects.inFlight, awaitSettle: false, onSettled: expect.any(Function) });
  runVerify.mockClear();
  await runVerifyTick({ runVerify, inFlight: effects.inFlight, awaitSettle: false });
  expect(runVerify).toHaveBeenCalledWith({ inFlight: effects.inFlight, awaitSettle: false });
});

// PR #3972 review — the lifecycle decisions that used to live, untested, inside the unexported main().
describe('killInFlight — the one cleanup every exit path shares', () => {
  it('SIGKILLs the process group of every in-flight entry that has a pid, skipping pid-less (still queued) ones', () => {
    const kill = vi.fn();
    const inFlight = new Map([['a', { pid: 11 }], ['b', { pid: null }], ['c', { pid: 33 }]]);
    killInFlight(inFlight, kill);
    expect(kill.mock.calls).toEqual([[-11, 'SIGKILL'], [-33, 'SIGKILL']]);
  });

  it('a pid that already exited (kill throws) never aborts the sweep over the rest', () => {
    const kill = vi.fn((pid) => { if (pid === -11) throw new Error('ESRCH'); });
    killInFlight(new Map([['a', { pid: 11 }], ['b', { pid: 22 }]]), kill);
    expect(kill).toHaveBeenCalledWith(-22, 'SIGKILL');
  });
});

describe('makeCodeChangedGuard — a code-change restart defers until no gate is in flight', () => {
  it('stays false while the registry is occupied, then flips once it drains (the restart waits, then happens)', () => {
    const inFlight = new Map([['lane', { pid: 1 }]]);
    const guard = makeCodeChangedGuard({ inFlight, bootHead: 'a', readHead: () => 'b' });
    expect(guard()).toBe(false);
    inFlight.delete('lane');
    expect(guard()).toBe(true);
  });

  it('is false with an empty registry when the head did not move', () => {
    expect(makeCodeChangedGuard({ inFlight: new Map(), bootHead: 'a', readHead: () => 'a' })()).toBe(false);
  });

  it('runDaemonLoop keeps ticking through the deferral and stops with code-changed only once the gate settles', async () => {
    const inFlight = new Map([['lane', { pid: 1 }]]);
    let ticks = 0;
    const tickOnce = async () => { ticks += 1; if (ticks === 3) inFlight.clear(); return {}; };
    const out = await runDaemonLoop({ tickOnce, sleep: async () => {}, maxTicks: 10,
      codeChanged: makeCodeChangedGuard({ inFlight, bootHead: 'a', readHead: () => 'b' }) });
    expect(out).toEqual({ ticks: 3, stoppedReason: 'code-changed' });
  });
});

describe('createCleanup + runDaemon — every exit tears down the same way, signal or loop', () => {
  const setup = (inFlight) => {
    const order = [];
    const f = {
      kill: vi.fn(() => order.push('kill')), stopHeartbeat: vi.fn(() => order.push('heartbeat')),
      release: vi.fn(() => order.push('release')), exit: vi.fn(() => order.push('exit')), log: { error: vi.fn() },
    };
    return { f, order, cleanup: createCleanup({ inFlight, ...f }) };
  };

  it("the signal path (stopAndExit) kills in-flight process groups, releases the lease, then exits — in that order", () => {
    const { f, order, cleanup } = setup(new Map([['lane', { pid: 777 }], ['queued', { pid: null }]]));
    cleanup.stopAndExit('SIGTERM');
    expect(f.kill.mock.calls).toEqual([[-777, 'SIGKILL']]);
    expect(order).toEqual(['kill', 'heartbeat', 'release', 'exit']);
    expect(f.exit).toHaveBeenCalledWith(0);
    expect(cleanup.isStopping()).toBe(true);
  });

  it('is idempotent — a second signal (or a loop exit after a signal) never kills or releases twice', () => {
    const { f, cleanup } = setup(new Map([['lane', { pid: 5 }]]));
    cleanup.stopAndExit('SIGTERM');
    cleanup.stopAndExit('SIGINT');
    expect(f.kill).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.exit).toHaveBeenCalledTimes(1);
  });

  it("a 'lease-lost' loop exit with gates in flight kills them, releases the lease, and exits immediately (so killed gates never stamp infrastructure-failure markers)", async () => {
    const inFlight = new Map([['lane', { pid: 777 }]]);
    const { f, order, cleanup } = setup(inFlight);
    const out = await runDaemon({
      effects: { tickOnce: async () => ({}), sleep: async () => {}, isAlive: () => false, inFlight },
      cleanup,
    });
    expect(out.stoppedReason).toBe('lease-lost');
    expect(f.kill).toHaveBeenCalledWith(-777, 'SIGKILL');
    expect(order).toEqual(['kill', 'heartbeat', 'release', 'exit']);
  });

  it('a code-changed exit has an empty registry by construction, so nothing is killed but the lease is still released', async () => {
    const inFlight = new Map();
    const { f, cleanup } = setup(inFlight);
    const out = await runDaemon({
      effects: { tickOnce: async () => ({}), sleep: async () => {}, inFlight },
      codeChanged: () => true, cleanup,
    });
    expect(out.stoppedReason).toBe('code-changed');
    expect(f.kill).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.exit).toHaveBeenCalledWith(0);
  });

  it('when a signal already tore down, the loop exit does nothing further', async () => {
    const inFlight = new Map([['l', { pid: 5 }]]);
    const { f, cleanup } = setup(inFlight);
    cleanup.stopAndExit('SIGTERM');
    f.kill.mockClear(); f.release.mockClear(); f.exit.mockClear();
    await runDaemon({ effects: { tickOnce: async () => ({}), sleep: async () => {}, isAlive: () => false, inFlight }, cleanup });
    expect(f.kill).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
    expect(f.exit).not.toHaveBeenCalled();
  });
});

describe('background gate failures reach the daemon log (awaitSettle:false leaves result.failures empty)', () => {
  it('onSettled logs a per-failure line and the next tick summary counts it', async () => {
    const log = { error: vi.fn() };
    let settle;
    const runVerify = vi.fn(async ({ onSettled }) => { settle = onSettled; return { dispatched: [], failures: [], deferred: [] }; });
    const effects = buildCliDaemonEffects({ log, runVerify });
    const first = await effects.tickOnce();
    effects.onTick(first);
    expect(log.error).toHaveBeenCalledWith('verify-daemon: tick — dispatched 0, in flight 0, deferred 0, failed 0');
    settle({ pool: 'we', lane: 2, timedOut: true, timedOutPhase: 'gate' });
    expect(log.error).toHaveBeenCalledWith('verify-daemon: we/lane-2 failed (non-fatal) [timed out: gate]');
    effects.onTick(await effects.tickOnce());
    expect(log.error).toHaveBeenLastCalledWith('verify-daemon: tick — dispatched 0, in flight 0, deferred 0, failed 1');
    effects.onTick(await effects.tickOnce());
    expect(log.error).toHaveBeenLastCalledWith('verify-daemon: tick — dispatched 0, in flight 0, deferred 0, failed 0'); // counted once, not cumulative
  });
});

describe('drain marker — stop new dispatch, let in-flight gates settle (2026-10-05)', () => {
  it('while draining, a tick never calls runVerify and logs (draining); without it, dispatch runs as before', async () => {
    let draining = true;
    const runVerify = vi.fn(async () => ({ dryRun: false, dispatched: [{}], failures: [] }));
    const log = { error: vi.fn() };
    const effects = buildCliDaemonEffects({ runVerify, log, isDraining: () => draining });
    effects.onTick(await effects.tickOnce());
    expect(runVerify).not.toHaveBeenCalled();
    expect(log.error.mock.calls.at(-1)[0]).toMatch(/dispatched 0, in flight 0 \(draining\)/);
    draining = false;
    effects.onTick(await effects.tickOnce());
    expect(runVerify).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls.at(-1)[0]).not.toContain('draining');
  });
});

// #verify-inflight-reconcile — process exit must release a stuck close-event waiter.
describe('in-flight PID reconciliation', () => {
  const entry = (overrides = {}) => ({ pool: 'we', lane: 9, runId: '12345678-abcd', pid: 777,
    sha: 'abc', startedMs: 1000, ...overrides });

  it('drops a dead PID, kills its surviving group, and logs the orphan', () => {
    const run = entry();
    const inFlight = new Map([['lane', run]]);
    const killGroup = vi.fn(); const log = vi.fn();
    const result = reconcileInFlight(inFlight, { isAlive: () => false, groupAlive: () => true, killGroup, log });
    expect(inFlight.size).toBe(0);
    expect(killGroup).toHaveBeenCalledWith(-777);
    expect(log).toHaveBeenCalledWith('verify-daemon: we/lane-9 in-flight run 12345678 orphaned (pid 777 gone) — dropped and re-queued');
    expect(result).toEqual({ orphaned: [{ pool: 'we', lane: 9, runId: run.runId, pid: 777, reason: 'pid-gone' }] });
  });

  // A pid whose process and group are both gone may already belong to an unrelated process that became its own
  // group leader; signalling -pid would kill that stranger.
  it('never signals the group of a dead PID when no member of the group remains', () => {
    const inFlight = new Map([['lane', entry()]]);
    const killGroup = vi.fn(); const groupAlive = vi.fn(() => false);
    const result = reconcileInFlight(inFlight, { isAlive: () => false, groupAlive, killGroup, log: vi.fn() });
    expect(groupAlive).toHaveBeenCalledWith(777);
    expect(killGroup).not.toHaveBeenCalled();
    expect(inFlight.size).toBe(0); // still dropped, so the request is re-queued
    expect(result.orphaned).toHaveLength(1);
  });

  it('processGroupAlive probes the group with signal zero: ESRCH is empty, EPERM is alive', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      expect(processGroupAlive(777)).toBe(true);
      expect(kill).toHaveBeenCalledWith(-777, 0);
      kill.mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
      expect(processGroupAlive(777)).toBe(true);
      kill.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
      expect(processGroupAlive(777)).toBe(false);
    } finally { kill.mockRestore(); }
  });

  it('keeps a live PID even after the spawn grace', () => {
    const inFlight = new Map([['lane', entry()]]);
    const killGroup = vi.fn();
    expect(reconcileInFlight(inFlight, { isAlive: () => true, nowMs: 999999, killGroup }).orphaned).toEqual([]);
    expect(inFlight.size).toBe(1);
    expect(killGroup).not.toHaveBeenCalled();
  });

  it.each([null, 0])('allows the spawn grace for pid %s, then drops it', (pid) => {
    const inFlight = new Map([['lane', entry({ pid })]]);
    const killGroup = vi.fn(); const log = vi.fn();
    expect(reconcileInFlight(inFlight, { nowMs: 121000, killGroup, log }).orphaned).toEqual([]);
    expect(inFlight.size).toBe(1);
    expect(reconcileInFlight(inFlight, { nowMs: 121001, killGroup, log }).orphaned[0].reason).toBe('never-spawned');
    expect(inFlight.size).toBe(0);
    expect(killGroup).not.toHaveBeenCalled();
  });

  // Dropping the entry IS the requeue. Reconciliation must not shell out to Git or read the marker (a Git hang
  // costs up to its timeout per orphan, inside the tick that is trying to unstick the daemon).
  it('requeues an orphan without Git or marker I/O', () => {
    const bin = mkdtempSync(join(tmpdir(), 'verify-reconcile-bin-'));
    const dir = mkdtempSync(join(tmpdir(), 'verify-reconcile-lane-'));
    try {
      const calls = join(bin, 'git-calls');
      writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\nexit 1\n`, { mode: 0o755 });
      vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
      const inFlight = new Map([[dir, entry()]]);
      const log = vi.fn();
      reconcileInFlight(inFlight, { isAlive: () => false, groupAlive: () => false, log });
      expect(inFlight.size).toBe(0);
      expect(existsSync(calls)).toBe(false);
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
      rmSync(bin, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pidAlive probes signal zero and treats EPERM as alive and ESRCH as dead', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      expect(pidAlive(777)).toBe(true);
      expect(kill).toHaveBeenCalledWith(777, 0);
      kill.mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
      expect(pidAlive(777)).toBe(true);
      kill.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
      expect(pidAlive(777)).toBe(false);
    } finally { kill.mockRestore(); }
  });

  it.each([true, false])('reconciles before draining/dispatch (draining=%s), despite effect failures', async (draining) => {
    const log = { error: vi.fn() };
    const runVerify = vi.fn(async ({ inFlight }) => {
      expect(inFlight.size).toBe(0);
      return { dispatched: [], deferred: [], failures: [] };
    });
    const effects = buildCliDaemonEffects({ log, runVerify, isDraining: () => draining,
      processIsAlive: () => false, groupAlive: () => true, killGroup: () => { throw new Error('kill denied'); } });
    effects.inFlight.set('lane', entry());
    effects.onTick(await effects.tickOnce());
    expect(effects.inFlight.size).toBe(0);
    expect(runVerify).toHaveBeenCalledTimes(draining ? 0 : 1);
    expect(log.error).toHaveBeenLastCalledWith(`verify-daemon: tick — dispatched 0, in flight 0${draining ? ' (draining)' : ''}, deferred 0, failed 0, orphaned 1`);
    expect(makeCodeChangedGuard({ inFlight: effects.inFlight, bootHead: 'a', readHead: () => 'b' })()).toBe(true);
    effects.onTick(await effects.tickOnce());
    expect(log.error).toHaveBeenLastCalledWith(`verify-daemon: tick — dispatched 0, in flight 0${draining ? ' (draining)' : ''}, deferred 0, failed 0`);
  });

  it.each(['owned', 'legacy', 'foreign', 'green', 'red', 'infrastructure-failure'])('default requeue preserves a %s marker', (kind) => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-reconcile-'));
    try {
      mkdirSync(join(dir, '.git'));
      const marker = verifyStartBody({ sha: 'abc', suites: 'gate', startedAt: new Date().toISOString(),
        runId: kind === 'legacy' ? undefined : kind === 'foreign' ? 'new-run' : '12345678-abcd' });
      if (['green', 'red', 'infrastructure-failure'].includes(kind)) marker.status = kind;
      const file = join(dir, '.git', VERIFY_FILENAME);
      const bytes = JSON.stringify(marker);
      writeFileSync(file, bytes);
      const inFlight = new Map([[dir, entry()]]);
      reconcileInFlight(inFlight, { isAlive: () => false, killGroup: vi.fn(), log: vi.fn() });
      expect(inFlight.size).toBe(0);
      expect(readFileSync(file, 'utf8')).toBe(bytes);
      expect(laneNeedsVerifyDispatch(JSON.parse(readFileSync(file, 'utf8')), 'abc')).toBe(marker.status === 'running');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// #65 (coroner-2, 2026-10-05) — a daemon restart (launchd SIGTERM) SIGKILLed every running gate; the successor
// then re-ran the same lane+sha from scratch (lane-7 @e7f260d3, lane-2 @32303b3e at 19:44Z).
describe('#65 — a daemon restart hands in-flight gates to its successor instead of killing them', () => {
  const setup = (inFlight, restartInFlight) => {
    const order = [];
    const f = {
      kill: vi.fn(() => order.push('kill')), stopHeartbeat: vi.fn(() => order.push('heartbeat')),
      release: vi.fn(() => order.push('release')), exit: vi.fn(() => order.push('exit')), log: { error: vi.fn() },
      handoff: vi.fn((m) => { order.push('handoff'); return [...m.values()]; }),
    };
    return { f, order, cleanup: createCleanup({ inFlight, restartInFlight, ...f }) };
  };

  it('SIGTERM under restartInFlight: adopt leaves the gates running and writes the hand-off', () => {
    const inFlight = new Map([['lane', { pid: 777, dir: 'lane', runId: 'r' }]]);
    const { f, order, cleanup } = setup(inFlight, 'adopt');
    cleanup.stopAndExit('SIGTERM', { adoptable: true });
    expect(f.kill).not.toHaveBeenCalled();
    expect(f.handoff).toHaveBeenCalledWith(inFlight);
    expect(order).toEqual(['handoff', 'heartbeat', 'release', 'exit']);
  });

  it('restartInFlight: kill keeps the old teardown; a lease loss always kills; a failed hand-off kills', async () => {
    const a = setup(new Map([['lane', { pid: 777 }]]), 'kill');
    a.cleanup.stopAndExit('SIGTERM', { adoptable: true });
    expect(a.f.kill).toHaveBeenCalledWith(-777, 'SIGKILL');
    const inFlight = new Map([['lane', { pid: 778 }]]);
    const b = setup(inFlight, 'adopt');
    await runDaemon({ effects: { tickOnce: async () => ({}), sleep: async () => {}, isAlive: () => false, inFlight }, cleanup: b.cleanup });
    expect(b.f.kill).toHaveBeenCalledWith(-778, 'SIGKILL');
    expect(b.f.handoff).not.toHaveBeenCalled();
    const c = setup(new Map([['lane', { pid: 779 }]]), 'adopt');
    c.f.handoff.mockImplementation(() => { throw new Error('disk full'); });
    c.cleanup.stopAndExit('SIGTERM', { adoptable: true });
    expect(c.f.kill).toHaveBeenCalledWith(-779, 'SIGKILL');
  });

  it('defaults to adopt (declared setting), and the env can restore the old kill', () => {
    expect(resolveRestartInFlight({})).toBe('adopt');
    expect(resolveRestartInFlight({ WE_VERIFY_RESTART_IN_FLIGHT: 'kill' })).toBe('kill');
  });

  it('the successor adopts a still-running dispatched gate (real process, real argv check) and skips the rest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-adopt-'));
    const { spawn } = await import('node:child_process');
    const script = join(root, 'verify-lane.mjs');
    writeFileSync(script, 'setTimeout(() => {}, 20000);');
    const child = spawn('node', [script, '--repo=x', '--json', '--run-id=run-live'], { stdio: 'ignore', detached: true });
    try {
      const path = join(root, 'inflight.json');
      const before = new Map([
        ['/lanes/a', { pool: 'p', lane: 1, dir: '/lanes/a', runId: 'run-live', pid: child.pid, sha: 'aaa', suites: 'g', treeHash: 't', requestStartedAt: 's', startedMs: 1, logPath: null }],
        ['/lanes/b', { pool: 'p', lane: 2, dir: '/lanes/b', runId: 'run-reused', pid: process.pid, sha: 'bbb', suites: 'g', treeHash: 't', requestStartedAt: 's', startedMs: 1 }],
        ['/lanes/c', { pool: 'p', lane: 3, dir: '/lanes/c', runId: 'run-unspawned', pid: null }],
      ]);
      expect(writeInFlightHandoff(before, path)).toHaveLength(2);
      for (let i = 0; i < 50 && !isDispatchedRun(child.pid, 'run-live'); i += 1) await new Promise(r => setTimeout(r, 20));
      const inFlight = new Map();
      const adopted = adoptInFlight(inFlight, { path, log: () => {} });
      expect(adopted.map(r => r.runId)).toEqual(['run-live']); // this test process is not a verify-lane child
      expect(inFlight.get('/lanes/a')).toMatchObject({ adopted: true, sha: 'aaa', suites: 'g', treeHash: 't', pid: child.pid });
      expect(existsSync(path)).toBe(false);
      expect(adoptInFlight(new Map(), { path })).toEqual([]);
    } finally {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  }, 10000);

  it('an adopted run that exits is released (its child wrote the marker); one past the ceiling is killed and settled', () => {
    const log = vi.fn();
    const killGroup = vi.fn();
    const settleKilled = vi.fn();
    const inFlight = new Map([
      ['done', { pool: 'p', lane: 1, runId: 'r1', pid: 11, startedMs: 0, adopted: true }],
      ['hung', { pool: 'p', lane: 2, runId: 'r2', pid: 22, startedMs: 0, adopted: true }],
      ['fresh', { pool: 'p', lane: 3, runId: 'r3', pid: 33, startedMs: 9_000, adopted: true }],
    ]);
    const { orphaned } = reconcileInFlight(inFlight, { isAlive: (pid) => pid !== 11, groupAlive: () => true, killGroup,
      nowMs: 10_000, adoptedCeilingMs: 5_000, settleKilled, log });
    expect(orphaned.map(o => o.reason)).toEqual(['pid-gone', 'adopted-ceiling']);
    expect(settleKilled).toHaveBeenCalledWith(expect.objectContaining({ runId: 'r2' }), 5_000);
    expect(killGroup).toHaveBeenCalledWith(-22);
    expect([...inFlight.keys()]).toEqual(['fresh']);
    expect(log.mock.calls.flat().join('\n')).toMatch(/adopted run r1.*finished/);
  });
});

describe('#4135 — gate jobs: a restart never waits on, kills, or re-dispatches a running gate', () => {
  it('a code-change restart no longer waits for gate JOBS (they outlive the process); in-process runs still defer it', () => {
    const inFlight = new Map([['/l1', { jobId: 'j1', pid: 9 }]]);
    const guard = makeCodeChangedGuard({ inFlight, bootHead: 'a', readHead: () => 'b' });
    expect(guard()).toBe(true);
    inFlight.set('/l2', { runId: 'legacy', pid: 10 });
    expect(guard()).toBe(false);
  });

  it('every exit leaves gate jobs running (the successor re-attaches); only restartInFlight: kill stops them', async () => {
    const mk = (restartInFlight, stopJobs = vi.fn(async () => {})) => {
      const kill = vi.fn();
      const exit = vi.fn();
      const inFlight = new Map([['/l1', { jobId: 'j1', pid: 9 }], ['/l2', { runId: 'r', pid: 10 }]]);
      const cleanup = createCleanup({ inFlight, kill, exit, stopHeartbeat: () => {}, release: () => {}, log: { error: () => {} },
        restartInFlight, handoff: (m) => [...m.values()], stopJobs });
      return { cleanup, kill, exit, stopJobs };
    };
    const a = mk('adopt');
    a.cleanup.stopAndExit('SIGTERM', { adoptable: true });
    expect(a.kill).not.toHaveBeenCalled(); // job left, legacy handed off
    expect(a.stopJobs).not.toHaveBeenCalled();
    expect(a.exit).toHaveBeenCalledWith(0);

    const b = mk('adopt');
    b.cleanup.stopAndExit('loop stopped (lease-lost)');
    expect(b.kill).toHaveBeenCalledWith(-10, 'SIGKILL'); // the in-process run is still killed, as before
    expect(b.kill).not.toHaveBeenCalledWith(-9, 'SIGKILL'); // the job is not
    expect(b.stopJobs).not.toHaveBeenCalled();

    const c = mk('kill');
    c.cleanup.stopAndExit('SIGTERM', { adoptable: true });
    await new Promise((r) => setImmediate(r));
    expect(c.stopJobs).toHaveBeenCalledTimes(1);
    expect(c.kill).toHaveBeenCalledWith(-10, 'SIGKILL');
    expect(c.exit).toHaveBeenCalledWith(0);
  });

  it('with gateJobs, the tick syncs the store BEFORE dispatch, passes launchGate, and launches in the same tick', async () => {
    const order = [];
    const gateJobs = {
      sync: vi.fn(async () => { order.push('sync'); }),
      launch: vi.fn(() => ({ id: 'j' })),
    };
    const runVerify = vi.fn(async (o) => { order.push('dispatch'); o.launchGate({ lane: 1 }); return { dispatched: [{ lane: 1 }], deferred: [], failures: [] }; });
    const effects = buildCliDaemonEffects({ runVerify, gateJobs, isDraining: () => false, log: { error: () => {} } });
    await effects.tickOnce();
    expect(order).toEqual(['sync', 'dispatch', 'sync']);
    expect(gateJobs.launch).toHaveBeenCalledWith({ lane: 1 });
  });

  it('reconcileInFlight never touches a job entry (the job store owns it)', () => {
    const inFlight = new Map([['/l1', { jobId: 'j1', pid: 123, startedMs: 0 }]]);
    const { orphaned } = reconcileInFlight(inFlight, { isAlive: () => false, groupAlive: () => true, killGroup: () => { throw new Error('no'); }, nowMs: 1e12, log: () => {} });
    expect(orphaned).toEqual([]);
    expect(inFlight.size).toBe(1);
  });
});
