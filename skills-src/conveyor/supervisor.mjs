#!/usr/bin/env node
/**
 * @file skills-src/conveyor/supervisor.mjs
 * @description The conveyor headless runner's RESIDENT SUPERVISOR — the last piece that makes
 *   {@link ./runner.mjs} self-sustaining. `runner.mjs` already owns the hard parts: the tick loop, the
 *   singleton lease, dispatch, and the deterministic mechanical passes. It runs until told to stop (idle-stop,
 *   a spent tick budget, or losing its lease) and then EXITS — nothing today restarts it, so an idle-stop or a
 *   crash just leaves the conveyor undriven until a human notices and relaunches it by hand. This file is that
 *   missing "keep it running" layer, and NOTHING more: spawn `runner.mjs` as a child, wait for it to exit, log
 *   what happened, back off if it keeps crashing, and repeat until the supervisor itself is told to stop.
 *
 * SCOPED DELIBERATELY NARROW, unlike its precedent. `plateau-app/tools/drain-daemon/daemon.mjs` (the sibling
 *   resident-process pattern this file follows) is ~360 lines because a drain SWEEP is itself a complex,
 *   multi-phase operation (clone refresh, a push/nudge seam, desktop alerting, an operator pause flag) that the
 *   daemon layer owns. A conveyor tick has no analogue to any of that — `runner.mjs` already IS the tested,
 *   singleton-locked "do the work" loop. So this file only answers one question, repeatedly: the child exited —
 *   restart it now, or back off first? Everything else (guards, dispatch, the lease) stays runner.mjs's job.
 *
 * PURE-CORE / IO-SHELL SPLIT (mirrored from runner.mjs's own header, which mirrors tick-core.mjs's):
 *   • The PURE core ({@link classifyExit}, {@link decideRestart}, {@link runSupervisorLoop}) has NO
 *     child_process / fs / clock of its own — every effect (spawning the child, sleeping, logging) is
 *     INJECTED, so the whole restart/backoff decision is unit-tested with fakes
 *     (skills-src/conveyor/__tests__/supervisor.test.mjs) — no real runner.mjs, no real lease.
 *   • The IO SHELL (`main()`, gated on the direct-invocation check) actually spawns
 *     `node skills-src/conveyor/runner.mjs [flags]`, forwards SIGINT/SIGTERM to it so a stopped supervisor
 *     never leaves an orphaned runner child behind, and appends the JSONL log.
 */

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RUNNER_LOCK_ROOT } from './runner-lock.mjs';

// ── PURE CORE (no IO — every effect is injected; unit-tested directly) ─────────────────────────────────────

/** Below this runtime, an exit — EVEN a clean `code:0` one — looks less like "one real tick ran" and more like
 *  an immediate crash-loop (e.g. `runner.mjs` throwing before it reaches its own try/finally, or the tick-core
 *  child failing to spawn on every attempt). A real tick shells at least one `node tick-core.mjs` subprocess
 *  (execFileSync) plus the two mechanical passes before it can even reach an idle-stop check, which reliably
 *  costs low-hundreds of ms; 3s leaves comfortable headroom above that floor while still being far below the
 *  120s tick interval, so one slow-but-legitimate first tick is never misclassified. */
export const DEFAULT_CRASH_THRESHOLD_MS = 3_000;

/** Backoff base + ceiling for repeated crashes. `runner.mjs` ticks every 120s (DEFAULT_TICK_INTERVAL_MS), so a
 *  cap of 5 minutes is deliberately a bit above one tick interval — long enough that a crash-looping runner
 *  stops hammering the lease/tick-core child, short enough that a transient fault (a flaky git call, a momentary
 *  disk hiccup) still self-heals well within an operator's normal check-in cadence. The 5s base doubling each
 *  consecutive crash (5s → 10s → 20s → 40s → 80s → 160s → 300s, capped) reaches the ceiling in 7 crashes —
 *  fast enough to matter, slow enough that one bad tick doesn't immediately eat the whole ceiling (contrast
 *  drain-daemon's exit-3 "duplicate NNN" case, which jumps straight to its ceiling because that failure mode is
 *  known-unrecoverable without an operator; a crashed runner has no such known-unrecoverable variant). */
