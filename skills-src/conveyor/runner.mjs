#!/usr/bin/env node
/**
 * @file skills-src/conveyor/runner.mjs
 * @description The conveyor HEADLESS RUNNER (WE #2702, epic #2677(b), the DELEGATE half) — a SINGLETON-LOCKED,
 *   no-LLM runner that drives the mechanized tick core ({@link ../../scripts/conveyor/tick-core.mjs}, #2699)
 *   for the conveyor. It reads state and STEPS the tested state machine — it spends NO model context per tick
 *   (memory rule / #2701 clause 1): every guard, TTL, re-dispatch gate, watcher-arm, and idle-stop decision is
 *   the tick core's, applied deterministically; the runner is a THIN SHELL that threads the core's `nextState`
 *   into the next tick UNCHANGED and SURFACES the tick's decisions. It never re-derives a guard rule.
 *
 * WHAT #2701 SETTLES (the ratified mechanics-not-agent boundary, codified at
 *   [we:docs/agent/platform-decisions.md#conveyor-orchestration-mechanics-not-per-lane-agent]):
 *   1. The per-lane driver is a headless runner over the tested tick-core state machine — no per-tick model
 *      context. THIS file is that runner.
 *   2. NO per-lane conducting agent (Option B rejected) — so this is ONE singleton-locked runner, not an
 *      always-on LLM conductor per lane. The singleton right is held by {@link ./runner-lock.mjs}.
 *   3. A single supervisor is deferred (Option C) and genuine NOVELTY escalates to the main-session judgment
 *      layer — the runner never improvises a ruling. So the runner EMITS its dispatch/watch decisions
 *      ({@link tickSurface}) for the judgment layer to execute; it does not itself spawn LLM delivery agents.
 *
 * SCOPE (#2702, NOT #2703): this builds the runner MECHANISM — the singleton lock + the loop that steps the
 *   core, carries bookkeeping, runs the deterministic no-LLM passes (infra-blocked recovery §4b, lease-reaper
 *   §4c), and surfaces the tick. It does NOT retire the main-session serial loop (that is #2703, blocked on
 *   this) and does NOT wire headless LLM agent-spawning (the CLI agent-runner backend,
 *   [#agent-runner-cli-backend]) — both belong to the retirement slice. The guard SEMANTICS are PRESERVED
 *   verbatim: they live in the tick core; the runner alters none of them.
 *
 * PURE-CORE / IO-SHELL SPLIT (the hard design constraint, mirrored from tick-core.mjs):
 *   • The PURE core ({@link carryForward}, {@link shouldStop}, {@link tickSurface}, {@link runLoop}) has NO
 *     fs / child_process / clock of its own — every effect (stepping a tick, dispatching, the mechanical
 *     passes, emitting, heartbeating the lease, sleeping) is INJECTED. `runLoop` is the runner's whole control
 *     flow, unit-tested (skills-src/conveyor/__tests__/runner.test.mjs) with fake effects — no git/network, no
 *     real lease, no `claude` process.
 *   • The IO SHELL (the `main()` CLI + the `cli*` effect builders, gated on the main-module check) shells
 *     `tick-core.mjs` (bookkeeping in on STDIN, `{ decisions, nextState }` out), calls `dispatch-lane` for each
 *     surfaced decision (#3383), runs the two deterministic passes, prints the surface, and heartbeats the
 *     real singleton lease.
 *
 * #3383 — WHAT CHANGED FROM "THREADS `nextState` FORWARD UNCHANGED". The runner still never re-derives a
 * guard — that invariant is intact. But it is no longer accurate to say it carries THIS tick's own
 * `nextState` forward byte-identical: `dispatchPass` (below) calls `dispatch-lane` once per surfaced
 * decision, and EACH call runs its OWN nested `tick-core` read, which is where a newly-dispatched item's
 * guard entry actually gets ADDED to `nextState` — a fact the runner's own top-level tick read (made BEFORE
 * any dispatching happens) cannot know. Carrying that stale copy forward instead of the dispatch pass's own
 * updated one would make the runner's bookkeeping silently drift from what actually got dispatched: the same
 * item would re-surface and get RE-INVOKED every tick for its whole build lifetime, forever — not a second
 * live agent (dispatch-lane's OWN double-dispatch guard still catches that), but a wasted subprocess spawn
 * every ~120s for as long as anything is building. So `runLoop` now carries forward the DISPATCH PASS's
 * `nextState` when one ran, not the raw tick read's — still the tick core's own answer, just the latest one,
 * and still nothing the runner computed itself.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  RUNNER_LOCK_ROOT, runnerOwner,
  acquireRunnerLease, heartbeatRunnerLease, releaseRunnerLeaseIfOwned,
} from './runner-lock.mjs';

/** The runner's tick interval — matches the SKILL's chained-sleep heartbeat (§2.5): ~120 s, just under the
 *  5-min prompt-cache window so a main-session loop's ticks stay cheap. The headless runner spends no model
 *  context, so the interval is only about how promptly it reacts to freed lanes / new PRs. */
