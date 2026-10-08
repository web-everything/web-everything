#!/usr/bin/env node
/**
 * @file skills-src/conveyor/supervisor.mjs
 * @description The conveyor headless runner's RESIDENT SUPERVISOR — the last piece that makes
 *   {@link ./runner.mjs} self-sustaining. `runner.mjs` already owns the hard parts: the tick loop, the
 *   singleton lease, dispatch, and the deterministic mechanical passes. It runs until told to stop (idle-stop,
 *   a spent tick budget, or losing its lease) and then EXITS — nothing today restarts it, so an idle-stop or a
 *   crash just leaves the conveyor undriven until a human notices and relaunches it by hand. This file is that
 *   missing "keep it running" layer: spawn `runner.mjs` as a child, wait for it to exit, log what happened,
 *   back off if it keeps crashing, and repeat until the supervisor itself is told to stop — plus (#3398) tell a
 *   HUMAN, out-of-band, when either of those things goes on long enough to matter. A blind independent design
 *   review of this epic flagged the absence of that as its highest-priority open gap: a real dispatch sat
 *   `blocked` for days with nobody told, because the restart/backoff loop below self-heals a crash but reports
 *   nowhere, and a runner that keeps ticking-but-stuck (alive, not crashed) never even reaches that loop.
 *
 * SCOPED DELIBERATELY NARROW, unlike its precedent. `plateau-app/tools/drain-daemon/daemon.mjs` (the sibling
 *   resident-process pattern this file follows, #3398 included — its own `detectAnomalies`/`decideAlert`/
 *   desktop-notification shape, #2489/#2493) is ~360 lines because a drain SWEEP is itself a complex,
 *   multi-phase operation (clone refresh, a push/nudge seam, an operator pause flag) that the daemon layer
 *   owns. A conveyor tick has no analogue to most of that — `runner.mjs` already IS the tested, singleton-locked
 *   "do the work" loop. So this file answers two questions, repeatedly: the child exited — restart it now, or
 *   back off first? And: has either failure mode gone on long enough that a person needs to know? Everything
 *   else (guards, dispatch, the lease) stays runner.mjs's job.
 *
 * PURE-CORE / IO-SHELL SPLIT (mirrored from runner.mjs's own header, which mirrors tick-core.mjs's):
 *   • The PURE core ({@link classifyExit}, {@link decideRestart}, {@link runSupervisorLoop},
 *     {@link detectSupervisorAnomalies}, {@link healthFromAnomalies}, {@link decideAlert}) has NO child_process
 *     / fs / clock of its own — every effect (spawning the child, sleeping, logging) is INJECTED, so the whole
 *     restart/backoff/alert decision is unit-tested with fakes (skills-src/conveyor/__tests__/supervisor.test.mjs)
 *     — no real runner.mjs, no real lease, no real `osascript`.
 *   • The IO SHELL (`main()`, gated on the direct-invocation check) actually spawns
 *     `node skills-src/conveyor/runner.mjs --json [flags]`, forwards SIGINT/SIGTERM to it so a stopped
 *     supervisor never leaves an orphaned runner child behind, appends the JSONL log, and (#3398) fires a
 *     best-effort desktop notification when the pure core's alert decision says to.
 */

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RUNNER_LOCK_ROOT } from './runner-lock.mjs';
import { gateAlert } from '../../scripts/lib/quiet-hours-io.mjs';

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

/** #3406 — backoff base + ceiling for consecutive IDLE-STOP respawns, DISTINCT from the crash backoff above.
 *  Before this fix, `assessIdleStop` (`../../scripts/conveyor/tick-core.mjs`) reads wall-clock time since the
 *  operator last acted — a fact a fresh respawn does NOT reset — so a freshly-respawned runner idle-stops on
 *  its very FIRST tick again once the operator has been away past the idle window, and `decideRestart` gave
 *  every clean exit `delayMs: 0`: spawn → tick-once → idle-stop → exit(0) → immediate respawn, a genuine
 *  busy-loop bounded only by process-launch speed, for as long as the conveyor is legitimately idle (i.e.
 *  potentially most of the time between operator sessions). The cap (15 min) matches
 *  `DEFAULT_IDLE_WINDOW_MS` (`../../scripts/conveyor/tick-core.mjs`) deliberately: it bounds how stale the
 *  queue can get before the conveyor notices new work again to roughly the SAME window the runner itself
 *  already waited before idle-stopping in the first place, not an arbitrarily longer one. */
