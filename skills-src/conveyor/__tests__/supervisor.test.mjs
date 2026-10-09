/**
 * @file skills-src/conveyor/__tests__/supervisor.test.mjs
 * @description Unit proof of the conveyor RESIDENT SUPERVISOR ({@link ../supervisor.mjs}) — the last piece
 *   that makes the headless runner ({@link ../runner.mjs}) self-sustaining. Five subjects:
 *
 *   • the PURE classify/backoff decisions ({@link classifyExit}, {@link decideRestart}) — plain objects in,
 *     plain objects out, no clock/IO of their own;
 *   • the SUPERVISOR'S CONTROL FLOW ({@link runSupervisorLoop}) — driven with fake `spawnChild`/`sleep`/`log`
 *     effects, proving: a clean exit restarts with no backoff, a crash triggers backoff, the backoff grows on
 *     repeated crashes and resets after a healthy run, and a shutdown signal stops the loop before the next
 *     spawn (never orphaning a child the pure loop doesn't itself own);
 *   • the PURE out-of-band-alerting decisions (#3398 — {@link detectSupervisorAnomalies},
 *     {@link healthFromAnomalies}, {@link decideAlert}) — fixture spawn/exit/backoff/tick histories in, the
 *     same anomaly-row shape as the drain-daemon precedent out, no real crash-looping or stuck process needed;
 *   • the REAL SUBPROCESS WIRING ({@link makeRealSpawnChild}, {@link makeJsonlLog}) — short-lived, explicitly
 *     terminated real `node` child processes (never `runner.mjs` itself — a controllable `node -e` script
 *     stands in for it), the same reasoning `dispatch-spawn-live.test.mjs` gives for proving a real subprocess
 *     path rather than trusting a stub: the exit `code`/`signal`/`ranMs` a stub could assert are unfalsifiable
 *     claims about what `child_process.spawn` actually reports; a real process is the only thing that answers.
 *     Every process this file starts is either allowed to exit on its own within a couple hundred ms or is
 *     explicitly killed before the test ends — nothing lingers past the suite (verified in CI/manually via
 *     `ps aux | grep supervisor` — see the task report, not this file).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyExit, decideRestart, runSupervisorLoop,
  makeRealSpawnChild, makeJsonlLog,
  detectSupervisorAnomalies, healthFromAnomalies, decideAlert,
  DEFAULT_CRASH_THRESHOLD_MS, DEFAULT_BASE_BACKOFF_MS, DEFAULT_MAX_BACKOFF_MS, DEFAULT_LOG_PATH,
  DEFAULT_IDLE_BASE_BACKOFF_MS, DEFAULT_IDLE_MAX_BACKOFF_MS,
  CRASH_CEILING_WARN_COUNT, CRASH_CEILING_CRIT_COUNT, IDLE_QUEUE_WARN_TICKS, IDLE_QUEUE_CRIT_TICKS, ALERT_RENAG_MS,
} from '../supervisor.mjs';

// ── (1) classifyExit — clean vs crash, from raw exit facts alone ────────────────────────────────────────────

describe('classifyExit — clean (idle-stop / polite stand-down) vs crash', () => {
  it('a plain code:0 exit that ran a real tick-length is clean', () => {
    expect(classifyExit({ code: 0, signal: null, ranMs: 5_000 })).toEqual({ kind: 'clean', reason: 'exit:0' });
  });
  it('a non-zero exit is a crash, regardless of how long it ran', () => {
    expect(classifyExit({ code: 1, signal: null, ranMs: 60_000 })).toEqual({ kind: 'crash', reason: 'exit:1' });
  });
  it('death by signal is a crash', () => {
    expect(classifyExit({ code: null, signal: 'SIGSEGV', ranMs: 60_000 })).toEqual({ kind: 'crash', reason: 'signal:SIGSEGV' });
  });
  it('signal takes precedence over a reported code (both can be non-null on some platforms)', () => {
    expect(classifyExit({ code: 0, signal: 'SIGTERM', ranMs: 60_000 }).reason).toBe('signal:SIGTERM');
  });
  it('an implausibly fast exit is a crash EVEN at code:0 — a real tick cannot finish this fast', () => {
    expect(classifyExit({ code: 0, signal: null, ranMs: 10 })).toEqual({ kind: 'crash', reason: 'too-short' });
  });
  it('the crash-fast threshold is configurable and used as a strict lower bound', () => {
    const opts = { crashThresholdMs: 500 };
    expect(classifyExit({ code: 0, signal: null, ranMs: 499 }, opts).kind).toBe('crash');
    expect(classifyExit({ code: 0, signal: null, ranMs: 500 }, opts).kind).toBe('clean');
  });
  it('defaults the threshold to DEFAULT_CRASH_THRESHOLD_MS (3s)', () => {
    expect(DEFAULT_CRASH_THRESHOLD_MS).toBe(3_000);
    expect(classifyExit({ code: 0, ranMs: 2_999 }).kind).toBe('crash');
    expect(classifyExit({ code: 0, ranMs: 3_000 }).kind).toBe('clean');
  });

  // #3406 — `stoppedReason` (parsed off runner.mjs's own final --json line) is what tells a genuine idle-stop
  // apart from a polite stand-down; both were previously indistinguishable `{kind:'clean', reason:'exit:0'}`.
  it('a code:0 exit whose stoppedReason is "idle-stop" is classified distinctly from a plain clean exit', () => {
    expect(classifyExit({ code: 0, signal: null, ranMs: 10_000, stoppedReason: 'idle-stop' }))
      .toEqual({ kind: 'clean', reason: 'idle-stop' });
  });
  it('a code:0 exit whose stoppedReason is "stand-down" is classified distinctly too', () => {
    expect(classifyExit({ code: 0, signal: null, ranMs: 10_000, stoppedReason: 'stand-down' }))
      .toEqual({ kind: 'clean', reason: 'stand-down' });
  });
  it('an unset/unknown stoppedReason degrades to the old exit:0 reason, never a wrong classification', () => {
    expect(classifyExit({ code: 0, signal: null, ranMs: 10_000 }).reason).toBe('exit:0');
    expect(classifyExit({ code: 0, signal: null, ranMs: 10_000, stoppedReason: 'max-ticks' }).reason).toBe('exit:0');
    expect(classifyExit({ code: 0, signal: null, ranMs: 10_000, stoppedReason: 'lease-lost' }).reason).toBe('exit:0');
  });
  it('a crash still classifies as crash regardless of stoppedReason (code/signal/timing win first)', () => {
    expect(classifyExit({ code: 1, signal: null, ranMs: 10_000, stoppedReason: 'idle-stop' }).kind).toBe('crash');
  });
});

// ── (2) decideRestart — the backoff curve ────────────────────────────────────────────────────────────────────

describe('decideRestart — no delay + reset on clean, doubling backoff (capped) on crash', () => {
  it('a clean classification restarts immediately and resets the streak', () => {
    expect(decideRestart({ classification: { kind: 'clean', reason: 'exit:0' }, consecutiveCrashes: 4 }))
      .toEqual({ delayMs: 0, consecutiveCrashes: 0, consecutiveIdleStops: 0 });
  });
  it('the first crash backs off by exactly the base delay', () => {
    expect(decideRestart({ classification: { kind: 'crash', reason: 'exit:1' }, consecutiveCrashes: 0 }))
      .toEqual({ delayMs: DEFAULT_BASE_BACKOFF_MS, consecutiveCrashes: 1, consecutiveIdleStops: 0 });
  });
  it('each further consecutive crash DOUBLES the delay', () => {
    let streak = 0;
    const seen = [];
    for (let i = 0; i < 5; i++) {
      const r = decideRestart({ classification: { kind: 'crash', reason: 'exit:1' }, consecutiveCrashes: streak });
      streak = r.consecutiveCrashes;
      seen.push(r.delayMs);
    }
    expect(seen).toEqual([5_000, 10_000, 20_000, 40_000, 80_000]);
  });
  it('the delay is CAPPED at DEFAULT_MAX_BACKOFF_MS, however long the crash streak runs', () => {
    expect(DEFAULT_MAX_BACKOFF_MS).toBe(300_000);
    const r = decideRestart({ classification: { kind: 'crash', reason: 'exit:1' }, consecutiveCrashes: 20 });
    expect(r.delayMs).toBe(300_000);
    expect(r.consecutiveCrashes).toBe(21); // the streak keeps counting even once the delay itself is capped
  });
  it('custom base/max are honored', () => {
    const r = decideRestart({ classification: { kind: 'crash', reason: 'exit:1' }, consecutiveCrashes: 0 }, { baseBackoffMs: 100, maxBackoffMs: 150 });
    expect(r.delayMs).toBe(100);
    const r2 = decideRestart({ classification: { kind: 'crash', reason: 'exit:1' }, consecutiveCrashes: 1 }, { baseBackoffMs: 100, maxBackoffMs: 150 });
    expect(r2.delayMs).toBe(150); // 100*2=200 capped to 150
  });

  // #3406 — a repeated idle-stop grows its OWN streak/backoff, separate from the crash streak, so a
  // freshly-respawned runner that idle-stops again immediately (the busy-loop this card exists to fix) no
  // longer restarts with delayMs:0 every time.
  it('a "stand-down" or any other clean exit still restarts with NO delay, exactly as before', () => {
    expect(decideRestart({ classification: { kind: 'clean', reason: 'stand-down' }, consecutiveIdleStops: 3 }))
      .toEqual({ delayMs: 0, consecutiveCrashes: 0, consecutiveIdleStops: 0 });
    expect(decideRestart({ classification: { kind: 'clean', reason: 'exit:0' }, consecutiveIdleStops: 3 }))
      .toEqual({ delayMs: 0, consecutiveCrashes: 0, consecutiveIdleStops: 0 });
  });
  it('the first idle-stop backs off by exactly the idle base delay, NOT the crash base delay', () => {
    expect(DEFAULT_IDLE_BASE_BACKOFF_MS).toBe(30_000);
    expect(decideRestart({ classification: { kind: 'clean', reason: 'idle-stop' }, consecutiveIdleStops: 0 }))
      .toEqual({ delayMs: 30_000, consecutiveCrashes: 0, consecutiveIdleStops: 1 });
  });
  it('each further consecutive idle-stop DOUBLES the delay, capped at DEFAULT_IDLE_MAX_BACKOFF_MS', () => {
    expect(DEFAULT_IDLE_MAX_BACKOFF_MS).toBe(900_000);
    let streak = 0;
    const seen = [];
    for (let i = 0; i < 6; i++) {
      const r = decideRestart({ classification: { kind: 'clean', reason: 'idle-stop' }, consecutiveIdleStops: streak });
      streak = r.consecutiveIdleStops;
      seen.push(r.delayMs);
    }
    expect(seen).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 900_000]); // 960_000 would-be capped to 900_000
  });
  it('a crash resets the idle-stop streak, and an idle-stop resets the crash streak — the two never compound', () => {
    const afterCrash = decideRestart({ classification: { kind: 'crash', reason: 'exit:1' }, consecutiveCrashes: 2, consecutiveIdleStops: 5 });
    expect(afterCrash.consecutiveIdleStops).toBe(0);
    const afterIdle = decideRestart({ classification: { kind: 'clean', reason: 'idle-stop' }, consecutiveCrashes: 4, consecutiveIdleStops: 1 });
    expect(afterIdle.consecutiveCrashes).toBe(0);
  });
});

// ── (3) runSupervisorLoop — the control flow over injected effects ──────────────────────────────────────────

describe('runSupervisorLoop — spawn, classify, backoff-or-not, repeat', () => {
  it('a CLEAN exit restarts with no backoff sleep in between', async () => {
    const exits = [
      { code: 0, signal: null, ranMs: 10_000 },
      { code: 0, signal: null, ranMs: 10_000 },
    ];
    let n = 0;
    const sleeps = [];
    const res = await runSupervisorLoop({
      spawnChild: () => exits[Math.min(n++, exits.length - 1)],
      sleep: (ms) => sleeps.push(ms),
      maxRestarts: 2,
    });
    expect(res).toEqual({ restarts: 2, stoppedReason: 'max-restarts' });
    expect(sleeps).toEqual([]); // clean exits never sleep — restart is immediate
  });

  it('a CRASH exit triggers a backoff sleep before the next spawn', async () => {
    const exits = [
      { code: 1, signal: null, ranMs: 50 },
      { code: 0, signal: null, ranMs: 10_000 },
    ];
    let n = 0;
    const sleeps = [];
    const res = await runSupervisorLoop({
      spawnChild: () => exits[Math.min(n++, exits.length - 1)],
      sleep: (ms) => sleeps.push(ms),
      maxRestarts: 2,
    });
    expect(res.restarts).toBe(2);
    expect(sleeps).toEqual([DEFAULT_BASE_BACKOFF_MS]); // exactly one backoff, after the crash, before restart 2
  });

  it('backoff GROWS across repeated crashes and RESETS after a healthy run', async () => {
    // crash, crash, crash, clean(healthy — long-running), crash — the 5th crash must back off at the BASE
    // delay again, proving the streak reset by the clean run rather than continuing to grow from 3.
    const exits = [
      { code: 1, signal: null, ranMs: 50 },
      { code: 1, signal: null, ranMs: 50 },
      { code: 1, signal: null, ranMs: 50 },
      { code: 0, signal: null, ranMs: 30_000 },
      { code: 1, signal: null, ranMs: 50 },
    ];
    let n = 0;
    const sleeps = [];
    // maxRestarts is ONE past exits.length: the Nth backoff sleep is a TRAILING effect that runs only after
    // attempt N's exit is processed and BEFORE attempt N+1 is spawned (mirrors runner.mjs's runLoop, whose
    // bound likewise stops before the trailing per-tick sleep) — so bounding at exactly exits.length would
    // stop the loop right after crash 5's exit, before its backoff ever sleeps. The 6th spawn reuses the last
    // (crash) entry via the Math.min clamp and is itself cut off by maxRestarts before ITS backoff runs.
    await runSupervisorLoop({
      spawnChild: () => exits[Math.min(n++, exits.length - 1)],
      sleep: (ms) => sleeps.push(ms),
      maxRestarts: exits.length + 1,
    });
    expect(sleeps).toEqual([
      DEFAULT_BASE_BACKOFF_MS,       // after crash 1
      DEFAULT_BASE_BACKOFF_MS * 2,   // after crash 2
      DEFAULT_BASE_BACKOFF_MS * 4,   // after crash 3
      // clean run 4 → no sleep entry
      DEFAULT_BASE_BACKOFF_MS,       // crash 5, streak reset by the clean run — back to base, not *8
    ]);
  });

  // #3406 — Done-when 1: N consecutive clean exits reporting the SAME idle-stop reason in immediate
  // succession (simulating the operator staying away — assessIdleStop reads wall-clock time since the
  // operator last acted, which a fresh respawn does not reset) must produce a GROWING delay between spawns,
  // not `sleeps` staying `[]`/all-zero. Fails before #3406 (every clean exit — idle-stop included — restarted
  // with delayMs:0, a genuine busy-loop); passes once idle-stop backs off specifically.
  it('repeated idle-stop clean exits back off with a GROWING delay, simulating the operator staying away', async () => {
    const sleeps = [];
    const res = await runSupervisorLoop({
      spawnChild: () => ({ code: 0, signal: null, ranMs: 10_000, stoppedReason: 'idle-stop' }),
      sleep: (ms) => sleeps.push(ms),
      maxRestarts: 4,
    });
    expect(res.restarts).toBe(4);
    expect(sleeps).toEqual([DEFAULT_IDLE_BASE_BACKOFF_MS, DEFAULT_IDLE_BASE_BACKOFF_MS * 2, DEFAULT_IDLE_BASE_BACKOFF_MS * 4]);
  });

  it('a polite stand-down interleaved into a run of idle-stops restarts PROMPTLY, not slowed by the same fix', async () => {
    // idle-stop, idle-stop, then another runner grabs the lease (stand-down) — the stand-down must NOT inherit
    // the idle backoff that was building, and must itself sleep 0.
    const exits = [
      { code: 0, signal: null, ranMs: 10_000, stoppedReason: 'idle-stop' },
      { code: 0, signal: null, ranMs: 10_000, stoppedReason: 'idle-stop' },
      { code: 0, signal: null, ranMs: 10_000, stoppedReason: 'stand-down' },
    ];
    let n = 0;
    const sleeps = [];
    await runSupervisorLoop({
      spawnChild: () => exits[Math.min(n++, exits.length - 1)],
      sleep: (ms) => sleeps.push(ms),
      maxRestarts: exits.length + 1,
    });
    expect(sleeps).toEqual([DEFAULT_IDLE_BASE_BACKOFF_MS, DEFAULT_IDLE_BASE_BACKOFF_MS * 2]); // stand-down's own backoff never appears — it is 0
  });

  it('logs one line per spawn/exit/backoff, with kind "initial" on the first spawn and "restart" after', async () => {
    const exits = [{ code: 1, signal: null, ranMs: 50 }, { code: 0, signal: null, ranMs: 10_000 }];
    let n = 0;
    const events = [];
    await runSupervisorLoop({
      spawnChild: () => exits[Math.min(n++, exits.length - 1)],
      log: (e) => events.push(e),
      sleep: () => {},
      maxRestarts: 2,
    });
    const kinds = events.map((e) => e.event);
    expect(kinds).toEqual(['spawn', 'exit', 'backoff', 'spawn', 'exit']);
    expect(events[0].kind).toBe('initial');
    expect(events[3].kind).toBe('restart');
    expect(events[1]).toMatchObject({ event: 'exit', code: 1, kind: 'crash', reason: 'exit:1' });
    expect(events[4]).toMatchObject({ event: 'exit', code: 0, kind: 'clean', reason: 'exit:0' });
  });

  it('a shutdown signal (shouldStop) stops the loop BEFORE the next spawn — no extra child launched', async () => {
    let spawnCalls = 0;
    let stop = false;
    const res = await runSupervisorLoop({
      spawnChild: () => { spawnCalls++; stop = true; return { code: 0, signal: null, ranMs: 10_000 }; },
      shouldStop: () => stop,
      sleep: () => {},
      maxRestarts: Infinity,
    });
    expect(res).toEqual({ restarts: 1, stoppedReason: 'signal' });
    expect(spawnCalls).toBe(1); // the flag flips DURING the first spawn's resolution; no second spawn follows
  });

  it('a shutdown signal also skips a pending backoff sleep — stop wins over a queued crash delay', async () => {
    let stop = false;
    const sleeps = [];
    const res = await runSupervisorLoop({
      spawnChild: () => { stop = true; return { code: 1, signal: 'SIGTERM', ranMs: 50 }; },
      shouldStop: () => stop,
      sleep: (ms) => sleeps.push(ms),
      maxRestarts: Infinity,
    });
    expect(res.stoppedReason).toBe('signal');
    expect(sleeps).toEqual([]); // never slept the backoff — shutdown pre-empted it
  });

  it('never spawns at all if shouldStop is already true at entry', async () => {
    let spawnCalls = 0;
    const res = await runSupervisorLoop({ spawnChild: () => { spawnCalls++; return { code: 0, ranMs: 1 }; }, shouldStop: () => true });
    expect(res).toEqual({ restarts: 0, stoppedReason: 'signal' });
    expect(spawnCalls).toBe(0);
  });

  it('requires a spawnChild effect', async () => {
    await expect(runSupervisorLoop({})).rejects.toThrow(/spawnChild/);
  });
});

// ── (4) detectSupervisorAnomalies / healthFromAnomalies / decideAlert (#3398) — pure, fixture-driven ─────────

describe('detectSupervisorAnomalies — crash-loop-at-ceiling, from fixture spawn/exit/backoff history', () => {
  const backoffAtCeiling = (n) => Array.from({ length: n }, (_, i) => ({ event: 'backoff', at: `t${i}`, delayMs: DEFAULT_MAX_BACKOFF_MS, consecutiveCrashes: 7 + i }));

  it('no anomaly below the warn count', () => {
    expect(detectSupervisorAnomalies({ history: [] })).toEqual([]);
    expect(detectSupervisorAnomalies({ history: [{ event: 'backoff', at: 't0', delayMs: DEFAULT_BASE_BACKOFF_MS }] })).toEqual([]);
  });

  it('WARN once the backoff has plateaued at the ceiling CRASH_CEILING_WARN_COUNT time(s)', () => {
    const history = backoffAtCeiling(CRASH_CEILING_WARN_COUNT);
    const anomalies = detectSupervisorAnomalies({ history });
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ type: 'crash-loop-at-ceiling', severity: 'warn' });
  });

  it('CRITICAL once it has stayed at the ceiling for CRASH_CEILING_CRIT_COUNT crashes running', () => {
    const history = backoffAtCeiling(CRASH_CEILING_CRIT_COUNT);
    const anomalies = detectSupervisorAnomalies({ history });
    expect(anomalies[0]).toMatchObject({ type: 'crash-loop-at-ceiling', severity: 'critical' });
  });

  it('a spawn/exit interleaved between ceiling backoffs does not break the run', () => {
    const history = [
      { event: 'backoff', at: 't0', delayMs: DEFAULT_MAX_BACKOFF_MS },
      { event: 'spawn', at: 't1' },
      { event: 'exit', at: 't2', code: 1 },
      { event: 'backoff', at: 't3', delayMs: DEFAULT_MAX_BACKOFF_MS },
      { event: 'spawn', at: 't4' },
      { event: 'exit', at: 't5', code: 1 },
      { event: 'backoff', at: 't6', delayMs: DEFAULT_MAX_BACKOFF_MS },
    ];
    const anomalies = detectSupervisorAnomalies({ history });
    expect(anomalies[0].evidence.ceilingHits).toBe(3);
  });

  it('a healthy (non-ceiling) backoff BREAKS the trailing run — a since-recovered crash-loop is not still alarmed', () => {
    const history = [
      ...backoffAtCeiling(5),
      { event: 'backoff', at: 'tN', delayMs: DEFAULT_BASE_BACKOFF_MS }, // streak reset by a clean run in between
    ];
    expect(detectSupervisorAnomalies({ history })).toEqual([]);
  });

  // #3406 — an idle-stop backoff's OWN delayMs can legitimately climb past the CRASH ceiling
  // (DEFAULT_MAX_BACKOFF_MS) on its way to its own, higher DEFAULT_IDLE_MAX_BACKOFF_MS ceiling. Without the
  // `kind` check this would misfire the crash-loop-at-ceiling alert on a conveyor that is merely idle, not
  // crash-looping at all.
  it('a sustained idle-stop backoff never triggers crash-loop-at-ceiling, even once its own delayMs exceeds the crash ceiling', () => {
    const idleHistory = Array.from({ length: 5 }, (_, i) => ({
      event: 'backoff', at: `t${i}`, kind: 'idle-stop', delayMs: DEFAULT_IDLE_MAX_BACKOFF_MS, consecutiveIdleStops: 6 + i,
    }));
    expect(DEFAULT_IDLE_MAX_BACKOFF_MS).toBeGreaterThan(DEFAULT_MAX_BACKOFF_MS); // the premise this test needs to be meaningful
    expect(detectSupervisorAnomalies({ history: idleHistory })).toEqual([]);
  });

  it('an idle-stop backoff interleaved into an OLDER crash-ceiling run still breaks that run (not merely skipped over)', () => {
    // 5 crash-ceiling hits (alone: CRITICAL), then an idle-stop, then 2 FRESH crash-ceiling hits (alone: warn,
    // below CRASH_CEILING_CRIT_COUNT=3). If the idle-stop entry were silently skipped over (rather than
    // breaking the run) the trailing count would bridge to 7 and read CRITICAL; it must read WARN instead.
    const history = [
      ...backoffAtCeiling(5),
      { event: 'backoff', at: 'tMid', kind: 'idle-stop', delayMs: DEFAULT_IDLE_MAX_BACKOFF_MS, consecutiveIdleStops: 1 },
      ...backoffAtCeiling(2),
    ];
    const anomalies = detectSupervisorAnomalies({ history });
    expect(anomalies[0]).toMatchObject({ type: 'crash-loop-at-ceiling', severity: 'warn' });
    expect(anomalies[0].evidence.ceilingHits).toBe(2);
  });
});

describe('detectSupervisorAnomalies — idle-with-queue, from fixture tick history', () => {
  const idleTick = (i) => ({ event: 'tick', at: `t${i}`, tick: i, counts: { queued: 2 }, dispatchedTotal: 0 });
  const busyTick = (i) => ({ event: 'tick', at: `t${i}`, tick: i, counts: { queued: 1 }, dispatchedTotal: 1 });
  const emptyQueueTick = (i) => ({ event: 'tick', at: `t${i}`, tick: i, counts: { queued: 0 }, dispatchedTotal: 0 });

  it('no anomaly below the warn tick count', () => {
    const history = Array.from({ length: IDLE_QUEUE_WARN_TICKS - 1 }, (_, i) => idleTick(i));
    expect(detectSupervisorAnomalies({ history })).toEqual([]);
  });

  it('WARN at IDLE_QUEUE_WARN_TICKS consecutive idle-with-queue ticks', () => {
    const history = Array.from({ length: IDLE_QUEUE_WARN_TICKS }, (_, i) => idleTick(i));
    const anomalies = detectSupervisorAnomalies({ history });
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ type: 'idle-with-queue', severity: 'warn' });
  });

  it('CRITICAL at IDLE_QUEUE_CRIT_TICKS', () => {
    const history = Array.from({ length: IDLE_QUEUE_CRIT_TICKS }, (_, i) => idleTick(i));
    expect(detectSupervisorAnomalies({ history })[0]).toMatchObject({ type: 'idle-with-queue', severity: 'critical' });
  });

  it('a genuinely EMPTY queue is not an anomaly — idle is the expected, healthy state', () => {
    const history = Array.from({ length: IDLE_QUEUE_CRIT_TICKS + 5 }, (_, i) => emptyQueueTick(i));
    expect(detectSupervisorAnomalies({ history })).toEqual([]);
  });

  it('a tick where something WAS dispatched breaks the run — real progress is not stuck', () => {
    const history = [...Array.from({ length: IDLE_QUEUE_CRIT_TICKS }, (_, i) => idleTick(i)), busyTick(IDLE_QUEUE_CRIT_TICKS)];
    expect(detectSupervisorAnomalies({ history })).toEqual([]);
  });

  it('a restart (exit/spawn) after the idle run means the CURRENT child is not idle — no anomaly', () => {
    const history = [...Array.from({ length: IDLE_QUEUE_CRIT_TICKS }, (_, i) => idleTick(i)), { event: 'exit', at: 'tX', code: 0 }];
    expect(detectSupervisorAnomalies({ history })).toEqual([]);
  });

  it('both detectors can fire at once, worst-severity first', () => {
    const history = [...backoffAtCeilingFixture(), ...Array.from({ length: IDLE_QUEUE_WARN_TICKS }, (_, i) => idleTick(i))];
    const anomalies = detectSupervisorAnomalies({ history });
    expect(anomalies.map((a) => a.type)).toEqual(['crash-loop-at-ceiling', 'idle-with-queue']);
    expect(anomalies[0].severity).toBe('critical');
  });
  function backoffAtCeilingFixture() {
    return Array.from({ length: CRASH_CEILING_CRIT_COUNT }, (_, i) => ({ event: 'backoff', at: `b${i}`, delayMs: DEFAULT_MAX_BACKOFF_MS }));
  }
});

describe('healthFromAnomalies — worst severity wins', () => {
  it('no anomalies → healthy', () => expect(healthFromAnomalies([])).toBe('healthy'));
  it('a warn → degraded', () => expect(healthFromAnomalies([{ severity: 'warn' }])).toBe('degraded'));
  it('a critical → stuck', () => expect(healthFromAnomalies([{ severity: 'warn' }, { severity: 'critical' }])).toBe('stuck'));
});

describe('decideAlert — fires on health CHANGE or after the re-nag window; never on healthy', () => {
  it('never fires when healthy', () => {
    expect(decideAlert({ health: 'healthy', lastAlert: null }).fire).toBe(false);
  });
  it('fires on the FIRST degraded/stuck verdict (no prior alert)', () => {
    const { fire, record } = decideAlert({ health: 'degraded', anomalies: [{ type: 'idle-with-queue' }], lastAlert: null, nowMs: 1000 });
    expect(fire).toBe(true);
    expect(record).toMatchObject({ health: 'degraded', signature: 'degraded', types: ['idle-with-queue'] });
  });
  it('does NOT re-fire for the SAME health within the re-nag window', () => {
    const lastAlert = { signature: 'degraded', at: new Date(1000).toISOString() };
    const { fire } = decideAlert({ health: 'degraded', lastAlert, nowMs: 1000 + ALERT_RENAG_MS - 1 });
    expect(fire).toBe(false);
  });
  it('DOES re-fire once the re-nag window has elapsed for a still-standing health', () => {
    const lastAlert = { signature: 'degraded', at: new Date(1000).toISOString() };
    const { fire } = decideAlert({ health: 'degraded', lastAlert, nowMs: 1000 + ALERT_RENAG_MS });
    expect(fire).toBe(true);
  });
  it('fires immediately on a health CHANGE, even inside the re-nag window', () => {
    const lastAlert = { signature: 'degraded', at: new Date(1000).toISOString() };
    const { fire, record } = decideAlert({ health: 'stuck', lastAlert, nowMs: 1500 });
    expect(fire).toBe(true);
    expect(record.signature).toBe('stuck');
  });
});

// ── (5) real subprocess wiring — makeRealSpawnChild / makeJsonlLog against REAL child processes / files ────

describe('makeRealSpawnChild — real node child processes, never runner.mjs itself', () => {
  it('reports a real clean exit code and a plausible ranMs — proving spawn() wiring, not a stub', async () => {
    const spawnChild = makeRealSpawnChild({ runnerPath: '-e', extraArgs: ['process.exit(0)'], onChild: () => {} });
    const start = Date.now();
    const result = await spawnChild();
    expect(result).toMatchObject({ code: 0, signal: null });
    expect(result.ranMs).toBeGreaterThanOrEqual(0);
    expect(result.ranMs).toBeLessThan(Date.now() - start + 50); // internally-measured duration is sane
  }, 15_000); // a real `node -e` spawn can take multiple seconds under a loaded environment (measured: ~5s here)

  it('reports a real non-zero exit code', async () => {
    const spawnChild = makeRealSpawnChild({ runnerPath: '-e', extraArgs: ['process.exit(7)'], onChild: () => {} });
    const result = await spawnChild();
    expect(result).toMatchObject({ code: 7, signal: null });
  }, 15_000);

  it('a real child killed via the handle reports the SIGNAL, and the process is actually gone — proving no orphan', async () => {
    // A real long-sleeping child (well beyond the test's own patience), so it can ONLY end by being killed —
    // if the kill wiring were broken this test would time out instead of failing fast.
    let liveChild = null;
    const spawnChild = makeRealSpawnChild({
      runnerPath: '-e', extraArgs: ['setTimeout(() => {}, 60_000)'],
      onChild: (c) => { liveChild = c; },
    });
    const pending = spawnChild();
    // Give the child a moment to actually be spawned (onChild fires synchronously inside spawn(), but the OS
    // process itself needs a tick to exist) before signalling it.
    await new Promise((r) => setTimeout(r, 100));
    expect(liveChild).not.toBeNull();
    const pid = liveChild.pid;
    liveChild.kill('SIGTERM');
    const result = await pending;
    expect(result.signal).toBe('SIGTERM');
    expect(liveChild).toBeNull(); // onChild(null) fired on exit — the shutdown path's handle is cleared
    // The OS process is actually gone (ESRCH), not just detached — the orphan this whole mechanism prevents.
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('#3398 — parses a JSON tick line off real stdout into onTickLine, AND still mirrors it to this process\'s own stdout', async () => {
    const lines = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => { lines.push(String(chunk)); return origWrite(chunk, ...rest); };
    const ticks = [];
    try {
      const script = 'console.log(JSON.stringify({tick:3,counts:{queued:2},dispatch:{builds:[]}}));process.exit(0)';
      const spawnChild = makeRealSpawnChild({ runnerPath: '-e', extraArgs: [script], onChild: () => {}, onTickLine: (t) => ticks.push(t) });
      await spawnChild();
    } finally {
      process.stdout.write = origWrite;
    }
    expect(ticks).toEqual([{ tick: 3, counts: { queued: 2 }, dispatch: { builds: [] } }]);
    expect(lines.join('')).toContain('"tick":3');
  }, 15_000);

  it('#3398 — a non-JSON stdout line (a human-mode status line) is mirrored but never handed to onTickLine', async () => {
    const ticks = [];
    const script = 'console.log("[tick 0] conveyor \\u00b7 0 building"); process.exit(0)';
    const spawnChild = makeRealSpawnChild({ runnerPath: '-e', extraArgs: [script], onChild: () => {}, onTickLine: (t) => ticks.push(t) });
    await spawnChild();
    expect(ticks).toEqual([]);
  }, 15_000);

  // #3406 — runner.mjs's own final `--json` line off REAL stdout must reach `classifyExit` as `stoppedReason`,
  // exactly the fact `decideRestart`'s idle-stop backoff is keyed on.
  it('#3406 — captures stoppedReason:"idle-stop" off a real child\'s final {event:"stopped"} JSON line', async () => {
    const script = 'console.log(JSON.stringify({event:"stopped",stoppedReason:"idle-stop",ticks:3}));process.exit(0)';
    const spawnChild = makeRealSpawnChild({ runnerPath: '-e', extraArgs: [script], onChild: () => {} });
    const result = await spawnChild();
    expect(result.stoppedReason).toBe('idle-stop');
    expect(result.code).toBe(0);
  }, 15_000);

  it('#3406 — captures stoppedReason:"stand-down" off a real child\'s final {event:"stood-down"} JSON line', async () => {
    const script = 'console.log(JSON.stringify({event:"stood-down",heldBy:"other-pid"}));process.exit(0)';
    const spawnChild = makeRealSpawnChild({ runnerPath: '-e', extraArgs: [script], onChild: () => {} });
    const result = await spawnChild();
    expect(result.stoppedReason).toBe('stand-down');
  }, 15_000);

  it('#3406 — a child with no final event line at all (an older runner, or max-ticks/lease-lost) leaves stoppedReason null', async () => {
    const spawnChild = makeRealSpawnChild({ runnerPath: '-e', extraArgs: ['process.exit(0)'], onChild: () => {} });
    const result = await spawnChild();
    expect(result.stoppedReason).toBeNull();
  }, 15_000);

  it('a child that fails to even start running (a nonexistent script path) still resolves — not a hang', async () => {
    // The command is always `node` (process.execPath, hardcoded in makeRealSpawnChild) — a nonexistent
    // `runnerPath` doesn't ENOENT at the spawn() layer (node itself always resolves); node starts, fails to
    // load the missing file, and exits non-zero. That is still exactly the "child died badly" case the
    // supervisor must observe rather than hang on, so it's what this proves: the promise settles with a
    // real non-zero code, never null/undefined and never an unhandled rejection.
    const spawnChild = makeRealSpawnChild({ runnerPath: join(tmpdir(), 'definitely-does-not-exist-conveyor-supervisor-test.mjs'), extraArgs: [], onChild: () => {} });
    const result = await spawnChild();
    expect(result.signal).toBeNull();
    expect(result.code).not.toBe(0);
    expect(Number.isInteger(result.code)).toBe(true);
  }, 15_000); // a real node spawn can take multiple seconds under a loaded environment (measured: ~5s here)
});

describe('makeJsonlLog — real file IO, best-effort (never throws)', () => {
  let dir;
  afterEach(() => { if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } } dir = null; });

  it('appends one JSON line per call to a real file, creating its parent dir', () => {
    dir = mkdtempSync(join(tmpdir(), 'conveyor-supervisor-log-'));
    const logPath = join(dir, 'nested', 'supervisor-history.jsonl');
    const log = makeJsonlLog(logPath);
    log({ event: 'spawn', attempt: 1 });
    log({ event: 'exit', attempt: 1, code: 0 });
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([{ event: 'spawn', attempt: 1 }, { event: 'exit', attempt: 1, code: 0 }]);
  });

  it('never throws even when the path is unwritable (observability must never break the loop)', () => {
    // A path under a file (not a directory) can never be created — mkdirSync/appendFileSync both fail, and
    // the whole point of the try/catch is that the caller never sees it.
    dir = mkdtempSync(join(tmpdir(), 'conveyor-supervisor-log-'));
    const blocker = join(dir, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const log = makeJsonlLog(join(blocker, 'child', 'history.jsonl'));
    expect(() => log({ event: 'spawn' })).not.toThrow();
  });

  it('DEFAULT_LOG_PATH sits under RUNNER_LOCK_ROOT — the established local-state home, not a third location', () => {
    expect(DEFAULT_LOG_PATH.endsWith('supervisor-history.jsonl')).toBe(true);
    expect(DEFAULT_LOG_PATH).toContain('conveyor-runner-locks');
  });
});

// quietHours (card xmvc6oc): the supervisor's fire-and-forget notifier acknowledges before osascript has run, so the
// held-alerts digest goes through this CHECKED sender instead (an unconfirmed digest stays queued for the next flush).
describe('sendDesktopChecked — confirms only a real exit zero', () => {
  it('ok on status 0; failure, throw and non-macOS are reported, never acknowledged', async () => {
    const { sendDesktopChecked } = await import('../supervisor.mjs');
    const n = { title: 'say "hi"', body: 'b' };
    const calls = [];
    expect(sendDesktopChecked(n, { platform: 'darwin', spawnSyncFn: (...a) => { calls.push(a); return { status: 0 }; } })).toEqual({ ok: true });
    expect(calls[0][0]).toBe('osascript');
    expect(calls[0][1][1]).toContain('with title "say \\"hi\\""');
    expect(sendDesktopChecked(n, { platform: 'darwin', spawnSyncFn: () => ({ status: 1, stderr: 'denied' }) })).toMatchObject({ ok: false });
    expect(sendDesktopChecked(n, { platform: 'darwin', spawnSyncFn: () => ({ status: null, error: new Error('ETIMEDOUT') }) })).toMatchObject({ ok: false });
    expect(sendDesktopChecked(n, { platform: 'darwin', spawnSyncFn: () => { throw new Error('boom'); } })).toMatchObject({ ok: false });
    expect(sendDesktopChecked(n, { platform: 'linux', spawnSyncFn: () => ({ status: 0 }) })).toMatchObject({ ok: false });
  });

  it('notifyDesktop hands the quiet-hours gate the CHECKED sender for the digest (a failed osascript is not a confirmation)', async () => {
    const { notifyDesktop } = await import('../supervisor.mjs');
    let opts = null;
    notifyDesktop({ title: 't', body: 'b' }, { quietGate: (_n, o) => { opts = o; }, platform: 'darwin', spawnSyncFn: () => ({ status: 1, stderr: 'denied' }) });
    expect(opts.sendDigest({ title: 'd', body: 'd' })).toMatchObject({ ok: false });
    notifyDesktop({ title: 't', body: 'b' }, { quietGate: (_n, o) => { opts = o; }, platform: 'darwin', spawnSyncFn: () => ({ status: 0 }) });
    expect(opts.sendDigest({ title: 'd', body: 'd' })).toEqual({ ok: true });
  });
});