export const DEFAULT_TICK_INTERVAL_MS = 120_000;

// ── PURE CORE (no IO — every effect is injected; unit-tested directly) ─────────────────────────────────────

/**
 * Build the NEXT tick's STDIN payload from THIS tick's output, threading `nextState` through UNCHANGED. This
 * is the thin-shell invariant made explicit: the runner carries the tick core's bookkeeping forward verbatim
 * — it never edits a guard, a TTL counter, or the watcher set (the core owns all of it). `signals` (e.g.
 * `returnedBuildNums`) are the ONLY thing the runner may add, and only from observed agent completions.
 * @returns {{ bookkeeping: object, signals: object }}
 */
export function carryForward(out, { signals = {} } = {}) {
  return { bookkeeping: (out && out.nextState) || {}, signals: signals || {} };
}

/**
 * Decide whether the loop STOPS after processing this tick. Two mechanical stop conditions, both from the core
 * (never re-derived): the core's `decisions.idleStop` (queue-empty AND no operator feedback for the window),
 * or a spent tick budget (`--max-ticks`, for a bounded/`--once` run). Pure — no clock.
 * @returns {{ stop: boolean, reason: string|null }}
 */
export function shouldStop(out, { tick = 0, maxTicks = Infinity } = {}) {
  if (out && out.decisions && out.decisions.idleStop) return { stop: true, reason: 'idle-stop' };
  if (Number.isFinite(maxTicks) && tick + 1 >= maxTicks) return { stop: true, reason: 'max-ticks' };
  return { stop: false, reason: null };
}

/**
 * The tick's SURFACE — exactly what the headless runner emits each tick. It spends no model context, so it
 * does NOT spawn the delivery / prepare / fix / CI-heal agents itself; it hands the core's already-filtered
 * decisions to the judgment layer to execute (#2701 clause 3), alongside the status line and per-tick notes.
 * A pure projection of `decisions` — it invents nothing and drops nothing.
 */
export function tickSurface(out) {
  const d = (out && out.decisions) || {};
  return {
    statusLine: d.statusLine || '',
    notes: Array.isArray(d.notes) ? d.notes : [],
    dispatch: {
      builds: Array.isArray(d.spawnBuilds) ? d.spawnBuilds : [],
      prepareScope: Array.isArray(d.spawnPrepareScope) ? d.spawnPrepareScope : [],
      prepareDecision: Array.isArray(d.spawnPrepareDecision) ? d.spawnPrepareDecision : [],
      fixes: Array.isArray(d.spawnFixes) ? d.spawnFixes : [],
      ciHeals: Array.isArray(d.spawnCiHeals) ? d.spawnCiHeals : [],
    },
    armWatchers: Array.isArray(d.armWatchers) ? d.armWatchers : [],
  };
}

