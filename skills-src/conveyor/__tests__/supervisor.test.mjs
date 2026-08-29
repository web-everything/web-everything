/**
 * @file skills-src/conveyor/__tests__/supervisor.test.mjs
 * @description Unit proof of the conveyor RESIDENT SUPERVISOR ({@link ../supervisor.mjs}) — the last piece
 *   that makes the headless runner ({@link ../runner.mjs}) self-sustaining. Three subjects:
 *
 *   • the PURE classify/backoff decisions ({@link classifyExit}, {@link decideRestart}) — plain objects in,
 *     plain objects out, no clock/IO of their own;
 *   • the SUPERVISOR'S CONTROL FLOW ({@link runSupervisorLoop}) — driven with fake `spawnChild`/`sleep`/`log`
 *     effects, proving: a clean exit restarts with no backoff, a crash triggers backoff, the backoff grows on
 *     repeated crashes and resets after a healthy run, and a shutdown signal stops the loop before the next
 *     spawn (never orphaning a child the pure loop doesn't itself own);
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
  DEFAULT_CRASH_THRESHOLD_MS, DEFAULT_BASE_BACKOFF_MS, DEFAULT_MAX_BACKOFF_MS, DEFAULT_LOG_PATH,
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
});

// ── (2) decideRestart — the backoff curve ────────────────────────────────────────────────────────────────────

describe('decideRestart — no delay + reset on clean, doubling backoff (capped) on crash', () => {
  it('a clean classification restarts immediately and resets the streak', () => {
    expect(decideRestart({ classification: { kind: 'clean', reason: 'exit:0' }, consecutiveCrashes: 4 }))
      .toEqual({ delayMs: 0, consecutiveCrashes: 0 });
  });
  it('the first crash backs off by exactly the base delay', () => {
    expect(decideRestart({ classification: { kind: 'crash', reason: 'exit:1' }, consecutiveCrashes: 0 }))
      .toEqual({ delayMs: DEFAULT_BASE_BACKOFF_MS, consecutiveCrashes: 1 });
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

// ── (4) real subprocess wiring — makeRealSpawnChild / makeJsonlLog against REAL child processes / files ────

describe('makeRealSpawnChild — real node child processes, never runner.mjs itself', () => {
  it('reports a real clean exit code and a plausible ranMs — proving spawn() wiring, not a stub', async () => {
    const spawnChild = makeRealSpawnChild({ runnerPath: '-e', extraArgs: ['process.exit(0)'], onChild: () => {} });
    const start = Date.now();
    const result = await spawnChild();
    expect(result).toMatchObject({ code: 0, signal: null });
    expect(result.ranMs).toBeGreaterThanOrEqual(0);
    expect(result.ranMs).toBeLessThan(Date.now() - start + 50); // internally-measured duration is sane
  });

  it('reports a real non-zero exit code', async () => {
    const spawnChild = makeRealSpawnChild({ runnerPath: '-e', extraArgs: ['process.exit(7)'], onChild: () => {} });
    const result = await spawnChild();
    expect(result).toMatchObject({ code: 7, signal: null });
  });

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
  });
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