export const DEFAULT_IDLE_BASE_BACKOFF_MS = 30_000;
export const DEFAULT_IDLE_MAX_BACKOFF_MS = 900_000;

/**
 * Classify one child exit as `'clean'` (an ordinary stop — idle-stop, or a polite stand-down because another
 * runner legitimately holds the singleton lease; both exit `runner.mjs` with code 0, see its `main()`) or
 * `'crash'` (a non-zero exit, death by signal, or a suspiciously fast exit that suggests a crash-loop even at
 * code 0). Pure — takes the raw exit facts, decides nothing about WHEN to restart (that's {@link decideRestart}).
 *
 * #3406 — `stoppedReason` (parsed by `makeRealSpawnChild` off `runner.mjs`'s own final `--json` line: `{event:
 * 'stopped', stoppedReason}` or `{event: 'stood-down'}`) is what tells idle-stop and stand-down apart; BOTH
 * were previously indistinguishable `{kind:'clean', reason:'exit:0'}`. Its absence (an older runner, or a
 * non-JSON run) degrades to the old `'exit:0'` reason, never to a wrong classification — the two callers of
 * this fact (`decideRestart`'s idle-stop backoff below) treat an unset/unknown reason exactly like the
 * genuinely-prompt cases (stand-down, max-ticks, lease-lost), which is the SAFE direction: mis-reading an
 * idle-stop as "some other clean exit" only means the busy-loop this card exists to fix is not slowed down
 * for THAT one run, never that a stand-down is wrongly delayed.
 * @returns {{ kind: 'clean'|'crash', reason: string }}
 */
export function classifyExit({ code = null, signal = null, ranMs = 0, stoppedReason = null } = {}, { crashThresholdMs = DEFAULT_CRASH_THRESHOLD_MS } = {}) {
  if (signal) return { kind: 'crash', reason: `signal:${signal}` };
  if (code !== 0) return { kind: 'crash', reason: `exit:${code}` };
  if (ranMs < crashThresholdMs) return { kind: 'crash', reason: 'too-short' };
  if (stoppedReason === 'idle-stop') return { kind: 'clean', reason: 'idle-stop' };
  if (stoppedReason === 'stand-down') return { kind: 'clean', reason: 'stand-down' };
  return { kind: 'clean', reason: 'exit:0' };
}

/**
 * Decide the delay before the NEXT spawn, and the new consecutive-crash / consecutive-idle-stop streaks, from
 * one classified exit. A `'crash'` grows ITS streak and doubles the delay (capped), exactly the drain-daemon
 * `decideNextDelaySec` shape, simplified: no exit-3-style fixed-ceiling special case, because unlike a
 * globally-red `main` (an operator-only fix), no conveyor-runner crash mode is known in advance to be
 * unrecoverable — every crash gets the same doubling treatment.
 *
 * #3406 — a repeated `'idle-stop'` clean exit grows its OWN separate streak/backoff, the SAME doubling shape
 * but with its own (much larger) base/ceiling — this is what stops the busy-loop described at
 * {@link DEFAULT_IDLE_BASE_BACKOFF_MS}'s own doc comment. EVERY OTHER clean exit (`'stand-down'`, `'exit:0'`
 * covering max-ticks / lease-lost / an unknown reason) restarts with NO delay, exactly as before — a stand-
 * down in particular MUST stay prompt: another runner already holds the singleton right, so there is nothing
 * to back off from, and slowing it down would only delay this process taking over once that runner is truly
 * gone. Both streaks are mutually exclusive (each classification resets the OTHER to 0): a crash after a run
 * of idle-stops is not "on top of" that idle backoff, and vice versa.
 * @returns {{ delayMs: number, consecutiveCrashes: number, consecutiveIdleStops: number }}
 */