/**
 * The runner's WHOLE control flow, as a reducer over injected effects — so it is unit-testable with fakes and
 * carries no IO of its own. Each tick: step the core (`tickOnce`), emit the surface, dispatch the surfaced
 * decisions (`dispatchPass`), run the deterministic mechanical passes, check stop, heartbeat the singleton
 * lease, sleep, then carry the DISPATCH PASS's `nextState` forward (see the file header, #3383, for why that
 * is not the same as this tick's own raw read). A lost lease (another process reclaimed a stale runner) STOPS
 * the loop — the singleton right to drive is gone.
 *
 * @param {object} effects
 * @param {(payload:object)=>Promise<object>|object} effects.tickOnce  step the tick core → `{ decisions, nextState }`
 * @param {(surface:object,ctx:object)=>any} [effects.emit]            surface the tick (status + notes + dispatch)
 * @param {(ctx:{tick:number,out:object})=>Promise<{nextState:object}>} [effects.dispatchPass]
 *   call `dispatch-lane` once per surfaced decision (#3383) and return the nextState after all of them —
 *   defaults to an identity pass-through (`out.nextState`, unchanged) so a caller with nothing to dispatch
 *   through pays no cost and needs no override.
 * @param {(ctx:object)=>any} [effects.mechanicalPasses]              run the no-LLM passes (§4b infra, §4c reaper)
 * @param {()=>boolean|Promise<boolean>} [effects.heartbeat]           extend the singleton lease; false ⇒ lost
 * @param {(ms:number)=>any} [effects.sleep]                           wait between ticks
 * @param {number} [effects.intervalMs]                                tick interval
 * @param {number} [effects.maxTicks]                                  bounded-run tick budget (Infinity = forever)
 * @param {object} [effects.initial]                                   first tick's STDIN payload (default `{}`)
 * @returns {Promise<{ ticks: number, stoppedReason: string, lastOut: object|null }>}
 */
export async function runLoop({
  tickOnce,
  emit = () => {},
  dispatchPass = async ({ out } = {}) => ({ nextState: (out && out.nextState) || {} }),
  mechanicalPasses = () => {},
  heartbeat = () => true,
  sleep = () => {},
  intervalMs = DEFAULT_TICK_INTERVAL_MS,
  maxTicks = Infinity,
  initial = {},
} = {}) {
  if (typeof tickOnce !== 'function') throw new TypeError('runLoop requires a tickOnce effect');
  let payload = initial || {};
  let tick = 0;
  let stoppedReason = 'unknown';
  let lastOut = null;
  // The loop stops on the core's idle-stop, a spent `maxTicks` budget, or a lost lease; a real run passes
  // `maxTicks: Infinity` and relies on idle / lease-loss to end it (a test always bounds it via `maxTicks`).
  for (;;) {
    const out = await tickOnce(payload);
    lastOut = out;
    await emit(tickSurface(out), { tick });

    // DISPATCH what this tick decided (#3383), BEFORE the mechanical passes — those are unrelated (infra
    // recovery, lease reaping) and neither reads nor produces `nextState`. Best-effort, same as
    // `mechanicalPasses` below: a dispatch failure must not wedge the loop. On a throw, `dispatched` keeps
    // its default (this tick's own raw `nextState`) — the same degraded-but-safe behaviour the runner had
    // before this pass existed, never worse.
    let dispatched = { nextState: (out && out.nextState) || {} };
    try { dispatched = await dispatchPass({ tick, out }); } catch { /* best-effort */ }

    // Best-effort deterministic passes — a throw here must never wedge the loop (mirrors the SKILL's §4b/§4c
    // "best-effort; its exit never gates the tick").
    try { await mechanicalPasses({ tick, out }); } catch { /* best-effort — a pass failure never stalls a tick */ }

    const stop = shouldStop(out, { tick, maxTicks });
    if (stop.stop) { stoppedReason = stop.reason; break; }

    // Extend the singleton lease BEFORE sleeping; if it was reclaimed away (this runner went stale), STOP — we
    // no longer hold the sole-driver right, and continuing would risk the double-dispatch the lock prevents.
    const alive = await heartbeat();
    if (!alive) { stoppedReason = 'lease-lost'; break; }

    await sleep(intervalMs);
    // No `signals` folded in: `dispatchPass` starts agents but does not WATCH them run to completion, so there
    // is still no `returnedBuildNums` to inject here — that remains a later slice. `nextState` DOES come from
    // the dispatch pass now, not the raw tick read — see the file header (#3383) for why carrying the stale
    // one forward would silently re-surface an already-dispatched item every tick.
    payload = carryForward({ ...out, nextState: dispatched.nextState }, {});
    tick += 1;
  }
  return { ticks: tick + 1, stoppedReason, lastOut };
}