export const DEFAULT_BASE_BACKOFF_MS = 5_000;
export const DEFAULT_MAX_BACKOFF_MS = 300_000;

/**
 * Classify one child exit as `'clean'` (an ordinary stop — idle-stop, or a polite stand-down because another
 * runner legitimately holds the singleton lease; both exit `runner.mjs` with code 0, see its `main()`) or
 * `'crash'` (a non-zero exit, death by signal, or a suspiciously fast exit that suggests a crash-loop even at
 * code 0). Pure — takes the raw exit facts, decides nothing about WHEN to restart (that's {@link decideRestart}).
 * @returns {{ kind: 'clean'|'crash', reason: string }}
 */
export function classifyExit({ code = null, signal = null, ranMs = 0 } = {}, { crashThresholdMs = DEFAULT_CRASH_THRESHOLD_MS } = {}) {
  if (signal) return { kind: 'crash', reason: `signal:${signal}` };
  if (code !== 0) return { kind: 'crash', reason: `exit:${code}` };
  if (ranMs < crashThresholdMs) return { kind: 'crash', reason: 'too-short' };
  return { kind: 'clean', reason: 'exit:0' };
}

/**
 * Decide the delay before the NEXT spawn, and the new consecutive-crash streak, from one classified exit. A
 * `'clean'` exit restarts with no delay and resets the streak — the child did real work and stopped for a
 * legitimate reason, so there is nothing to back off from. A `'crash'` grows the streak and doubles the delay
 * (capped), exactly the drain-daemon `decideNextDelaySec` shape, simplified: no exit-3-style fixed-ceiling
 * special case, because unlike a globally-red `main` (an operator-only fix), no conveyor-runner crash mode is
 * known in advance to be unrecoverable — every crash gets the same doubling treatment.
 * @returns {{ delayMs: number, consecutiveCrashes: number }}
 */
export function decideRestart({ classification, consecutiveCrashes = 0 } = {}, { baseBackoffMs = DEFAULT_BASE_BACKOFF_MS, maxBackoffMs = DEFAULT_MAX_BACKOFF_MS } = {}) {
  if (!classification || classification.kind !== 'crash') return { delayMs: 0, consecutiveCrashes: 0 };
  const crashes = consecutiveCrashes + 1;
  const delayMs = Math.min(baseBackoffMs * 2 ** (crashes - 1), maxBackoffMs);
  return { delayMs, consecutiveCrashes: crashes };
}

/**
 * The supervisor's WHOLE control flow, as a reducer over injected effects — unit-testable with fakes, no IO of
 * its own. Each iteration: spawn the child, classify + log its exit, decide the restart delay, then either stop
 * (a spent `maxRestarts` budget or `shouldStop()` — the signal-driven shutdown flag) or sleep the delay and
 * loop. Mirrors {@link ./runner.mjs}'s `runLoop` shape (`tickOnce`→`spawnChild`, `emit`→`log`, `maxTicks`→
 * `maxRestarts`) deliberately — same repo, same pattern, one level up the process tree.
 *
 * @param {object} effects
 * @param {()=>Promise<{code:number|null,signal:string|null,ranMs:number}>} effects.spawnChild  run the child once, resolve on its exit
 * @param {(entry:object)=>any} [effects.log]           append one structured event (spawn/exit/backoff)
 * @param {(ms:number)=>any} [effects.sleep]             wait between restarts
 * @param {number} [effects.maxRestarts]                 bounded-run spawn budget (Infinity = forever)
 * @param {()=>boolean} [effects.shouldStop]              polled before each spawn AND before each backoff sleep
 * @param {number} [effects.baseBackoffMs]
 * @param {number} [effects.maxBackoffMs]
 * @param {number} [effects.crashThresholdMs]
 * @returns {Promise<{ restarts: number, stoppedReason: 'max-restarts'|'signal' }>}
 */