export function decideRestart({ classification, consecutiveCrashes = 0, consecutiveIdleStops = 0 } = {}, {
  baseBackoffMs = DEFAULT_BASE_BACKOFF_MS, maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  idleBaseBackoffMs = DEFAULT_IDLE_BASE_BACKOFF_MS, idleMaxBackoffMs = DEFAULT_IDLE_MAX_BACKOFF_MS,
} = {}) {
  if (classification && classification.kind === 'crash') {
    const crashes = consecutiveCrashes + 1;
    const delayMs = Math.min(baseBackoffMs * 2 ** (crashes - 1), maxBackoffMs);
    return { delayMs, consecutiveCrashes: crashes, consecutiveIdleStops: 0 };
  }
  if (classification && classification.kind === 'clean' && classification.reason === 'idle-stop') {
    const stops = consecutiveIdleStops + 1;
    const delayMs = Math.min(idleBaseBackoffMs * 2 ** (stops - 1), idleMaxBackoffMs);
    return { delayMs, consecutiveCrashes: 0, consecutiveIdleStops: stops };
  }
  return { delayMs: 0, consecutiveCrashes: 0, consecutiveIdleStops: 0 };
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
 * @param {number} [effects.idleBaseBackoffMs]  #3406 — base delay for a repeated idle-stop respawn
 * @param {number} [effects.idleMaxBackoffMs]   #3406 — ceiling for the idle-stop backoff, distinct from the crash ceiling
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
  idleBaseBackoffMs = DEFAULT_IDLE_BASE_BACKOFF_MS,
  idleMaxBackoffMs = DEFAULT_IDLE_MAX_BACKOFF_MS,
  crashThresholdMs = DEFAULT_CRASH_THRESHOLD_MS,
} = {}) {
  if (typeof spawnChild !== 'function') throw new TypeError('runSupervisorLoop requires a spawnChild effect');
  let consecutiveCrashes = 0;
  let consecutiveIdleStops = 0;
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
    const restart = decideRestart(
      { classification, consecutiveCrashes, consecutiveIdleStops },
      { baseBackoffMs, maxBackoffMs, idleBaseBackoffMs, idleMaxBackoffMs },
    );
    consecutiveCrashes = restart.consecutiveCrashes;
    consecutiveIdleStops = restart.consecutiveIdleStops;
    if (attempt >= maxRestarts) return { restarts, stoppedReason: 'max-restarts' };
    if (shouldStop()) return { restarts, stoppedReason: 'signal' };
    if (restart.delayMs > 0) {
      // #3406 — `kind` distinguishes a CRASH backoff from an IDLE-STOP backoff on the log entry itself: the two
      // now have independent ceilings (`maxBackoffMs` vs `idleMaxBackoffMs`, the latter deliberately LARGER),
      // so `trailingCeilingBackoffRun`'s crash-loop-at-ceiling alert (#3398) must not mistake a sustained
      // idle-stop backoff (whose `delayMs` legitimately grows past `maxBackoffMs` on its way to its own,
      // higher ceiling) for a crash-looping runner.
      log({
        event: 'backoff', at: new Date().toISOString(), delayMs: restart.delayMs,
        kind: restart.consecutiveIdleStops > 0 ? 'idle-stop' : 'crash',
        consecutiveCrashes, consecutiveIdleStops,
      });
      await sleep(restart.delayMs);
    }
  }
}

// ── out-of-band alerting (#3398) ────────────────────────────────────────────────────────────────────────────
// The restart/backoff loop above self-heals a crashed runner and a stuck-but-alive one keeps ticking — either
// way, nothing today tells a HUMAN. A blind independent design review of this epic flagged this as the
// highest-priority open gap: a real dispatch sat `blocked` for days with nobody told (#3383's own follow-up
// section). Mirrors the sibling resident-process precedent (`plateau-app/tools/drain-daemon/lib.mjs`'s
// `detectAnomalies`/`decideAlert`, #2489/#2493) — same shape, reimplemented locally (a sibling repo's own
// package, not importable) against THIS process's own two failure modes, not the drain's.

/** A crash-loop that has REACHED the backoff ceiling once is worth a first "go look" (warn); one that is STILL
 *  there `CRASH_CEILING_CRIT_COUNT` crashes later — nothing about the fault self-healed — is the "days blocked"
 *  case this card exists for (critical). Counted from the log's own `backoff` events, so no extra bookkeeping
 *  is needed: `decideRestart` already only logs a `backoff` when it plateaus, and a `delayMs` at the configured
 *  ceiling is directly comparable across restarts of the supervisor itself (the ceiling is a constant, not a
 *  measured value). */
export const CRASH_CEILING_WARN_COUNT = 1;
export const CRASH_CEILING_CRIT_COUNT = 3;