// ── IO SHELL (runs only as a CLI — owns all child_process / real lease; keeps the pure core effect-free) ────

/** Build the real `tickOnce` effect: shell `tick-core.mjs`, pipe the bookkeeping payload in on STDIN, parse
 *  `{ decisions, nextState }` off STDOUT. This is the SAME core the main-session SKILL loop shells (§2b) — the
 *  runner and the SKILL can never disagree on a guard, because there is exactly ONE core. */
function makeCliTickOnce({ tickCorePath, repo = null }) {
  return async (payload) => {
    const { execFileSync } = await import('node:child_process');
    const args = [tickCorePath];
    if (typeof repo === 'string' && repo) args.push(`--repo=${repo}`);
    const out = execFileSync('node', args, {
      input: JSON.stringify(payload || {}),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(out);
  };
}

/** Build the real `mechanicalPasses` effect: the two deterministic, no-LLM passes the SKILL runs each tick —
 *  the infra-blocked recovery pass (§4b) and the lease-reaper (§4c). Both are best-effort: a failure is
 *  swallowed (logged to stderr) and never gates the tick. Never a local merge — the drain stays the sole
 *  writer to `main`. */
function makeCliMechanicalPasses({ scriptsDir, repo = null }) {
  return async () => {
    const { execFileSync } = await import('node:child_process');
    const runQuiet = (relPath, extraArgs = []) => {
      try {
        const args = [join(scriptsDir, relPath), ...extraArgs];
        if (typeof repo === 'string' && repo) args.push(`--repo=${repo}`);
        execFileSync('node', args, { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
      } catch (e) {
        process.stderr.write(`⚠ mechanical pass ${relPath} failed (non-fatal): ${String(e.message || e).split('\n')[0]}\n`);
      }
    };
    runQuiet('conveyor/infra-blocked.mjs', ['retry']);
    runQuiet('conveyor/lease-reaper.mjs');
  };
}

/**
 * Build the real `dispatchPass` effect (#3383): call `dispatch-lane` once per item this tick's core surfaced
 * — builds, then prepareScope, then prepareDecision, then fixes, then ciHeals ({@link tickSurface}'s own
 * order) — and hand back the bookkeeping after all of them.
 *
 * SEQUENTIAL, NEVER PARALLEL. `dispatch-lane` runs its own nested `tick-core` read per call, which is where a
 * just-dispatched item's guard entry actually gets added to `nextState`. Item 2 must see item 1's guard or the
 * two could both read "not yet guarded" and both clear a lane the double-dispatch guard exists to serialize —
 * running them in parallel would reopen exactly the race the guard is for.
 *
 * THE BOOKKEEPING FILE IS BARE, not `{ bookkeeping: … }`. `forwardableBookkeeping`
 * ({@link ../../scripts/operations/dispatch-lane-io.mjs}) accepts either shape, but the wrapped one recognizes
 * only a `bookkeeping` key and reports every sibling as a DROPPED key — so wrapping `nextState` under a
 * `signals` or similar key here would make every call log a spurious drop for a key nothing ever meant to send.
 *
 * A PER-ITEM FAILURE NEVER STOPS THE TICK (mirrors `makeCliMechanicalPasses`'s "best-effort, never wedge"):
 * a spawn throw, a non-zero exit, or unparsable stdout is caught, logged to stderr, and the loop keeps the
 * PRIOR `nextState` for that item and moves on — one bad `dispatch-lane` call must not block the rest of this
 * tick's dispatches.
 *
 * `repo` IS ACCEPTED BUT NOT FORWARDED. Unlike `tick-core.mjs` / the mechanical passes, `dispatch-lane`'s own
 * declared input has no `repo` field — its repo root is resolved by script location
 * (`dispatch-lane-io.mjs`'s `REPO_ROOT`), never by a flag or cwd. Passing `--repo=` would be refused as an
 * unknown flag and fail every dispatch this tick, so the parameter exists only for call-site symmetry with
 * `makeCliTickOnce` / `makeCliMechanicalPasses`.
 */
function makeCliDispatchPass({ scriptsDir, repo = null } = {}) {
  void repo; // see the doc comment above: dispatch-lane declares no --repo input
  return async ({ out } = {}) => {
    let nextState = (out && out.nextState) || {};
    const d = tickSurface(out).dispatch;
    const items = [...d.builds, ...d.prepareScope, ...d.prepareDecision, ...d.fixes, ...d.ciHeals];
    if (!items.length) return { nextState };

    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const runMjs = join(scriptsDir, 'operations', 'run.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'we-conveyor-dispatch-'));
    try {
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        try {
          const file = join(dir, `bk-${i}.json`);
          writeFileSync(file, JSON.stringify(nextState));
          const args = [runMjs, 'dispatch-lane', `--num=${item.num}`, `--bookkeepingFile=${file}`, '--json'];
          const stdout = execFileSync('node', args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            maxBuffer: 32 * 1024 * 1024,
          });
          const parsed = JSON.parse(stdout);
          const updated = parsed && parsed.findings && parsed.findings.read && parsed.findings.read.tickNextState;
          if (updated && typeof updated === 'object') nextState = updated;
        } catch (e) {
          process.stderr.write(`⚠ dispatch-lane --num=${item.num} failed (non-fatal): ${String(e.message || e).split('\n')[0]}\n`);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return { nextState };
  };
}

/** Build the real `emit` effect: print the tick's status line + notes, and the dispatch/watch decisions the
 *  judgment layer executes (the runner spends no model context, so it surfaces them — #2701 clause 3). */
function makeCliEmit({ json = false } = {}) {
  return (surface, ctx) => {
    if (json) { process.stdout.write(JSON.stringify({ tick: ctx.tick, ...surface }) + '\n'); return; }
    const { dispatch } = surface;
    const counts = `${dispatch.builds.length} build · ${dispatch.prepareScope.length + dispatch.prepareDecision.length} prepare · ${dispatch.fixes.length} fix · ${dispatch.ciHeals.length} heal · ${surface.armWatchers.length} watch`;
    process.stdout.write(`[tick ${ctx.tick}] ${surface.statusLine || '(no status)'}\n`);
    if (dispatch.builds.length || dispatch.prepareScope.length || dispatch.prepareDecision.length || dispatch.fixes.length || dispatch.ciHeals.length || surface.armWatchers.length) {
      process.stdout.write(`  ↳ surface for judgment layer: ${counts}\n`);
    }
    for (const n of surface.notes) process.stdout.write(`  ${n.text || JSON.stringify(n)}\n`);
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

/** Coerce a flag value to a finite number, falling back when it is absent / bare (`true`) / non-numeric —
 *  so `--max-ticks=abc` can never silently become `NaN` (which would never trip the max-ticks stop). */
function finiteOr(val, fallback) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Acquire the singleton lease, drive the loop, and ALWAYS release the lease — the lifecycle wrapper, kept
 * SEPARATE from `main()` so it is unit-testable without `process.exit` (which does NOT unwind a `finally`, so
 * the release MUST NOT sit behind an exit). A held lease returns `{ started: false }` so the caller stands
 * down; otherwise the lease is released in the `finally` before the caller exits. The lease heartbeat is wired
 * IN here (over the injected `heartbeat`), so the loop's lease-loss stop reflects the real singleton right.
 * @returns {Promise<{ started: boolean, reason?: string, heldBy?: string|null, ticks?: number, stoppedReason?: string }>}
 */
export async function driveConveyor({
  lockRoot = RUNNER_LOCK_ROOT,
  owner = runnerOwner(),
  buildEffects,
  acquire = acquireRunnerLease,
  heartbeat = heartbeatRunnerLease,
  release = releaseRunnerLeaseIfOwned,
} = {}) {
  if (typeof buildEffects !== 'function') throw new TypeError('driveConveyor requires a buildEffects factory');
  const acq = acquire(lockRoot, owner);
  if (!acq.ok) return { started: false, reason: acq.reason || 'held', heldBy: acq.heldBy ?? null };
  try {
    const effects = { ...buildEffects(owner), heartbeat: () => heartbeat(lockRoot, owner) };
    const result = await runLoop(effects);
    return { started: true, ticks: result.ticks, stoppedReason: result.stoppedReason };
  } finally {
    // Release BEFORE the caller exits — never behind a `process.exit` (which would skip it and leak the lease
    // for the full TTL, falsely standing down every launch inside that window). This is the drain daemon's
    // release-then-exit ordering (we:scripts/lane-drain.mjs), not a finally-after-exit.
    release(lockRoot, owner);
  }
}

async function main(argv) {
  const flags = parseFlags(argv);

  const HERE = dirname(fileURLToPath(import.meta.url));
  // Runner lives in skills-src/conveyor/; the tick core + the deterministic passes live in scripts/.
  const SCRIPTS_DIR = join(HERE, '..', '..', 'scripts');
  const TICK_CORE = join(SCRIPTS_DIR, 'conveyor', 'tick-core.mjs');

  const repo = typeof flags.repo === 'string' ? flags.repo : null;
  const json = !!flags.json;
  const intervalMs = finiteOr(flags['interval-ms'], DEFAULT_TICK_INTERVAL_MS);
  const maxTicks = flags.once ? 1 : finiteOr(flags['max-ticks'], Infinity);

  const buildEffects = () => ({
    tickOnce: makeCliTickOnce({ tickCorePath: TICK_CORE, repo }),
    emit: makeCliEmit({ json }),
    dispatchPass: makeCliDispatchPass({ scriptsDir: SCRIPTS_DIR, repo }),
    mechanicalPasses: makeCliMechanicalPasses({ scriptsDir: SCRIPTS_DIR, repo }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    intervalMs,
    maxTicks,
    initial: {},
  });

  // #2702 SINGLETON LOCK — `driveConveyor` acquires the sole-driver right, runs the loop, and ALWAYS releases
  // the lease (in its `finally`, before we exit). A LIVE runner already driving ⇒ `started:false`, a polite
  // stand-down (exit 0, not an error).
  const outcome = await driveConveyor({ owner: runnerOwner(), buildEffects });
  if (!outcome.started) {
    process.stderr.write(`✗ another conveyor runner holds the singleton lease (heldBy=${outcome.heldBy}); standing down.\n`);
  } else {
    process.stderr.write(`conveyor runner stopped: ${outcome.stoppedReason} after ${outcome.ticks} tick(s).\n`);
  }
  process.exit(0);
}

// Run the IO shell only when invoked directly — never on import (keeps the pure core side-effect-free).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`✗ runner error: ${String(e && e.stack || e)}\n`); process.exit(1); });
}