export async function runSupervisorLoop({
  spawnChild,
  log = () => {},
  sleep = () => {},
  maxRestarts = Infinity,
  shouldStop = () => false,
  baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  crashThresholdMs = DEFAULT_CRASH_THRESHOLD_MS,
} = {}) {
  if (typeof spawnChild !== 'function') throw new TypeError('runSupervisorLoop requires a spawnChild effect');
  let consecutiveCrashes = 0;
  let restarts = 0;
  for (;;) {
    // Checked BEFORE every spawn, not just between backoffs — a shutdown signal that arrives while we're idle
    // (no child in flight) must stop us from launching one more child we'd immediately have to tear down.
    if (shouldStop()) return { restarts, stoppedReason: 'signal' };
    restarts += 1;
    const attempt = restarts;
    log({ event: 'spawn', at: new Date().toISOString(), attempt, kind: attempt === 1 ? 'initial' : 'restart' });
    const result = await spawnChild();
    const classification = classifyExit(result, { crashThresholdMs });
    log({
      event: 'exit', at: new Date().toISOString(), attempt,
      code: result.code, signal: result.signal, ranMs: result.ranMs,
      kind: classification.kind, reason: classification.reason,
      // Best-effort context only — does NOT change classification. A shutdown-requested SIGTERM still reads as
      // a `crash` (signal-classified) in `kind`/`reason` above; this flag lets a log reader tell "we killed it
      // on purpose" apart from "it died on its own" without coupling the pure classifier to IO-only state.
      shutdownRequested: shouldStop(),
    });
    const restart = decideRestart({ classification, consecutiveCrashes }, { baseBackoffMs, maxBackoffMs });
    consecutiveCrashes = restart.consecutiveCrashes;
    if (attempt >= maxRestarts) return { restarts, stoppedReason: 'max-restarts' };
    if (shouldStop()) return { restarts, stoppedReason: 'signal' };
    if (restart.delayMs > 0) {
      log({ event: 'backoff', at: new Date().toISOString(), delayMs: restart.delayMs, consecutiveCrashes });
      await sleep(restart.delayMs);
    }
  }
}

// ── IO SHELL (runs only as a CLI — owns all child_process / fs; keeps the pure core effect-free) ─────────────

/** Build the real `spawnChild` effect: spawn `runner.mjs` (stdio inherited, so its own status lines/notes flow
 *  straight through to wherever the supervisor's output goes — a terminal, or a launchd log file), resolve once
 *  it exits with the raw exit facts. `onChild` hands the live handle out so the shutdown path can signal it —
 *  the ONLY reason a handle escapes this function. Exported so the test suite can prove the spawn/kill/exit
 *  wiring against REAL child processes (a controllable `node -e` script, not `runner.mjs` itself) — the same
 *  reasoning `dispatch-spawn-live.test.mjs` gives for exercising a real subprocess path rather than a stub. */
export function makeRealSpawnChild({ runnerPath, extraArgs, onChild }) {
  return () => new Promise((resolveSpawn) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [runnerPath, ...extraArgs], { stdio: 'inherit' });
    onChild(child);
    child.on('exit', (code, signal) => { onChild(null); resolveSpawn({ code, signal, ranMs: Date.now() - startedAt }); });
    child.on('error', (e) => { onChild(null); resolveSpawn({ code: null, signal: null, ranMs: Date.now() - startedAt, spawnError: String((e && e.message) || e) }); });
  });
}

/** Build the real `log` effect: append one JSONL line under the runner's own lock root (the established
 *  convention for where this runner's local, machine-disposable state lives — RUNNER_LOCK_ROOT, memory rule
 *  105), alongside the lease dir rather than a third location. Mirrors the shape of the plateau-app drain
 *  daemon's action ledger (`.drain-daemon/history.jsonl`: one JSON object per line, one line per event) rather
 *  than inventing a new log format. Best-effort — a logging failure must never break the supervisor loop —
 *  and every line also rides stderr so a human tailing the process (or its launchd log) sees it live. Exported
 *  so the test suite can prove the append-and-never-throw contract against a real temp-dir file. */