/** "Idle with a non-empty queue" — the runner is still ticking (not crashed, not idle-stopped) yet
 *  `decisions.counts.queued` (tick-core's own tally, #3398) stays above zero while nothing gets dispatched, tick
 *  after tick: capacity should have picked something up and didn't. Thresholds are in TICKS, scaled off the
 *  runner's own ~120s cadence ({@link ../runner.mjs}'s `DEFAULT_TICK_INTERVAL_MS`) the same way the drain-daemon
 *  precedent scales its STALL_WARN/CRIT off its own 60s pass cadence — proportionally similar wall-clock
 *  (~16 min / ~40 min) at double the drain's per-cycle interval, so half as many cycles are needed. */
export const IDLE_QUEUE_WARN_TICKS = 8;
export const IDLE_QUEUE_CRIT_TICKS = 20;

/** The trailing run of consecutive CRASH `backoff` log entries whose `delayMs` is AT the crash ceiling — i.e.
 *  crashes that kept happening after backoff had nothing left to escalate. Walks the FULL log backward (not
 *  just `backoff` entries) so a `spawn`/`exit` in between does not break the run (those always sit between
 *  two `backoff` entries in a real crash-loop) — only a NON-ceiling CRASH `backoff` (or the absence of one)
 *  ends it. #3406 — an IDLE-STOP backoff entry (`kind: 'idle-stop'`) ALSO ends the run, even though it shares
 *  the same `event: 'backoff'` shape: its `delayMs` can legitimately grow past the crash ceiling on its way to
 *  its OWN, separate, higher ceiling (`DEFAULT_IDLE_MAX_BACKOFF_MS`), and mistaking that for more crash-loop
 *  ceiling hits would false-positive this alert on a conveyor that is merely sitting idle, not crash-looping.
 *  `kind` absent (an older log line, before #3406) reads as `'crash'` — the pre-existing behaviour for every
 *  log this alert has ever seen before this fix. Pure. */
function trailingCeilingBackoffRun(history, maxBackoffMs) {
  const src = Array.isArray(history) ? history : [];
  let count = 0;
  let since = null;
  for (let i = src.length - 1; i >= 0; i--) {
    const h = src[i];
    if (!h || typeof h !== 'object' || h.event !== 'backoff') continue;
    if ((h.kind ?? 'crash') !== 'crash') break;
    if (!(Number.isFinite(h.delayMs) && h.delayMs >= maxBackoffMs)) break;
    count++;
    since = h.at || since;
  }
  return { count, since };
}

/** The trailing run of consecutive `tick` log entries belonging to the CURRENTLY-LIVE child (the walk stops the
 *  instant it hits anything other than a matching `tick` — including the `spawn` that started this run, or an
 *  `exit`, which means the process already died and this is not "idle while alive") where the queue was
 *  non-empty and nothing was dispatched. Pure. */
function trailingIdleQueuedRun(history) {
  const src = Array.isArray(history) ? history : [];
  let count = 0;
  let since = null;
  for (let i = src.length - 1; i >= 0; i--) {
    const h = src[i];
    if (!h || typeof h !== 'object' || h.event !== 'tick') break;
    const queued = h.counts && Number.isFinite(h.counts.queued) ? h.counts.queued : 0;
    const dispatched = Number.isFinite(h.dispatchedTotal) ? h.dispatchedTotal : 0;
    if (!(queued > 0 && dispatched === 0)) break;
    count++;
    since = h.at || since;
  }
  return { count, since };
}

/** Detect the supervisor's two named "stuck" conditions from its OWN JSONL history (an in-memory tail is
 *  sufficient — see `RECENT_CAP` in the IO shell below). Returns the same `{ type, severity, since, detail,
 *  evidence }` row shape as the drain-daemon precedent. PURE, defensive, never throws. */
export function detectSupervisorAnomalies({ history = [], maxBackoffMs = DEFAULT_MAX_BACKOFF_MS } = {}) {
  const anomalies = [];

  const ceiling = trailingCeilingBackoffRun(history, maxBackoffMs);
  if (ceiling.count >= CRASH_CEILING_WARN_COUNT) {
    anomalies.push({
      type: 'crash-loop-at-ceiling',
      severity: ceiling.count >= CRASH_CEILING_CRIT_COUNT ? 'critical' : 'warn',
      since: ceiling.since,
      detail: `the runner has crash-looped to its backoff ceiling ${ceiling.count} time(s) in a row with no intervening healthy run`,
      evidence: { ceilingHits: ceiling.count, maxBackoffMs },
    });
  }

  const idle = trailingIdleQueuedRun(history);
  if (idle.count >= IDLE_QUEUE_WARN_TICKS) {
    anomalies.push({
      type: 'idle-with-queue',
      severity: idle.count >= IDLE_QUEUE_CRIT_TICKS ? 'critical' : 'warn',
      since: idle.since,
      detail: `the runner has ticked ${idle.count} time(s) with a non-empty queue but dispatched nothing`,
      evidence: { idleTicks: idle.count },
    });
  }

  const rank = { critical: 0, error: 1, warn: 2, info: 3 };
  anomalies.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
  return anomalies;
}

/** Roll a list of anomalies up to ONE health verdict — worst active severity wins. Pure. Mirrors the
 *  drain-daemon precedent's `healthFromAnomalies` naming/shape exactly. */
export function healthFromAnomalies(anomalies = []) {
  const a = Array.isArray(anomalies) ? anomalies : [];
  if (a.some((x) => x && (x.severity === 'critical' || x.severity === 'error'))) return 'stuck';
  if (a.some((x) => x && x.severity === 'warn')) return 'degraded';
  return 'healthy';
}

/** How long a still-standing (same-health) condition stays quiet before it re-nags — 30 min, matching the
 *  drain-daemon precedent's own `ALERT_RENAG_MS` exactly (the reasoning is identical: don't re-notify a
 *  still-stuck process every restart/tick). */
export const ALERT_RENAG_MS = 30 * 60 * 1000;

/** Decide whether a degraded/stuck verdict warrants firing a desktop alert THIS time, given the last alert
 *  persisted (cross-restart de-dup — `lastAlert` is read from disk, not memory, because a crash-looping
 *  supervisor process itself would otherwise re-fire on every restart). Same de-dup shape as the drain-daemon
 *  precedent: keyed on the health VERDICT alone (coarse "go look" ping, no anomaly-type churn re-firing it every
 *  check). PURE + defensive. */
export function decideAlert({ health = 'healthy', anomalies = [], lastAlert = null, nowMs = Date.now(), renagMs = ALERT_RENAG_MS } = {}) {
  if (typeof health !== 'string' || health === 'healthy') return { fire: false, record: null };
  const types = [...new Set((Array.isArray(anomalies) ? anomalies : [])
    .map((a) => (a && typeof a.type === 'string' ? a.type : null))
    .filter(Boolean))].sort();
  const signature = health;
  const prev = lastAlert && typeof lastAlert === 'object' ? lastAlert : null;
  const changed = !prev || prev.signature !== signature;
  const prevAt = prev ? Date.parse(prev.at) : NaN;
  const stale = !!prev && Number.isFinite(prevAt) && nowMs - prevAt >= renagMs;
  if (!(changed || stale)) return { fire: false, record: null };
  return {
    fire: true,
    record: { at: new Date(nowMs).toISOString(), health, signature, summary: `${types.length} anomaly(ies): ${types.join(', ')}`, types },
  };
}

// ── IO SHELL (runs only as a CLI — owns all child_process / fs; keeps the pure core effect-free) ─────────────

/** Build the real `spawnChild` effect: spawn `runner.mjs` (stderr inherited so mechanical-pass warnings still
 *  reach wherever the supervisor's own output goes), resolve once it exits with the raw exit facts. `onChild`
 *  hands the live handle out so the shutdown path can signal it. Exported so the test suite can prove the
 *  spawn/kill/exit wiring against REAL child processes (a controllable `node -e` script, not `runner.mjs`
 *  itself) — the same reasoning `dispatch-spawn-live.test.mjs` gives for exercising a real subprocess path
 *  rather than a stub.
 *
 *  Stdout is PIPED, not inherited (#3398): the runner is always launched with `--json` (see `main()`) so each
 *  stdout line is one tick's `{tick, ...surface}` object — parsed here and handed to `onTickLine` (the
 *  alerting detector's raw material) — and ALSO mirrored to this process's own stdout unparsed, so a human
 *  tailing the supervisor still sees exactly what they saw before this change. A line that fails to parse (or
 *  arrives split across chunks — `readline` handles that) is mirrored and otherwise ignored; a malformed tick
 *  line must never crash the supervisor. */