export function makeJsonlLog(logPath) {
  return (entry) => {
    try { mkdirSync(dirname(logPath), { recursive: true }); appendFileSync(logPath, JSON.stringify(entry) + '\n'); }
    catch { /* observability only — never let a logging failure break the supervisor */ }
    process.stderr.write(`[conveyor-supervisor] ${JSON.stringify(entry)}\n`);
  };
}

/** Default JSONL log location: alongside the runner's own singleton-lease directory, never a third state root. */
export const DEFAULT_LOG_PATH = join(RUNNER_LOCK_ROOT, 'supervisor-history.jsonl');

function parseFlags(argv) {
  const flags = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return flags;
}

/** Coerce a flag value to a finite number, falling back when it is absent / bare (`true`) / non-numeric. */
function finiteOr(val, fallback) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

/** Flags this supervisor consumes itself — everything else on argv (e.g. `--interval-ms`, `--repo`, `--json`,
 *  `--once`, `--max-ticks`) is forwarded to the `runner.mjs` child verbatim, so the supervisor never has to
 *  learn a new copy of the runner's own flag surface. */
const OWN_FLAGS = new Set(['max-restarts', 'base-backoff-ms', 'max-backoff-ms', 'crash-threshold-ms', 'log-path']);

async function main(argv) {
  const flags = parseFlags(argv);
  const extraArgs = argv.filter((a) => {
    if (!a.startsWith('--')) return true;
    const key = a.slice(2).split('=')[0];
    return !OWN_FLAGS.has(key);
  });

  const HERE = dirname(fileURLToPath(import.meta.url));
  const RUNNER_PATH = join(HERE, 'runner.mjs');

  const logPath = typeof flags['log-path'] === 'string' ? flags['log-path'] : DEFAULT_LOG_PATH;
  const maxRestarts = finiteOr(flags['max-restarts'], Infinity);
  const baseBackoffMs = finiteOr(flags['base-backoff-ms'], DEFAULT_BASE_BACKOFF_MS);
  const maxBackoffMs = finiteOr(flags['max-backoff-ms'], DEFAULT_MAX_BACKOFF_MS);
  const crashThresholdMs = finiteOr(flags['crash-threshold-ms'], DEFAULT_CRASH_THRESHOLD_MS);

  const log = makeJsonlLog(logPath);
  let currentChild = null;
  let stopRequested = false;
  const spawnChild = makeRealSpawnChild({ runnerPath: RUNNER_PATH, extraArgs, onChild: (c) => { currentChild = c; } });

  // Shutdown: SIGTERM first (runner.mjs gets a chance to run its own driveConveyor `finally` — release the
  // singleton lease — same as the pattern drain-daemon's releaseAndExit uses on ITS child), SIGKILL only if it
  // hangs on past a grace window. Never leaves the child running once the supervisor itself is gone — the
  // orphan a bare `process.exit()` here would otherwise create.
  const shutdown = (signal) => {
    if (stopRequested) return; // a second signal shouldn't double-log or re-kill an already-dying child
    stopRequested = true;
    log({ event: 'shutdown', at: new Date().toISOString(), signal });
    if (currentChild) {
      const child = currentChild;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already exited cleanly */ } }, 5_000).unref();
    }
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(sig));

  const result = await runSupervisorLoop({
    spawnChild, log, sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    maxRestarts, shouldStop: () => stopRequested, baseBackoffMs, maxBackoffMs, crashThresholdMs,
  });
  log({ event: 'stopped', at: new Date().toISOString(), reason: result.stoppedReason, restarts: result.restarts });
  process.exit(0);
}

// Run the IO shell only when invoked directly — never on import (keeps the pure core side-effect-free).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`✗ supervisor error: ${String((e && e.stack) || e)}\n`); process.exit(1); });
}