export function makeRealSpawnChild({ runnerPath, extraArgs, onChild, onTickLine = () => {} }) {
  return () => new Promise((resolveSpawn) => {
    const startedAt = Date.now();
    // #3406 — captured off the runner's own final `--json` line (`{event:'stopped', stoppedReason}` or
    // `{event:'stood-down'}`, `runner.mjs`'s `main()`), so `classifyExit` can tell a genuine idle-stop apart
    // from a polite stand-down — both exit code 0 and were previously indistinguishable from this side.
    let stoppedReason = null;
    const child = spawn(process.execPath, [runnerPath, ...extraArgs], { stdio: ['ignore', 'pipe', 'inherit'] });
    onChild(child);
    createInterface({ input: child.stdout }).on('line', (line) => {
      process.stdout.write(line + '\n');
      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== 'object') return;
        if (Number.isFinite(parsed.tick)) { onTickLine(parsed); return; }
        if (parsed.event === 'stopped') stoppedReason = parsed.stoppedReason || null;
        else if (parsed.event === 'stood-down') stoppedReason = 'stand-down';
      } catch { /* not a tick/stopped line (or malformed) — mirrored above; never fatal */ }
    });
    // `close`, not `exit`: `exit` can fire before the piped stdout is drained, dropping the final
    // `{event:'stopped'|'stood-down'}` line and leaving `stoppedReason` null (a CI flake, PR #2685).
    child.on('close', (code, signal) => { onChild(null); resolveSpawn({ code, signal, ranMs: Date.now() - startedAt, stoppedReason }); });
    child.on('error', (e) => { onChild(null); resolveSpawn({ code: null, signal: null, ranMs: Date.now() - startedAt, stoppedReason, spawnError: String((e && e.message) || e) }); });
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

/** Persisted last-alert record (#3398) — its OWN small file, not folded into the JSONL log: de-dup needs to
 *  read back exactly one record fast on every event, and a resident process's log only ever grows. Mirrors the
 *  drain-daemon precedent's separate `ALERT_STATE_PATH` for the same reason. */
export const DEFAULT_ALERT_STATE_PATH = join(RUNNER_LOCK_ROOT, 'supervisor-alert-state.json');

/** How many recent log entries the in-memory alerting ring keeps (#3398) — bounds a resident process's memory
 *  the same way the drain-daemon precedent's `RECENT_CAP` does. Generous headroom over both detectors' own
 *  windows (`IDLE_QUEUE_CRIT_TICKS` ticks, a handful of spawn/exit/backoff triples per crash-loop entry). */
export const ALERT_HISTORY_CAP = 200;

/** Wrap a string as a double-quoted AppleScript literal — identical escaping to the drain-daemon precedent's
 *  own `q()`. */
function q(s) { return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }

/** Best-effort desktop notification (#3398, mirrors #2493's drain-daemon precedent). macOS-only (`osascript`);
 *  a no-op elsewhere, and a spawn failure must never break the supervisor loop. */
function notifyDesktop(notification) {
  // quietHours (card xmvc6oc): held overnight unless it is an emergency; see we:scripts/lib/quiet-hours-io.mjs.
  const send = ({ title, body }) => {
    if (process.platform !== 'darwin') return { ok: false };
    try { spawn('osascript', ['-e', `display notification ${q(body)} with title ${q(title)}`], { stdio: 'ignore', detached: true }).unref(); return { ok: true }; }
    catch { return { ok: false }; /* best-effort — never let a notification failure break the supervisor */ }
  };
  try { gateAlert(notification, { send }); } catch { /* best-effort */ }
}

/** Build the `maybeAlert` IO-shell glue: re-detect anomalies over the in-memory ring, decide whether to fire
 *  (persisted cross-restart de-dup), and — if so — notify + persist + log. Mirrors the drain-daemon precedent's
 *  own `maybeAlert` shape: the ENTIRE body is swallowed on any throw, because alerting is observability, never
 *  supervisor correctness. */
function makeMaybeAlert({ ring, maxBackoffMs, alertStatePath, log }) {
  return () => {
    try {
      const anomalies = detectSupervisorAnomalies({ history: ring, maxBackoffMs });
      const health = healthFromAnomalies(anomalies);
      let lastAlert = null;
      try { lastAlert = JSON.parse(readFileSync(alertStatePath, 'utf8')); } catch { /* none / garbage → null */ }
      const { fire, record } = decideAlert({ health, anomalies, lastAlert, nowMs: Date.now() });
      if (!fire) return;
      notifyDesktop({ title: `Conveyor supervisor: ${record.health}`, body: record.summary });
      try { mkdirSync(dirname(alertStatePath), { recursive: true }); writeFileSync(alertStatePath, JSON.stringify(record, null, 2) + '\n'); } catch { /* best-effort */ }
      log({ event: 'alert', at: record.at, health: record.health, summary: record.summary, types: record.types });
    } catch { /* alerting is observability only — never let it break the supervisor */ }
  };
}

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
const OWN_FLAGS = new Set([
  'max-restarts', 'base-backoff-ms', 'max-backoff-ms', 'crash-threshold-ms', 'log-path', 'alert-state-path',
  'idle-base-backoff-ms', 'idle-max-backoff-ms', // #3406
]);

async function main(argv) {
  const flags = parseFlags(argv);
  const extraArgs = argv.filter((a) => {
    if (!a.startsWith('--')) return true;
    const key = a.slice(2).split('=')[0];
    return !OWN_FLAGS.has(key);
  });
  // #3398 — always run the child with `--json`: the alerting detector below needs each tick's structured
  // surface (`counts.queued`, what got dispatched), and `makeRealSpawnChild` already mirrors every stdout line
  // through unparsed, so a human loses nothing by this always being on under the supervisor.
  if (!extraArgs.some((a) => a === '--json' || a.startsWith('--json='))) extraArgs.push('--json');

  const HERE = dirname(fileURLToPath(import.meta.url));
  const RUNNER_PATH = join(HERE, 'runner.mjs');

  const logPath = typeof flags['log-path'] === 'string' ? flags['log-path'] : DEFAULT_LOG_PATH;
  const alertStatePath = typeof flags['alert-state-path'] === 'string' ? flags['alert-state-path'] : DEFAULT_ALERT_STATE_PATH;
  const maxRestarts = finiteOr(flags['max-restarts'], Infinity);
  const baseBackoffMs = finiteOr(flags['base-backoff-ms'], DEFAULT_BASE_BACKOFF_MS);
  const maxBackoffMs = finiteOr(flags['max-backoff-ms'], DEFAULT_MAX_BACKOFF_MS);
  const idleBaseBackoffMs = finiteOr(flags['idle-base-backoff-ms'], DEFAULT_IDLE_BASE_BACKOFF_MS);
  const idleMaxBackoffMs = finiteOr(flags['idle-max-backoff-ms'], DEFAULT_IDLE_MAX_BACKOFF_MS);
  const crashThresholdMs = finiteOr(flags['crash-threshold-ms'], DEFAULT_CRASH_THRESHOLD_MS);

  const baseLog = makeJsonlLog(logPath);
  // #3398 — the in-memory alerting ring + the composite `log` every effect below actually uses: append to the
  // real JSONL (unchanged behaviour), then feed the SAME entry to the anomaly detector. Capped so a
  // weeks-resident process never grows this array unbounded (mirrors the drain-daemon precedent's own
  // `recentEntries` ring).
  const ring = [];
  const maybeAlert = makeMaybeAlert({ ring, maxBackoffMs, alertStatePath, log: baseLog });
  const log = (entry) => {
    baseLog(entry);
    ring.push(entry);
    if (ring.length > ALERT_HISTORY_CAP) ring.shift();
    maybeAlert();
  };

  let currentChild = null;
  let stopRequested = false;
  const onTickLine = (parsed) => {
    const d = parsed.dispatch || {};
    const dispatchedTotal = ['builds', 'prepareScope', 'prepareDecision', 'fixes', 'ciHeals']
      .reduce((sum, k) => sum + (Array.isArray(d[k]) ? d[k].length : 0), 0);
    log({ event: 'tick', at: new Date().toISOString(), tick: parsed.tick, counts: parsed.counts || null, dispatchedTotal });
  };
  const spawnChild = makeRealSpawnChild({ runnerPath: RUNNER_PATH, extraArgs, onChild: (c) => { currentChild = c; }, onTickLine });

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
    maxRestarts, shouldStop: () => stopRequested,
    baseBackoffMs, maxBackoffMs, idleBaseBackoffMs, idleMaxBackoffMs, crashThresholdMs,
  });
  log({ event: 'stopped', at: new Date().toISOString(), reason: result.stoppedReason, restarts: result.restarts });
  process.exit(0);
}

// Run the IO shell only when invoked directly — never on import (keeps the pure core side-effect-free).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`✗ supervisor error: ${String((e && e.stack) || e)}\n`); process.exit(1); });
}
