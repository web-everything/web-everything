#!/usr/bin/env node
/**
 * @file scripts/readiness/heavy-admission.mjs
 * @description THE HEAVY-COMMAND ADMISSION QUEUE (#3461, ratified by #3456) — a capacity semaphore, distinct
 *   from lane leasing, that caps how many of a closed named set of heavy commands (`check:standards`,
 *   `verify-lane`/`test:unit`, the Playwright visual-capture pass) may run CONCURRENTLY across dispatched
 *   lanes on one host. v1 is an EQUAL-COST NAMED SET — every heavy command consumes exactly one slot, none is
 *   weighted differently.
 *
 * THE CAP APPLIES AT INVOCATION TIME, NEVER AT LANE-ACQUIRE TIME (#3456's own ruling). A lane may always be
 * acquired freely — `lane-pool.mjs acquire`'s `ensureDeps` `npm ci` is therefore a DELIBERATE, NAMED EXCEPTION
 * to this queue (see the comment at its call site) rather than gated here: gating it would violate "a lane may
 * always be acquired freely." The heavy command itself queues on this semaphore right before it actually runs
 * — see `verify-lane.mjs`'s `execSync(GATE, …)` call site for the wired example.
 *
 * MECHANISM — generalized from the two existing single-holder advisory locks named in #3456's own "what this
 * decision does NOT settle" section:
 *   • `file-locks.mjs` (#1936) — ONE atomic `mkdir`/`O_EXCL` lock dir per reserved PATH, with a heartbeat-TTL
 *     lease as the correctness floor and a same-machine PID-liveness fast path layered on top.
 *   • `infra-blocked.mjs` — a single-holder advisory state file for one degraded external dependency.
 * Neither is a COUNTING semaphore. This module gets there the cheapest possible way: it does NOT reimplement
 * mkdir/O_EXCL/heartbeat/reclaim — it calls `file-locks.mjs`'s existing atomic primitives `cap` times, once
 * per numbered SLOT (`slot-0` … `slot-<cap-1>`), each a completely ordinary file-lock path. Requesting a slot
 * is "try to win slot-0, else slot-1, … else slot-(cap-1)"; the semaphore's value emerges from `cap` independent
 * single-holder locks rather than being modeled directly. This reuses the EXACT SAME heartbeat-lease / PID
 * fast-path reclaim floor a crashed heavy-command holder needs — a second implementation of that policy would
 * be the thing #2607 forbids.
 *
 * NO HEARTBEAT DURING THE HOLD — a DELIBERATE consequence of who holds a slot. `file-locks.mjs`'s OTHER
 * consumers (`file-locks-cli.mjs`, `drain-lock.mjs`) refresh their lease periodically because they hold a path
 * across many small, interruptible steps. A heavy command holds its slot across ONE synchronous, event-loop
 * -BLOCKING call (`execSync(GATE, …)` in `verify-lane.mjs`) — no timer can fire mid-hold to heartbeat it. Two
 * consequences, both handled explicitly rather than left as a silent gap:
 *   1. `ADMISSION_LEASE_MINUTES` is deliberately LONG (default 60, comfortably past any realistic gate run) —
 *      not `file-locks.mjs`'s general-purpose `DEFAULT_LEASE_MINUTES` (15), which a real `test:unit &&
 *      check:standards` run can plausibly exceed. A too-short lease here would let a SECOND waiter reclaim a
 *      slot out from under a holder that is still legitimately running — silently breaking the cap invariant
 *      this whole module exists to enforce.
 *   2. Since the lease alone is now too coarse to reclaim a genuinely CRASHED holder promptly, the PID
 *      fast-path is WIRED HERE (mirroring `file-locks-cli.mjs`'s `probePidLiveness`) — `tryAcquireSlot` probes
 *      the current holder's `pid` via `kill(pid, 0)` and reclaims immediately on a provably-dead ('ESRCH')
 *      same-machine owner, without waiting out the long TTL. The TTL and the PID fast-path are therefore
 *      DECOUPLED on purpose: the TTL protects a slow-but-alive holder, the PID probe recovers a dead one fast.
 *
 * THE LOCK ROOT IS HOST-SHARED, NOT PER-LANE. A heavy command runs inside ONE lane's own clone, but the cap is
 * a HOST-WIDE resource across every lane of every pool (`web-everything`, `frontierui`, `plateau-app`) — so the
 * root lives at `<workspace>/.lanes/.admission/heavy`, a sibling of every `<pool>/lane-N` clone, derived via the
 * SAME `defaultPoolRoot` a lane's own `verify-lane.mjs` already uses to find its sibling leases.
 *
 * THE CAP IS A FIXED NUMBER, conservative by design (Bazel-style near-full-utilization is explicitly rejected
 * by #3456) — `DEFAULT_ADMISSION_CAP`, overridable per machine via `WE_HEAVY_ADMISSION_CAP`. A NAMED RESIDUAL
 * RISK (#3456, stated plainly per its own Done-when): a fixed cap alone REDUCES but does not FULLY ELIMINATE
 * #3383's finding-4 contention failure mode — a burst of requests can still all queue behind a saturated cap
 * for a while. v1 does not claim to solve that; it only bounds concurrency and makes the wait OBSERVABLE (the
 * `waiting` intent markers this module writes, which `tick-core.mjs` surfaces as `waiting-for-capacity` notes).
 *
 * A GENERAL-PURPOSE `run` CLI MODE — `node scripts/readiness/heavy-admission.mjs run [--container] -- <cmd…>`
 * wraps `acquire → run <cmd> → release` in one call ({@link runUnderAdmission}), so any caller can opt into
 * this SAME semaphore without hand-rolling the acquire/execute/release sequence itself.
 *
 * THE CAP WAS, UNTIL NOW, PURELY COOPERATIVE — a counting semaphore with NO resource boundary behind it: it
 * throttles how many heavy commands run at once, never how many CPU cores or how much memory any one of them
 * gets, so a single admitted command already misbehaving (the #3594 busy-spin incident that opened
 * `we:backlog/3621-real-os-level-resource-isolation-per-dispatched-lane-is-appl.md`) is fully unconstrained
 * once it starts. `run`'s `--container` flag (or `WE_HEAVY_ADMISSION_CONTAINER=1`) is the #3621 sequencing
 * note's heavy-command-pool container POC (tracked as a progress note on `we:backlog/3383-a-background-mechanical-dispatcher-replaces-the-interactive.md`,
 * not a separate formal item — see that item's own log for why): it swaps the command's execution from a bare
 * host `execSync` to `we:scripts/lib/container-exec.mjs#execContainerized`, running it inside a real Apple
 * `container` instance with an enforced `--cpus`/`--memory` ceiling instead. OPT-IN ONLY — every existing
 * caller, and `run` without the flag, is byte-identical to before this flag existed. See `container-exec.mjs`'s
 * own header for exactly what is proven to work this way — `check:standards` (mount-straight-in) and, as of
 * the `test:unit` slice, ALSO `test:unit` via the separate `--container-node-modules` opt-in below (Playwright
 * remains unproven).
 *
 * `--container-node-modules` (or `WE_HEAVY_ADMISSION_CONTAINER_NODE_MODULES=1`) is the `test:unit` slice's own
 * opt-in, layered ON TOP of `--container` (meaningless without it) — it additionally shadows the container's
 * `node_modules` with the LINUX-built tree `container-exec/build-test-unit-deps.mjs` seeds into a named volume
 * (`container-exec.mjs#DEFAULT_NODE_MODULES_VOLUME`), because `test:unit`'s own closure (vitest→esbuild/rollup)
 * carries native `darwin-arm64` bindings the plain `check:standards`-shaped mount cannot resolve. See
 * `container-exec.mjs`'s module header ("test:unit slice") for the full mechanism and measured evidence.
 *
 * EVERY HEAVY COMMAND GOES THROUGH THIS POOL (xaipsbs, 2026-09-21). Until then only `verify-lane.mjs` was
 * admitted; `npm run test:unit` / `check:standards` typed directly, and the scripts that shell them, ran
 * outside it. Now `package.json`'s `test:unit`, `test:coverage`, `check:standards` and the vitest step of
 * `verify` are `heavy-admission.mjs run -- <cmd>`, and the scripts that spawn vitest or check-standards
 * themselves route through {@link admittedArgv} / {@link admittedShellCommand}. Three rules keep the wrapper
 * safe to put everywhere:
 *   • it is a PASS-THROUGH under `CI=true`, `WE_HEAVY_ADMISSION=off`, or when the lane-pool root does not
 *     exist ({@link admissionBypassReason});
 *   • it is RE-ENTRANT: whatever it runs gets `WE_HEAVY_ADMISSION_HELD=1`, and a nested wrapper that sees it
 *     never asks for a second slot ({@link ADMISSION_HELD_ENV}); `verify-lane.mjs` sets it around its gate;
 *   • each `run` is its own owner (`<repo>#<pid>`), so two commands from one checkout take two slots.
 * Stale `waiting` markers (owner gone, older than {@link WAITING_TTL_MINUTES}) are reaped by the next
 * admission attempt; `reap` previews them and `reap --apply` removes them.
 *
 * A WAITER NEVER RUNS UNSLOTTED WHILE A HOLDER IS ALIVE (xhlriy2, #3383). Observed 2026-09-23: with test runs
 * taking 25-40 minutes under load and several lanes waiting, `DEFAULT_TIMEOUT_MS`'s old 20-minute elapsed-time
 * give-up let waiters fail open and run TOGETHER — the cap stopped holding exactly when it mattered most.
 * {@link acquireSlotBlocking} no longer gives up purely on elapsed time: it keeps polling — logging a periodic
 * "still waiting" line every {@link STILL_WAITING_LOG_MS} — for as long as {@link tryAcquireSlot} keeps losing,
 * which (via the PID-liveness + lease-TTL reclaim above) can only happen while every held slot's holder is
 * still alive with an unexpired lease; the moment every holder is provably dead or lease-expired, the very next
 * `tryAcquireSlot` attempt reclaims a real slot rather than the caller running unslotted. The one remaining
 * escape from an indefinite wait is {@link DEFAULT_ADMISSION_CEILING_MS} (default 120 minutes, comfortably past
 * any realistic gate run, overridable via `WE_HEAVY_ADMISSION_CEILING_MS`) — a hard ceiling so a genuinely
 * wedged holder cannot strand a lane forever; crossing it still fails OPEN (runs unslotted) but with a LOUD
 * warning naming the ceiling. `DEFAULT_TIMEOUT_MS`/`resolveTimeoutMs` are UNCHANGED and still read by
 * `verify-lane.mjs`/the CLI's legacy `--timeout-ms` fallback, but no longer decide when `acquireSlotBlocking`
 * gives up — see their own doc comments. `WE_HEAVY_ADMISSION=off` ({@link isAdmissionOff}) — the SAME switch
 * {@link admissionBypassReason} already reads for the `run` wrapper — is now ALSO checked directly at the top
 * of {@link acquireSlotBlocking} itself, before it ever touches the lock root, so any direct caller of the
 * blocking primitive (not just `run`) gets the escape hatch too.
 *
 * THE LOAD-ADMISSION GATE (#4076, revised #4343) — a SECOND, DIFFERENT admission axis this module now also
 * hosts, gating NEW DISPATCHED SESSIONS (not heavy commands) by the host's ACTUAL capacity — CPU idle% and
 * memory pressure, with a much-higher-ratio `load1/cores` kept only as a runaway backstop (a bare load1 ratio
 * alone, #4343's finding, is inflated by our OWN fork-storm daemons independent of real host capacity). See the
 * "LOAD ADMISSION" section further down ({@link loadAdmissionDecision}, {@link readLatestLoad}, {@link
 * resolveLoadAdmission}, the `load-status` CLI mode) for the full reasoning — it is orthogonal to both this
 * module's own heavy-command semaphore above and `lane-concurrency.mjs`'s fixed lane-count ceiling, and
 * `tick-core.mjs#planTick` is its one consumer.
 *
 * ADMISSION BY PROJECTED QUEUE TIME + A FAST LANE (card xkyw1x4, epic #4075) — a THIRD axis, looking ahead rather
 * than at the present. The pure formulas live in `./heavy-queue-projection.mjs` (re-exported here); this module
 * adds the reads they need:
 *   • every slot release records its HOLD DURATION by kind ({@link recordHoldDuration}, `durations.jsonl` beside
 *     the slots), and {@link readStandardMinutes} turns the log into a rolling typical time per kind;
 *   • {@link resolveQueueBaseline} (CLI: `queue-status`) sums the queue backlog — remaining time on held slots,
 *     the standard time of every live waiter, and the expected demand of sessions dispatched in the last few
 *     minutes that have not reached the slots yet (read from their lane leases) — which `tick-core.mjs#planTick`
 *     and the fix / ci-heal daemons feed to `createQueueBudget` to admit or hold (`queue-cap`) new dispatches;
 *   • THE FAST LANE: a caller now passes its command KIND to {@link acquireSlotBlocking}. The short kinds
 *     (selected / files / standards) rank first-come-first-served only among themselves — never behind a
 *     full-suite waiter — and get `WE_HEAVY_ADMISSION_FAST_SLOTS` (default 1) EXTRA slots ADDED ON TOP of the
 *     cap (operator decision on PR #2707): `WE_HEAVY_ADMISSION_CAP` stays the number of HEAVY slots (slot-0 …
 *     slot-<cap-1>), the fast slots follow them (slot-<cap> …). A short job may also take a free heavy slot; a
 *     full suite never takes a fast slot. Default 2 heavy + 1 fast.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LEASE_FILENAME, isLeaseStale } from '../lib/lane-lease.mjs';
import { reserve, releaseLockDir, readLockEntry } from './file-locks.mjs';
import { defaultPoolRoot, guardedPoolRoot } from '../lib/lane-pool-paths.mjs';
import { writeAllSync } from '../lib/write-all-sync.mjs';
import { execContainerized, containerCliAvailable, containerImageAvailable, resolveContainerImage, resolveNodeModulesVolume, nodeModulesVolumeAvailable } from '../lib/container-exec.mjs'; // #3621 sequencing note (tracked on #3383) — the heavy-command-pool container POC; see that module's own header for proven scope (check:standards + test:unit)
import { resolveHostRoot, readHostToday, extractSamplesByName, utcDayKey } from '../operations/telemetry-summary-io.mjs'; // #4076 — REUSE the host-sampler's own root-resolution + tail-read + metric-extraction primitives (never reimplemented — see loadAdmissionDecision's section header below)
import { latestValue, median } from '../lib/telemetry-machine.mjs'; // #4076/#4343 — the SAME "latest sample wins" reducer + median telemetry-machine.mjs already uses/exports — never a second implementation
import {
  classifyCommandKind, normalizeKind, queueLaneOf, typicalMinutes, typicalDispatchMinutes, resolvePrepareAdmission, classifyDispatchKind, dispatchDemandMinutes,
  queueBacklog, laneProjection, resolveFastSlots, slotOrderFor, DEFAULT_QUEUE_MAX_WAIT_MINUTES, QUEUE_MAX_WAIT_ENV,
  QUEUE_ADMISSION_SWITCH_ENV, DEFAULT_ARRIVAL_WINDOW_MINUTES,
} from './heavy-queue-projection.mjs'; // card xkyw1x4 — the pure projection + fast-lane rules
export * from './heavy-queue-projection.mjs';

/** Conservative default — below measured host capacity, not near-full-utilization (#3456 explicit ruling).
 *  Overridable per machine via `WE_HEAVY_ADMISSION_CAP`. */
export const DEFAULT_ADMISSION_CAP = 2;

/** How often a blocking waiter re-polls for a free slot. */
export const DEFAULT_POLL_MS = 2000;

/** HISTORICAL — no longer the point at which a blocking waiter gives up (xhlriy2, #3383: that was the exact
 *  bug — a waiter fails open and runs UNSLOTTED after this elapses even while a slot holder is still alive,
 *  which under real load let waiters time out and run together, breaking the cap). Still read via
 *  {@link resolveTimeoutMs} (the CLI's legacy `--timeout-ms` fallback), but {@link acquireSlotBlocking} itself
 *  now gives up only at {@link DEFAULT_ADMISSION_CEILING_MS}. Overridable via `WE_HEAVY_ADMISSION_TIMEOUT_MS`
 *  (mirroring {@link resolveCap}). */
export const DEFAULT_TIMEOUT_MS = 20 * 60_000;

/** THE HARD CEILING (xhlriy2, #3383) — far above a normal run, so a wedged holder cannot strand a lane forever.
 *  A waiter now keeps polling (logging a periodic "still waiting" line, see {@link STILL_WAITING_LOG_MS}) for as
 *  long as a slot holder is provably alive with an unexpired lease; it gives up and proceeds unslotted only once
 *  this ceiling elapses, with a loud warning. Overridable via `WE_HEAVY_ADMISSION_CEILING_MS`
 *  ({@link resolveCeilingMs}). */
export const DEFAULT_ADMISSION_CEILING_MS = 120 * 60_000;

/** How often, while blocked, {@link acquireSlotBlocking} logs a "still waiting" line (xhlriy2) — observability
 *  for an operator/tick watching a long queue, distinct from the much-longer give-up ceiling above. */
export const STILL_WAITING_LOG_MS = 5 * 60_000;

/** The lease a HELD SLOT gets — deliberately longer than `file-locks.mjs`'s general-purpose
 *  `DEFAULT_LEASE_MINUTES` (15). A slot is held across one synchronous, event-loop-blocking `execSync` with no
 *  chance to heartbeat mid-hold (see the module header), so the lease itself must outlast any realistic gate
 *  run rather than relying on a refresh that cannot happen. A genuinely dead holder is still reclaimed promptly
 *  via the PID-liveness fast path in {@link tryAcquireSlot}, not by waiting out this TTL. */
export const ADMISSION_LEASE_MINUTES = 60;

/** How old a `waiting` marker must be before the reap may remove it (xaipsbs). A live waiter clears its own
 *  marker in `acquireSlotBlocking`'s `finally`, and the default wait gives up after 20 minutes, so a marker
 *  past 30 minutes whose owner is also provably gone is debris from a killed process, never a real waiter.
 *  Age alone is never enough: the owner must be gone too (see {@link classifyWaiter}). */
export const WAITING_TTL_MINUTES = 30;

/** RE-ENTRANCY (xaipsbs). Set to `1` in the environment of every command this module runs while it holds a
 *  slot (the `run` wrapper, and `verify-lane.mjs` around its gate). A nested wrapper that sees it is a plain
 *  pass-through: `verify-lane` → `npm run test:unit` → `heavy-admission.mjs run -- vitest run` must not ask
 *  for a SECOND slot for the same work, and with cap 1 it would wait on itself until the timeout. It is also
 *  set when the outer run proceeded unslotted after a timeout, so the inner run does not queue a second time. */
export const ADMISSION_HELD_ENV = 'WE_HEAVY_ADMISSION_HELD';

/** The off switch: `WE_HEAVY_ADMISSION=off` (or `0`/`false`) makes the wrapper a pass-through. */
export const ADMISSION_SWITCH_ENV = 'WE_HEAVY_ADMISSION';

/** Absolute path of this CLI, for callers that route a synchronous child command through `run`. */
export const HEAVY_ADMISSION_CLI = fileURLToPath(import.meta.url);

const SUBDIR = join('.admission', 'heavy');
const WAITING_SUBDIR = 'waiting';
const REAP_LOG = 'reaped.jsonl';

/** Resolve the admission cap from env, clamped to a sane minimum of 1 (a cap of 0 would wedge every caller
 *  forever, which is a config bug, not a valid "admit nothing" policy). */
export function resolveCap(env = process.env) {
  const n = Number(env.WE_HEAVY_ADMISSION_CAP);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_ADMISSION_CAP;
}

/** Resolve the wait-then-give-up timeout from env, mirroring {@link resolveCap}. Clamped to a sane minimum of
 *  1000ms — a 0/negative timeout would give up before ever attempting a first acquire. */
export function resolveTimeoutMs(env = process.env) {
  const n = Number(env.WE_HEAVY_ADMISSION_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : DEFAULT_TIMEOUT_MS;
}

/** Resolve the hard give-up ceiling from env (xhlriy2), mirroring {@link resolveTimeoutMs}. Clamped to a sane
 *  minimum of 1000ms. */
export function resolveCeilingMs(env = process.env) {
  const n = Number(env.WE_HEAVY_ADMISSION_CEILING_MS);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : DEFAULT_ADMISSION_CEILING_MS;
}

/** True when the explicit escape hatch is set (xhlriy2) — `WE_HEAVY_ADMISSION=off` (or `0`/`false`/`no`,
 *  case-insensitive). The SAME check {@link admissionBypassReason} already applies for the `run` wrapper's
 *  'off' bypass reason — factored out here so {@link acquireSlotBlocking} can apply it directly too, and so
 *  there is exactly one regex for this switch rather than two that could drift apart. */
export function isAdmissionOff(env = process.env) {
  return /^(?:off|0|false|no)$/i.test(String(env[ADMISSION_SWITCH_ENV] || ''));
}

// ── LOAD ADMISSION (#4076, revised #4343) — a SECOND dispatch gate on ACTUAL host capacity ─────────────
//
// Orthogonal to BOTH existing admission points: this module's own heavy-command semaphore above (a fixed
// COUNT of concurrent `check:standards`/`test:unit`/Playwright runs, oblivious to how loaded the host already
// is) and `../lib/lane-concurrency.mjs`'s fixed lane-COUNT ceiling (#3612 — its own header calls it "fixed,
// conservative, hardware-blind by design"). This gate closes that gap for NEW DISPATCHED SESSIONS —
// `tick-core.mjs#planTick`'s build / prepare / fix / ci-heal spawns — holding EVERY new launch this tick when
// the host reads as genuinely saturated. It sits BESIDE the fixed lane ceiling, never replacing it: a tick can
// be held by capacity-cap, load-cap, both, or neither, independently.
//
// #4343 — NOT `load1/cores` ALONE ANY MORE. macOS `load1` counts RUNNABLE THREADS, and our own daemons
// (cards 4344/4345/4346) start ~400 short-lived processes per second — a fork storm that inflates `load1` into
// the 20s–60s on this 12-core host while CPU idle sits at 25–65% and memory is never under pressure (live
// evidence on #4343's own card: 08:30 ET held on "load 21.24/12 (1.77 > 1.5)" while `top` read 29.6% idle).
// The gate was holding dispatch on ITS OWN polling, not on real host saturation. The PRIMARY signal is now the
// host-sampler's own `host.cpu.busy_pct` sample's `idle_pct` ATTRIBUTE (see `telemetry.mjs`'s own header: the
// metric's `value` IS busy_pct, `user_pct`/`sys_pct`/`idle_pct`/... ride as `attributes` of that SAME sample) —
// a MEDIAN over the last {@link DEFAULT_LOAD_ADMISSION_WINDOW} samples, so a brief dip from a burst of forked
// children never trips it, but sustained saturation still does. `host.mem.pressure_level >= 2` (macOS "warn" —
// {@link DEFAULT_LOAD_ADMISSION_MIN_PRESSURE_LEVEL}) holds independently, checked on the LATEST sample only
// (never windowed like idle% — the card's own evidence found pressure steady at "1 (normal)" across all 3239
// samples of its evidence day, none of the fork-storm flapping idle%/load1 show, so there is nothing to smooth;
// see {@link loadAdmissionDecision}'s own doc comment for why this is a deliberate asymmetry, not an oversight).
// `load1/cores` is KEPT, but only as a much higher-ratio RUNAWAY BACKSTOP ({@link
// DEFAULT_LOAD_ADMISSION_BACKSTOP_PER_CORE}, default 4 — the 2026-09-07 cascade, #xupukxa, hit ~2.9, which is
// PLAUSIBLY consistent with idle% having caught it too, though no idle%-telemetry was captured that day to
// confirm it directly) for a saturation shape idle% alone might miss (a true CPU-bound compute storm with
// little forking). `load1` here is ALSO the median over the SAME window as idle% ({@link readLatestLoad}'s own
// doc comment) — an earlier draft read a single instantaneous sample, which the card's own evidence (fork-storm
// `load1` reaching the 20s–60s range on this 12-core host, i.e. up to ~5/core) shows can itself spuriously
// cross even this much-higher backstop threshold during an ordinary burst, reintroducing this very card's own
// bug at a higher bar rather than closing it. The backstop's env var is its OWN new name
// (`WE_LOAD_ADMISSION_BACKSTOP_PER_CORE`), never the OLD `WE_LOAD_ADMISSION_MAX_PER_CORE`: that name meant a
// much LOWER primary threshold (1.5) before #4343, and silently reinterpreting an existing low override under
// the same name as the new, much-higher backstop would reintroduce this very card's own bug on any machine that
// still has it set. (The `load-status` CLI flag `--max-per-core=` keeps its pre-#4343 SPELLING for operator
// continuity — a one-shot invocation flag carries no persisted-config collision risk the way an env var does —
// but is wired to this new env var underneath; see the CLI mode's own comment.) See {@link
// loadAdmissionDecision}'s own doc comment for the full three-condition decision.
//
// READS, NEVER REIMPLEMENTS the host-sampler's own tail-read (`telemetry-summary-io.mjs#readHostToday`, the
// SAME bounded read `telemetry-machine.mjs#computeMachineNow` uses) and its "latest sample wins" reducer
// (`telemetry-machine.mjs#latestValue`) / median (`telemetry-machine.mjs#median`) — this module only adds the
// metric names/attributes it needs (`host.cpu.busy_pct`'s `idle_pct` attribute, `host.mem.pressure_level`,
// `host.cpu.load1`, `host.cpu.count`) and the threshold decision on top.
//
// A MISSING OR UNREADABLE SAMPLE FAILS OPEN (admits) — the same posture {@link admissionBypassReason} already
// takes when the lane-pool root doesn't exist: a sampler outage must never itself wedge new dispatch. Each of
// the three conditions below contributes ONLY when its own data is present; `reason:'no-sample'` fires only
// when NONE of the three had anything to decide on.

/** Hold when the median `idle_pct` over the last {@link DEFAULT_LOAD_ADMISSION_WINDOW} `host.cpu.busy_pct`
 *  samples is below this. The observed baseline idle% p5 (across 3239 samples — see the card's own "## Evidence"
 *  section, `backlog/4343-load-cap-admits-on-instantaneous-load-average-which-our-own.md`) is 25.8, so 15 sits
 *  below every normal reading and above real saturation. Overridable via `WE_LOAD_ADMISSION_MIN_IDLE_PCT`. */
export const DEFAULT_LOAD_ADMISSION_MIN_IDLE_PCT = 15;

/** The env var a machine overrides {@link DEFAULT_LOAD_ADMISSION_MIN_IDLE_PCT} with. */
export const LOAD_ADMISSION_MIN_IDLE_PCT_ENV = 'WE_LOAD_ADMISSION_MIN_IDLE_PCT';

/** How many of the most recent `host.cpu.busy_pct` samples the idle-median is taken over. A 2-minute median
 *  (the host-sampler's own ~30s cadence × 4) absorbs a brief fork-storm dip without smoothing away real
 *  sustained saturation (per the card's own "## Evidence" section: a 2-minute median of `idle_pct < 15` held on
 *  0.7% of samples, vs. 7.5%–20% for the old single-sample `load1` rule). Overridable via
 *  `WE_LOAD_ADMISSION_WINDOW`. */
export const DEFAULT_LOAD_ADMISSION_WINDOW = 4;

/** The env var a machine overrides {@link DEFAULT_LOAD_ADMISSION_WINDOW} with. */
export const LOAD_ADMISSION_WINDOW_ENV = 'WE_LOAD_ADMISSION_WINDOW';

/** Hold when the LATEST `host.mem.pressure_level` sample is at or above this (macOS "warn" is `2`). Checked on
 *  the single latest sample, never windowed like idle% — deliberately, not an oversight: unlike `load1`/idle%,
 *  which our own fork-storm daemons visibly flap, the card's own evidence found pressure steady at "1 (normal)"
 *  across every one of 3239 samples on its evidence day, so there is no observed noise here to smooth, and a
 *  real jump to "warn" or worse is exactly the kind of signal that should hold immediately rather than wait out
 *  a median. Overridable via `WE_LOAD_ADMISSION_MIN_PRESSURE_LEVEL`. */
export const DEFAULT_LOAD_ADMISSION_MIN_PRESSURE_LEVEL = 2;

/** The env var a machine overrides {@link DEFAULT_LOAD_ADMISSION_MIN_PRESSURE_LEVEL} with. */
export const LOAD_ADMISSION_MIN_PRESSURE_LEVEL_ENV = 'WE_LOAD_ADMISSION_MIN_PRESSURE_LEVEL';

/** The runaway BACKSTOP ratio (`load1 / cores`) — #4343's own, NEW knob, never the OLD `WE_LOAD_ADMISSION_
 *  MAX_PER_CORE` name (that name meant a much LOWER primary threshold, 1.5, before #4343 — reusing it here would
 *  let any machine that already has it set near 1.5 silently keep holding on ordinary fork-storm-inflated
 *  `load1`, reintroducing this very card's own bug for that one machine). Default 4: the #xupukxa cascade
 *  (~2.9) would already have shown up through idle% dropping, so this only needs to catch a saturation shape
 *  idle% alone might miss. Overridable via `WE_LOAD_ADMISSION_BACKSTOP_PER_CORE`. */
export const DEFAULT_LOAD_ADMISSION_BACKSTOP_PER_CORE = 4;

/** The env var a machine overrides the backstop ratio with — its OWN name, deliberately distinct from the
 *  pre-#4343 `WE_LOAD_ADMISSION_MAX_PER_CORE` (see {@link DEFAULT_LOAD_ADMISSION_BACKSTOP_PER_CORE}'s own doc
 *  comment for why reusing that name would be unsafe). */
export const LOAD_ADMISSION_BACKSTOP_PER_CORE_ENV = 'WE_LOAD_ADMISSION_BACKSTOP_PER_CORE';

/** The off switch: `WE_LOAD_ADMISSION=off` (or `0`/`false`/`no`) makes this gate always admit. Mirrors
 *  {@link ADMISSION_SWITCH_ENV} / {@link isAdmissionOff} exactly. */
export const LOAD_ADMISSION_SWITCH_ENV = 'WE_LOAD_ADMISSION';

/** Resolve the minimum idle% threshold from env, clamped to a sane range (0, 100] — a 0/negative/>100 value
 *  would hold never/always regardless of reality, a config bug, not a valid policy. Mirrors {@link resolveCap}. */
export function resolveLoadAdmissionMinIdlePct(env = process.env) {
  const n = Number(env?.[LOAD_ADMISSION_MIN_IDLE_PCT_ENV]);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : DEFAULT_LOAD_ADMISSION_MIN_IDLE_PCT;
}

/** Resolve the idle-median sample window from env, clamped to a sane minimum of 1 sample. */
export function resolveLoadAdmissionWindow(env = process.env) {
  const n = Number(env?.[LOAD_ADMISSION_WINDOW_ENV]);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_LOAD_ADMISSION_WINDOW;
}

/** Resolve the minimum memory-pressure level from env, clamped to a sane integer minimum of 2 — macOS's own
 *  "normal" rung is `1`, and holding on `>= 1` would hold UNCONDITIONALLY (every sample is at least "normal"),
 *  which is a config bug, not a valid policy, so an override of exactly `1` is rejected back to the default
 *  (`2`, "warn") rather than honored. */
export function resolveLoadAdmissionMinPressureLevel(env = process.env) {
  const n = Number(env?.[LOAD_ADMISSION_MIN_PRESSURE_LEVEL_ENV]);
  return Number.isInteger(n) && n > 1 ? n : DEFAULT_LOAD_ADMISSION_MIN_PRESSURE_LEVEL;
}

/** Resolve the per-core load BACKSTOP ratio from env, clamped to a sane minimum > 0 (a 0/negative ratio would
 *  hold every tick unconditionally, which is a config bug, not a valid "always hold" policy — the explicit
 *  `WE_LOAD_ADMISSION=off` switch is the real way to disable this gate). Mirrors {@link resolveCap}. */
export function resolveLoadAdmissionBackstopPerCore(env = process.env) {
  const n = Number(env?.[LOAD_ADMISSION_BACKSTOP_PER_CORE_ENV]);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LOAD_ADMISSION_BACKSTOP_PER_CORE;
}

/** True when the explicit escape hatch is set. Mirrors {@link isAdmissionOff} exactly, own env var. */
export function isLoadAdmissionOff(env = process.env) {
  return /^(?:off|0|false|no)$/i.test(String(env[LOAD_ADMISSION_SWITCH_ENV] || ''));
}

/**
 * PURE decision (#4343): THREE INDEPENDENT conditions, each contributing only when its own data is present —
 * a signal with no data never fabricates a hold:
 *   1. **idle-low** — the MEDIAN of `idlePctSamples` (the last {@link DEFAULT_LOAD_ADMISSION_WINDOW} `idle_pct`
 *      readings) is below `minIdlePct` (default {@link DEFAULT_LOAD_ADMISSION_MIN_IDLE_PCT}).
 *   2. **mem-pressure** — the LATEST `pressureLevel` is `>= minPressureLevel` (default
 *      {@link DEFAULT_LOAD_ADMISSION_MIN_PRESSURE_LEVEL}, macOS "warn"). Checked on the single latest sample,
 *      never windowed like idle% — see {@link DEFAULT_LOAD_ADMISSION_MIN_PRESSURE_LEVEL}'s own doc comment for
 *      why that asymmetry is deliberate.
 *   3. **load-backstop** — `load1 / cores` is, on its own, above `backstopPerCore` (default
 *      {@link DEFAULT_LOAD_ADMISSION_BACKSTOP_PER_CORE}) — a much higher ratio than the OLD primary threshold,
 *      kept only as a runaway safety net idle% alone might miss.
 * Checked in that order; `reason` names whichever condition actually held (never more than one). When NONE of
 * the three had any data to decide on, this FAILS OPEN — `held:false`, `reason:'no-sample'` — the same posture
 * the old code took on a missing `load1`/`cores` reading, rather than ever guessing. The idle% reading embedded
 * in a held `reason` is FLOORED, never rounded — `Math.round` could display e.g. "15%" for a true 14.99% (which
 * reads as self-contradictory next to "(<15%)"); `Math.floor(x) <= x` always, so a floored display can never
 * read as satisfying the threshold it just failed.
 * @param {{idlePctSamples?:number[], pressureLevel?:number|null, load1?:number|null, cores?:number|null, minIdlePct?:number, minPressureLevel?:number, backstopPerCore?:number}} [o]
 * @returns {{held:boolean, idlePct:number|null, minIdlePct:number, pressureLevel:number|null, minPressureLevel:number, load1:number|null, cores:number|null, perCore:number|null, backstopPerCore:number, reason?:string}}
 */
export function loadAdmissionDecision({
  idlePctSamples = [], pressureLevel = null, load1 = null, cores = null,
  minIdlePct = DEFAULT_LOAD_ADMISSION_MIN_IDLE_PCT, minPressureLevel = DEFAULT_LOAD_ADMISSION_MIN_PRESSURE_LEVEL,
  backstopPerCore = DEFAULT_LOAD_ADMISSION_BACKSTOP_PER_CORE,
} = {}) {
  const idleNums = (Array.isArray(idlePctSamples) ? idlePctSamples : []).map(Number).filter(Number.isFinite);
  const idlePct = idleNums.length ? median(idleNums) : null;
  // `Number(null)` is `0`, not "absent" — a bare `Number()` coercion would turn a genuinely missing sample into
  // a false reading of zero (mirrors telemetry-machine.mjs#computeMachineNow's own `fallbackCores` guard).
  // `== null` catches both `null` and `undefined`.
  const pLevel = pressureLevel == null ? NaN : Number(pressureLevel);
  const l = load1 == null ? NaN : Number(load1);
  const c = cores == null ? NaN : Number(cores);
  const perCore = (Number.isFinite(l) && Number.isFinite(c) && c > 0) ? l / c : null;
  const base = {
    idlePct, minIdlePct,
    pressureLevel: Number.isFinite(pLevel) ? pLevel : null,
    minPressureLevel,
    load1: Number.isFinite(l) ? l : null,
    cores: (Number.isFinite(c) && c > 0) ? c : null,
    perCore, backstopPerCore,
  };
  if (idlePct != null && idlePct < minIdlePct) {
    return { held: true, ...base, reason: `cpu idle ${Math.floor(idlePct)}% (<${minIdlePct}%)` };
  }
  if (Number.isFinite(pLevel) && pLevel >= minPressureLevel) {
    return { held: true, ...base, reason: `mem pressure ${pLevel} (>=${minPressureLevel})` };
  }
  if (perCore != null && perCore > backstopPerCore) {
    return { held: true, ...base, reason: `load1 ${l.toFixed(2)}/${c} cores (${perCore.toFixed(2)} > backstop ${backstopPerCore})` };
  }
  if (idlePct == null && !Number.isFinite(pLevel) && perCore == null) {
    return { held: false, ...base, reason: 'no-sample' };
  }
  return { held: false, ...base };
}

/**
 * Read the host-sampler's LATEST load-admission inputs — a bounded tail read of today's (UTC-keyed) day file,
 * exactly like `telemetry-summary-io.mjs#readHostToday` already does for `machine.now`. `idle_pct` rides as an
 * ATTRIBUTE of `host.cpu.busy_pct` records (`telemetry.mjs`'s own header: the metric's `value` IS busy_pct,
 * `idle_pct`/`user_pct`/`sys_pct`/... are attributes of that SAME sample) — so this reads FULL records off the
 * tail, never just `{timestamp,value}` the way {@link extractSamplesByName} does, and takes the last `window`
 * of them by timestamp. A record whose `attributes.idle_pct` is absent (an older sampler build) falls back to
 * `100 - value` (value IS busy_pct) rather than being dropped.
 *
 * `load1` is ALSO the MEDIAN over the same `window`, never a single instantaneous sample — deliberately, not an
 * oversight (#4343 review finding): the card's own evidence is that the fork-storm daemons this fix targets
 * push `load1` into the 20s–60s range on a 12-core host, i.e. up to ~5/core — ABOVE the new backstop's default
 * ratio (4) — so an unwindowed backstop reading could still spuriously hold on the exact burst this card exists
 * to stop admitting on, even while idle%/pressure are comfortable. Medianing it exactly like idle% closes that
 * gap: a brief fork-storm spike is absorbed, a SUSTAINED runaway (the #xupukxa cascade this backstop exists to
 * catch) still shows up. `cores` is read as the single latest sample — a machine's logical core count does not
 * fluctuate sample to sample, so windowing it would add cost with no signal.
 *
 * A day with no host-sampler file yet reads as all-null/empty — {@link loadAdmissionDecision} then fails open,
 * never a read error. `root` defaults to the REAL shared telemetry root ({@link resolveHostRoot}) but is
 * overridable, same "injectable seam, real default" shape `readHostToday` itself already has.
 * @param {{root?:string, now?:Date, window?:number}} [o]
 * @returns {{idlePctSamples:number[], pressureLevel:number|null, load1:number|null, cores:number|null}}
 */
export function readLatestLoad({ root = resolveHostRoot(), now = new Date(), window = DEFAULT_LOAD_ADMISSION_WINDOW } = {}) {
  const dayKey = utcDayKey(now);
  const { records } = readHostToday(root, dayKey);
  // A non-positive/non-integer `window` (never produced by `resolveLoadAdmissionWindow`'s own clamp, but this
  // function is exported and callable directly) falls back to the documented default rather than reading as
  // "no windowing" — an UNBOUNDED `slice(-0)` would silently take the WHOLE day's samples, surprising for what
  // reads as a numeric sample-count.
  const effectiveWindow = Number.isInteger(window) && window >= 1 ? window : DEFAULT_LOAD_ADMISSION_WINDOW;
  // ONE shared windowing step — sort oldest-to-newest by timestamp, keep only the last `effectiveWindow` — for
  // BOTH sample streams below, rather than two near-identical sort+slice call sites that could silently drift
  // apart (e.g. one keeping the window clamp, the other losing it in a future edit).
  const lastByWindow = (arr) => [...arr].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()).slice(-effectiveWindow);
  const recentBusy = lastByWindow((Array.isArray(records) ? records : []).filter((r) => r && r.name === 'host.cpu.busy_pct'));
  const idlePctSamples = recentBusy
    .map((r) => {
      const fromAttr = Number(r?.attributes?.idle_pct);
      if (Number.isFinite(fromAttr)) return fromAttr;
      const busyVal = Number(r?.value);
      return Number.isFinite(busyVal) ? 100 - busyVal : NaN;
    })
    .filter(Number.isFinite);
  const load1Samples = lastByWindow(extractSamplesByName(records, 'host.cpu.load1'))
    .map((s) => Number(s.value))
    .filter(Number.isFinite);
  return {
    idlePctSamples,
    pressureLevel: latestValue(extractSamplesByName(records, 'host.mem.pressure_level')),
    load1: load1Samples.length ? median(load1Samples) : null,
    cores: latestValue(extractSamplesByName(records, 'host.cpu.count')),
  };
}

/**
 * The full IO-shell decision: bypass (off switch / CI, mirroring {@link admissionBypassReason}'s own reasons)
 * else read-and-decide via {@link readLatestLoad} + {@link loadAdmissionDecision}. The one function
 * `tick-core.mjs`'s IO shell needs to shell (via the `load-status` CLI mode below) to get a load-admission
 * verdict — the pure core itself never touches fs/env directly (see tick-core.mjs's own pure/shell split).
 * A `minIdlePct`/`minPressureLevel`/`backstopPerCore`/`window` param OVERRIDES its env var for this one call —
 * but is validated through the EXACT SAME `resolveLoadAdmission*` clamp its env var would be, never a bare
 * `param ?? resolver(env)` passthrough: that shape lets a caller-supplied `NaN` (or an out-of-range-but-finite
 * value the resolver would reject from an env var) bypass the clamp entirely, silently disabling the check it
 * overrides instead of falling back to the default — exactly the bug class the `load-status` CLI's own
 * `--min-idle-pct=`/etc. overrides were fixed for (#4343 review). Routing a param through a COPY of `env` under
 * its real var name, then calling the one resolver that already owns that clamp, means there is exactly one
 * place per knob that decides what counts as valid, for BOTH an env var and a direct JS caller's param.
 * @param {{env?:NodeJS.ProcessEnv, minIdlePct?:number, minPressureLevel?:number, backstopPerCore?:number, window?:number, root?:string, now?:Date}} [o]
 * @returns {{held:boolean, idlePct:number|null, minIdlePct:number, pressureLevel:number|null, minPressureLevel:number, load1:number|null, cores:number|null, perCore:number|null, backstopPerCore:number, reason?:string, bypassed?:string}}
 */
export function resolveLoadAdmission({ env = process.env, minIdlePct, minPressureLevel, backstopPerCore, window, root, now = new Date() } = {}) {
  const effectiveEnv = { ...env };
  if (minIdlePct !== undefined) effectiveEnv[LOAD_ADMISSION_MIN_IDLE_PCT_ENV] = String(minIdlePct);
  if (minPressureLevel !== undefined) effectiveEnv[LOAD_ADMISSION_MIN_PRESSURE_LEVEL_ENV] = String(minPressureLevel);
  if (backstopPerCore !== undefined) effectiveEnv[LOAD_ADMISSION_BACKSTOP_PER_CORE_ENV] = String(backstopPerCore);
  if (window !== undefined) effectiveEnv[LOAD_ADMISSION_WINDOW_ENV] = String(window);
  const minIdle = resolveLoadAdmissionMinIdlePct(effectiveEnv);
  const minPressure = resolveLoadAdmissionMinPressureLevel(effectiveEnv);
  const backstop = resolveLoadAdmissionBackstopPerCore(effectiveEnv);
  const win = resolveLoadAdmissionWindow(effectiveEnv);
  const bypassed = (reason) => ({
    held: false, idlePct: null, minIdlePct: minIdle, pressureLevel: null, minPressureLevel: minPressure,
    load1: null, cores: null, perCore: null, backstopPerCore: backstop, bypassed: reason,
  });
  // The off/CI escape hatches read the REAL env only — never `effectiveEnv` — so a caller cannot accidentally
  // arm/disarm them by passing a knob param; those two switches have their own dedicated params were one ever
  // needed, deliberately not folded into this generic override list.
  if (isLoadAdmissionOff(env)) return bypassed('off');
  if (/^(?:true|1)$/i.test(String(env.CI || ''))) return bypassed('ci');
  const { idlePctSamples, pressureLevel, load1, cores } = readLatestLoad(root != null ? { root, now, window: win } : { now, window: win });
  return loadAdmissionDecision({ idlePctSamples, pressureLevel, load1, cores, minIdlePct: minIdle, minPressureLevel: minPressure, backstopPerCore: backstop });
}

/** The host-shared lock root for a checkout (lane or primary) — a sibling of every lane clone, never inside
 *  any one of them, so every lane on the host contends over the SAME slots. */
export function admissionLockRoot(checkoutRoot = process.cwd(), env = process.env) {
  return join(defaultPoolRoot(checkoutRoot, env), SUBDIR);
}

/** The synthetic per-slot "path" `file-locks.mjs` locks — slot identity is just its index. */
export function slotPath(i) {
  return `slot-${i}`;
}

// ── slot acquisition (thin orchestration over file-locks.mjs's existing primitives) ────────────────────

/**
 * Same-machine PID-liveness verdict (mirrors `file-locks-cli.mjs#probePidLiveness` — the layered, NEVER
 * primary, fast path: `kill(pid, 0)` throws ESRCH when no such process exists → provably 'dead'; succeeds →
 * 'alive' (the kernel reuses PIDs, so this does NOT prove it's the same owner — never accelerates a reclaim);
 * a null/own/foreign-host pid is 'unknown' (TTL-only). Wired here, not left unwired, because #3461's long
 * `ADMISSION_LEASE_MINUTES` makes the TTL floor alone too slow to recover a genuinely crashed holder.
 * @param {number|null} pid  the CURRENT holder's pid (from its lock entry), or null if unknown
 * @param {number} selfPid   the caller's own pid — never probes/accelerates against itself
 * @returns {'dead'|'alive'|'unknown'}
 */
export function probeSlotHolderLiveness(pid, selfPid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === selfPid) return 'unknown';
  try { process.kill(pid, 0); return 'alive'; }
  catch (e) { return e && e.code === 'ESRCH' ? 'dead' : 'unknown'; }
}

/**
 * Try each of `cap` slots in order; return the first one `owner` wins (free, already-own, or a stale/dead
 * holder reclaimed) via `file-locks.mjs#reserve`. Non-blocking — one attempt across all slots. Probes the
 * CURRENT holder's PID liveness itself (via {@link probeSlotHolderLiveness}) for a slot it does not already
 * own, so a provably-dead same-machine holder is reclaimed immediately regardless of `leaseMinutes` — a
 * caller-supplied `pidLiveness` is no longer accepted, so this fast path can never be silently skipped by an
 * omitted argument the way `verify-lane.mjs`'s call site originally did.
 * @returns {{ ok:boolean, slot:number|null, cap:number, heldBy:Array<{slot:number,owner:string}> }}
 */
export function tryAcquireSlot({ lockRoot, cap, owner, nowMs, nowIso, pid = null, leaseMinutes = ADMISSION_LEASE_MINUTES, meta = null, slots = null }) {
  const heldBy = [];
  const selfPid = Number.isInteger(pid) ? pid : process.pid;
  // Card xkyw1x4 — `slots` is the ORDERED list of slot indices this caller may take (`slotOrderFor`: a full
  // suite only the heavy slots `0…cap-1`; a short job the fast slots after them first, then the heavy ones).
  // Default: the `cap` heavy slots, in order (every pre-xkyw1x4 caller, and gh-throttle's own pool).
  const order = Array.isArray(slots) ? slots.filter((i) => Number.isInteger(i) && i >= 0) : Array.from({ length: cap }, (_, i) => i);
  for (const i of order) {
    const current = readLockEntry(lockRoot, slotPath(i));
    // Probe liveness whenever a slot is currently held — including a same-owner-string holder (the #3383
    // case); `probeSlotHolderLiveness` itself no-ops to 'unknown' when `current.pid === selfPid` (our own
    // slot), so it is always safe to call unconditionally here.
    const pidLiveness = current ? probeSlotHolderLiveness(current.pid, selfPid) : 'unknown';
    const r = reserve(lockRoot, slotPath(i), owner, nowMs, nowIso, selfPid, pidLiveness, leaseMinutes, meta, /* requireOwnProcess */ true);
    if (r.ok) return { ok: true, slot: i, cap, heldBy };
    heldBy.push({ slot: i, owner: r.heldBy });
  }
  return { ok: false, slot: null, cap, heldBy };
}

/**
 * Release whichever slot `owner` holds (idempotent — a no-op if it holds none). Scans rather than remembers
 * the slot index, so a caller that lost track of which slot it won (e.g. a fresh CLI invocation) can still
 * release cleanly.
 *
 * PID-DISAMBIGUATED BY DEFAULT (#3383 fix companion). Since two genuinely different real processes can now
 * legitimately hold two DIFFERENT slots under the SAME owner string (the lane path), a release must not just
 * match `owner` — it must release THIS caller's own slot, not a sibling process's. `pid` therefore defaults
 * to `process.pid`: an in-process caller releasing its own held slot (`runUnderAdmission`'s/`verify-lane.mjs`'s
 * `finally`) always resolves to itself, no code change needed at those call sites. Pass `pid: null` to opt
 * INTO the old, looser owner-only match — the deliberate escape hatch for the CLI's manual `release` mode,
 * where an operator's fresh invocation is by definition a different process than whichever one is stuck.
 * @param {number|null} [pid]  defaults to `process.pid`; pass `null` for an owner-only manual release.
 */
export function releaseOwnedSlot({ lockRoot, cap, owner, pid = process.pid, fastSlots = resolveFastSlots(process.env) }) {
  const selfPid = Number.isInteger(pid) ? pid : null;
  let ownerOnlyFallback = null;
  // Card xkyw1x4 — also scan the fast-lane slots after the heavy ones (a short job may hold one). Scanning an
  // index nobody uses (another pool, e.g. gh-throttle's) finds nothing and releases nothing.
  for (let i = 0; i < cap + fastSlots; i++) {
    const entry = readLockEntry(lockRoot, slotPath(i));
    if (!entry || entry.owner !== owner) continue;
    if (selfPid !== null && Number.isInteger(entry.pid) && entry.pid === selfPid) {
      recordReleasedHold(lockRoot, entry);
      releaseLockDir(lockRoot, slotPath(i));
      return { released: true, slot: i };
    }
    // An owner-matching slot we did not just confirm is ours by pid: keep it as a FALLBACK candidate only
    // when nothing about it actually contradicts us — either we have no pid of our own to check (the
    // deliberate `pid: null` manual/operator opt-in) or the entry itself never recorded a pid to compare
    // against (an untagged/legacy acquisition, or `tryAcquireSlot` called directly with no `pid`, as several
    // pre-#3383 tests still do). A slot that DOES carry a different real pid is provably a different real
    // process's slot and must never be picked here — that would just reintroduce this same bug in reverse.
    const safeFallback = selfPid === null || !Number.isInteger(entry.pid);
    if (safeFallback && ownerOnlyFallback === null) ownerOnlyFallback = i;
  }
  if (ownerOnlyFallback !== null) {
    recordReleasedHold(lockRoot, readLockEntry(lockRoot, slotPath(ownerOnlyFallback)));
    releaseLockDir(lockRoot, slotPath(ownerOnlyFallback));
    return { released: true, slot: ownerOnlyFallback };
  }
  return { released: false, slot: null };
}

/** Read-only snapshot of every slot's holder, for `status` / observability. */
export function heldSlots({ lockRoot, cap, fastSlots = 0 }) {
  const held = [];
  // `fastSlots` (card xkyw1x4): the heavy-admission pool's extra fast-lane slots, scanned after the heavy ones.
  for (let i = 0; i < cap + fastSlots; i++) {
    const entry = readLockEntry(lockRoot, slotPath(i));
    if (entry) held.push({ slot: i, owner: entry.owner, pid: entry.pid, heartbeatAt: entry.heartbeatAt, meta: entry.meta || null });
  }
  return held;
}

// ── waiting-intent markers — the OBSERVABLE queue (#3461 Done-when #2) ─────────────────────────────────
// A blocked caller writes ONE small marker before it starts polling and removes it the moment it wins a slot
// (or gives up). `tick-core.mjs` reads these (via `status`) and surfaces a `waiting-for-capacity` note per
// entry — never folded into #3451's after-the-fact call-visibility telemetry (a live pollable queue is a
// different signal from an access log), and it clears itself for free: nothing persists a "was waiting" fact
// past the marker's removal, so a freed slot silently un-surfaces the note on the very next tick.

function waitingDir(lockRoot) {
  return join(lockRoot, WAITING_SUBDIR);
}

function waitingFile(lockRoot, owner) {
  // Reuse file-locks.mjs's own stable id derivation so an owner string with path-unsafe characters (a lane's
  // absolute clone path) still yields a flat, filesystem-safe filename.
  return join(waitingDir(lockRoot), `${lockIdSafe(owner)}.json`);
}

// Local, tiny — pulling in `lockIdFor` from file-locks.mjs would work too, but that hashes to a 16-char id
// that erases which owner a marker belongs to when a human lists the directory by hand; this keeps the lane
// number legible (the owner strings this module receives are short: a lane path's basename or an explicit
// `--owner=`) while still stripping path separators.
function lockIdSafe(owner) {
  const flat = String(owner).replace(/[^a-zA-Z0-9._-]/g, '_');
  // Card xkyw1x4 — a plain `.slice(0, 128)` made two long owners that share a 128-char prefix (two lanes under a
  // deep pool root, e.g. a temp dir) write ONE marker file: the second waiter overwrote the first, and whichever
  // finished first deleted the other's marker. Keep short ids unchanged; give a long one a hash of the full owner.
  if (flat.length <= 128) return flat || 'unknown';
  return `${flat.slice(0, 100)}-${createHash('sha1').update(String(owner)).digest('hex').slice(0, 16)}`;
}

/** Mark `owner` as waiting for a slot. Best-effort — a write failure never blocks the caller's retry loop. */
export function markWaiting({ lockRoot, owner, lane = null, num = null, nowIso, pid = null, repo = null, kind = null }) {
  try {
    mkdirSync(waitingDir(lockRoot), { recursive: true });
    // `pid` + `host` + `repo` (xaipsbs) are what the stale-waiter reap reads to prove the owner is gone.
    // Markers written before they existed carry none of them; the reap falls back to the lane lease for those.
    // `kind` (card xkyw1x4) — which queue lane this waiter ranks in, and what `queue-status` costs it at.
    const body = { owner: String(owner), lane, num, requestedAt: nowIso, pid: Number.isInteger(pid) ? pid : null, host: hostname(), repo, ...(kind ? { kind } : {}) };
    writeFileSync(waitingFile(lockRoot, owner), JSON.stringify(body, null, 2) + '\n', 'utf8');
  } catch { /* best-effort — the wait itself must never fail on a marker write */ }
}

/** Clear `owner`'s waiting marker (idempotent — a no-op if absent). */
export function clearWaiting({ lockRoot, owner }) {
  try { unlinkSync(waitingFile(lockRoot, owner)); } catch { /* already gone, or never written */ }
}

/** List every live waiting marker. Tolerant of a corrupt entry (skipped, never thrown). */
export function listWaiting(lockRoot) {
  let names;
  try { names = readdirSync(waitingDir(lockRoot)); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = readFileSync(join(waitingDir(lockRoot), name), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.owner) out.push(parsed);
    } catch { /* corrupt marker — skip, never surface as a phantom waiter */ }
  }
  return out;
}

// ── stale-waiter reap (xaipsbs) ─────────────────────────────────────────────────────────────────────────
// A waiter killed hard (SIGKILL, a closed terminal, a crashed host) never reaches the `finally` that clears
// its marker, so the marker sits in `waiting/` forever and `tick-core.mjs` keeps reporting a phantom
// `waiting-for-capacity` note. Four such markers (2026-09-04 and 2026-09-14) were found in the live pool on
// 2026-09-21. The next admission attempt removes them; `status` counts them; `reap` previews and `--apply`s.

/** Every marker file with its parsed body. Corrupt files are returned with `marker: null`. */
function listWaitingFiles(lockRoot) {
  let names;
  try { names = readdirSync(waitingDir(lockRoot)); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = join(waitingDir(lockRoot), name);
    let marker = null;
    try { marker = JSON.parse(readFileSync(file, 'utf8')); } catch { /* corrupt — reported as such */ }
    out.push({ file, marker });
  }
  return out;
}

/** The checkout a marker belongs to: its `repo` field, else its owner with any `#<pid>` suffix removed. */
export function waiterRepo(marker) {
  if (marker && typeof marker.repo === 'string' && marker.repo) return marker.repo;
  return String((marker && marker.owner) || '').replace(/#\d+$/, '');
}

/** Read a lane clone's lease marker, or null when there is none (or it is unreadable). */
export function readLaneLease(repo) {
  try { return JSON.parse(readFileSync(join(repo, '.git', LEASE_FILENAME), 'utf8')); } catch { return null; }
}

/**
 * Should this waiting marker be reaped? Pure over its seams. Reap needs BOTH: older than `ttlMs`, AND the
 * owner provably gone. "Gone" is read from the best evidence the marker has, in this order:
 *   1. a `pid` recorded on THIS host: dead → gone; alive → kept (it may be a long custom wait).
 *   2. the owner is a lane clone (`…/lane-N`): no live lease → gone; a live lease acquired AFTER the marker
 *      was written → gone (the lane has been handed to someone else since, so this waiter is not its holder);
 *      a live lease older than the marker → kept.
 *   3. no pid and not a lane (an old primary-checkout marker) → kept: nothing proves the owner is gone.
 * @returns {{ reap:boolean, reason:string }}
 */
export function classifyWaiter(marker, { nowMs, ttlMs = WAITING_TTL_MINUTES * 60_000, host = hostname(), pidLiveness = (pid) => probeSlotHolderLiveness(pid, process.pid), readLease = readLaneLease } = {}) {
  if (!marker || typeof marker !== 'object') return { reap: true, reason: 'corrupt' };
  const at = Date.parse(marker.requestedAt);
  const ageMs = Number.isNaN(at) ? Infinity : nowMs - at;
  if (ageMs < ttlMs) return { reap: false, reason: 'fresh' };
  if (Number.isInteger(marker.pid) && (!marker.host || marker.host === host)) {
    const live = pidLiveness(marker.pid);
    if (live === 'dead') return { reap: true, reason: 'pid-dead' };
    if (live === 'alive') return { reap: false, reason: 'pid-alive' };
  }
  const repo = waiterRepo(marker);
  if (/^lane-\d+$/.test(basename(repo))) {
    const lease = readLease(repo);
    if (!lease || isLeaseStale(lease, nowMs)) return { reap: true, reason: 'no-lease' };
    const leasedAt = Date.parse(lease.acquiredAt);
    if (!Number.isNaN(at) && !Number.isNaN(leasedAt) && leasedAt > at) return { reap: true, reason: 'lease-newer' };
    return { reap: false, reason: 'lease-live' };
  }
  return { reap: false, reason: 'owner-unknown' };
}

/**
 * Find (and with `apply`, remove) every stale waiting marker. Each removal is appended to `reaped.jsonl`
 * beside the slots so `status` can report how many were reaped. Never throws.
 * @returns {{ reaped:Array<object>, kept:Array<object> }}
 */
export function reapStaleWaiters({ lockRoot, nowMs = Date.now(), ttlMs = WAITING_TTL_MINUTES * 60_000, apply = false, ...seams }) {
  const reaped = [];
  const kept = [];
  for (const { file, marker } of listWaitingFiles(lockRoot)) {
    const verdict = isDeadOwnerWaiter(marker, seams)
      ? { reap: true, reason: 'pid-dead' }
      : classifyWaiter(marker, { nowMs, ttlMs, ...seams });
    const row = { owner: marker && marker.owner, lane: marker && marker.lane, requestedAt: marker && marker.requestedAt, reason: verdict.reason };
    if (!verdict.reap) { kept.push(row); continue; }
    if (apply) {
      try { unlinkSync(file); } catch { continue; /* raced with its own clear, or unwritable — not reaped */ }
      try { appendFileSync(join(lockRoot, REAP_LOG), JSON.stringify({ ...row, reapedAt: new Date(nowMs).toISOString() }) + '\n', 'utf8'); } catch { /* best-effort */ }
    }
    reaped.push(row);
  }
  return { reaped, kept };
}

/** How many markers the reap has removed so far, and the most recent one. */
export function reapHistory(lockRoot) {
  let lines = [];
  try { lines = readFileSync(join(lockRoot, REAP_LOG), 'utf8').split('\n').filter(Boolean); } catch { /* none yet */ }
  let last = null;
  try { last = lines.length ? JSON.parse(lines[lines.length - 1]) : null; } catch { /* corrupt tail */ }
  return { count: lines.length, last };
}

// ── MECHANICAL FAIRNESS — first-come-first-served slot admission (#3383 card xb0iuxq) ─────────────────────
// Until now `acquireSlotBlocking` let ANY blocked poller win a slot the instant `tryAcquireSlot` found one
// free — "try slot-0, then slot-1, …, poll every 2s" has no notion of arrival order, so a job that started
// waiting a minute ago can lose a freed slot to one that started waiting a second ago, purely on which
// poller's 2s timer happened to land first. Live-observed 2026-09-25: a `check:standards` waiter on lane-16
// waited 47+ minutes while several newer jobs each took a slot ahead of it. The liveness + lease-TTL reclaim
// mechanism above (`tryAcquireSlot`/`reclaimDecision`) is UNCHANGED — this only adds a queueing DISCIPLINE in
// front of it: a poller may attempt `tryAcquireSlot` at all only when it is the OLDEST LIVE waiter, by
// `requestedAt`, ignoring any marker that is dead or stale. A solo/uncontended caller (no other live marker
// exists) is always "oldest" and pays no new cost.
//
// LIVENESS FOR RANKING IS NOT {@link classifyWaiter}'S REAP VERDICT — an independent review of the first cut
// of this fix (PR #2692) caught a real starvation regression: `classifyWaiter`'s `ageMs < ttlMs` ⇒ `'fresh'`
// shortcut skips the pid-liveness probe ENTIRELY for any marker younger than {@link WAITING_TTL_MINUTES}
// (30min) — appropriate for REAPING (removing stale debris is conservative on purpose), but wrong for RANKING
// who may attempt a slot next. A waiter that writes its marker and is then SIGKILLed/host-crashed before
// winning a slot (never reaching its own `finally`'s `clearWaiting` — the exact scenario {@link
// reapStaleWaiters}'s own header cites as observed 4x in 2.5 weeks) leaves a marker that is FRESH by the clock
// but DEAD by pid — and under the naive "just reuse classifyWaiter's verdict" version, that dead marker still
// ranked oldest/live for up to 30 minutes, blocking every other live waiter from even ATTEMPTING a completely
// free slot (strictly worse than pre-fix behaviour, which had no ranking gate at all). {@link
// isOldestLiveWaiter} therefore probes pid-liveness directly, independent of age, for every marker recording a
// same-host pid — a provably-dead pid is excluded from ranking immediately, never after waiting out the TTL —
// and otherwise still defers to {@link classifyWaiter} (no lease / TTL-stale-with-no-evidence) for every case
// pid-liveness alone cannot decide.

/**
 * Does this waiting marker count as a genuinely live waiter for queue ORDER (ranking, and the `heavy-queue`
 * report's wait projection)? False when {@link classifyWaiter} would reap it, or — even while it is still
 * fresh — when its recorded pid on THIS host is provably dead (the section header above says why). One rule,
 * shared by {@link isOldestLiveWaiter} and `heavy-queue`, so the report never counts a waiter the queue skips.
 * @returns {boolean}
 */
export function isRankableWaiter(marker, {
  nowMs, ttlMs = WAITING_TTL_MINUTES * 60_000,
  pidLiveness = (pid) => probeSlotHolderLiveness(pid, process.pid), host = hostname(), ...seams
} = {}) {
  if (!marker || typeof marker !== 'object') return false;
  // Same-host pid, independent of the marker's age: a provably-dead owner never ranks as live.
  if (Number.isInteger(marker.pid) && (!marker.host || marker.host === host) && pidLiveness(marker.pid) === 'dead') return false;
  return !classifyWaiter(marker, { nowMs, ttlMs, host, pidLiveness, ...seams }).reap;
}

/** Positive same-host evidence permits removal at any age; unknown liveness never does. */
export function isDeadOwnerWaiter(marker, {
  host = hostname(), pidLiveness = (pid) => probeSlotHolderLiveness(pid, process.pid),
} = {}) {
  return !!marker && Number.isInteger(marker.pid)
    && (!marker.host || marker.host === host) && pidLiveness(marker.pid) === 'dead';
}

/**
 * Is `owner` the one waiter currently permitted to attempt a slot? True when either nobody else holds a live
 * waiting marker (including `owner`'s own — a caller that has not yet written one, or whose write raced,
 * defaults to eligible rather than wedging), or `owner`'s own marker is the earliest live `requestedAt`. Ties
 * (identical timestamps) break on `owner` string so the ranking is deterministic rather than depending on
 * directory-listing order. Pure over the markers it is handed by {@link listWaiting}, filtered through {@link
 * isRankableWaiter} (see the section header above for why this cannot simply reuse {@link classifyWaiter}'s
 * age-gated reap verdict).
 * @param {{lockRoot:string, owner:string, nowMs:number, ttlMs?:number, pidLiveness?:(pid:number)=>('dead'|'alive'|'unknown'), host?:string}} o
 * @returns {boolean}
 */
export function isOldestLiveWaiter({ lockRoot, owner, nowMs, ttlMs = WAITING_TTL_MINUTES * 60_000, kind = undefined, ...seams }) {
  // Card xkyw1x4 — THE FAST LANE. With a `kind`, rank only against waiters in the SAME queue lane: a short job is
  // never behind a full-suite waiter, and first-come-first-served (#2692) still holds inside each lane. A marker
  // with no `kind` (written by older code) ranks in the slow lane. Without a `kind`: one global queue, as before.
  const lane = kind === undefined ? null : queueLaneOf(normalizeKind(kind));
  const live = listWaiting(lockRoot)
    .filter((m) => isRankableWaiter(m, { nowMs, ttlMs, ...seams }))
    .filter((m) => lane === null || queueLaneOf(normalizeKind(m.kind)) === lane);
  if (live.length === 0) return true;
  const oldest = [...live].sort((a, b) => {
    const at = Date.parse(a.requestedAt), bt = Date.parse(b.requestedAt);
    const an = Number.isNaN(at) ? Infinity : at, bn = Number.isNaN(bt) ? Infinity : bt;
    return an !== bn ? an - bn : String(a.owner).localeCompare(String(b.owner));
  })[0];
  return oldest.owner === owner;
}

// ── the blocking wait primitive a heavy-command call site uses ─────────────────────────────────────────

/**
 * Poll for a free slot until one is won or the hard `ceilingMs` elapses (xhlriy2, #3383). A waiter never runs
 * unslotted merely because time has passed while a slot holder is alive: each failed {@link tryAcquireSlot}
 * attempt already reclaims a slot the instant every holder is provably dead or lease-expired (via the PID
 * fast-path + lease-TTL floor above), so as long as this loop keeps losing, at least one holder is still alive
 * with an unexpired lease. While blocked it logs a periodic "still waiting" line every {@link
 * STILL_WAITING_LOG_MS} — plain observability, not a give-up signal. Only `ceilingMs` (default {@link
 * DEFAULT_ADMISSION_CEILING_MS}) FAILS OPEN — `{ ok:false, timedOut:true, ceilingHit:true }`, with a loud
 * warning — never throwing and never blocking truly forever: a wedged holder must not strand a lane's whole
 * delivery arc. `WE_HEAVY_ADMISSION=off` ({@link isAdmissionOff}) is the explicit escape hatch — checked FIRST,
 * before this function ever touches the lock root, so it is a pure pass-through (`{ ok:false, disabled:true }`).
 * @param {object} opts
 * @param {string} opts.lockRoot
 * @param {number} opts.cap
 * @param {string} opts.owner
 * @param {string|null} [opts.lane]
 * @param {number} [opts.pollMs]
 * @param {number} [opts.ceilingMs]        hard give-up ceiling; defaults to {@link DEFAULT_ADMISSION_CEILING_MS}
 * @param {number} [opts.stillWaitingLogMs]  periodic log cadence; defaults to {@link STILL_WAITING_LOG_MS}
 * @param {number} [opts.leaseMinutes]
 * @param {(msg:string)=>void} [opts.log]  defaults to `process.stderr.write` — injectable for tests
 * @param {object} [opts.env]              defaults to `process.env` — injectable for tests
 * @param {() => number} [opts.now]         defaults to Date.now
 * @param {(ms:number) => Promise<void>} [opts.sleep]  defaults to a real timer
 * @returns {Promise<{ ok:boolean, slot:number|null, timedOut:boolean, waitedMs:number, disabled?:boolean, ceilingHit?:boolean }>}
 */
export async function acquireSlotBlocking({
  lockRoot, cap, owner, lane = null, num = null, repo = null, kind = null,
  pollMs = DEFAULT_POLL_MS, ceilingMs = DEFAULT_ADMISSION_CEILING_MS, leaseMinutes = ADMISSION_LEASE_MINUTES,
  stillWaitingLogMs = STILL_WAITING_LOG_MS,
  pid = process.pid, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = (m) => process.stderr.write(m), env = process.env, ...seams
}) {
  if (isAdmissionOff(env)) return { ok: false, slot: null, timedOut: false, disabled: true, waitedMs: 0 };

  const startedAt = now();
  // Card xkyw1x4 — the command KIND decides the queue lane and which slots may be taken (fast lane).
  const jobKind = normalizeKind(kind);
  const fastSlots = resolveFastSlots(env);
  const slotOrder = slotOrderFor(jobKind, cap, fastSlots);
  // xaipsbs — every admission attempt first clears stale waiters, so debris never outlives the next caller.
  reapStaleWaiters({ lockRoot, nowMs: startedAt, apply: true, ...seams });
  // MECHANICAL FAIRNESS (#3383 card xb0iuxq) — mark BEFORE the first attempt, not only after it fails, so
  // even this caller's very first, otherwise-uncontended attempt is ranked against whoever else is ALREADY
  // waiting: a caller landing behind an older live waiter must never cut in front of it just because
  // `tryAcquireSlot` itself would have won a slot for it. A caller with no contention (the common case) still
  // succeeds with zero wait below — `isOldestLiveWaiter` reports it "oldest" (nothing else live to rank
  // against) on its very first check.
  markWaiting({ lockRoot, owner, lane, num, pid, repo, kind: jobKind, nowIso: new Date(startedAt).toISOString() });
  let lastLoggedAt = startedAt;
  try {
    for (;;) {
      const attempt = now();
      reapStaleWaiters({ lockRoot, nowMs: attempt, apply: true, ...seams });
      if (attempt - startedAt >= ceilingMs) {
        log(`⚠⚠ heavy-command admission: HARD CEILING of ${Math.round(ceilingMs / 60_000)}m exceeded waiting for capacity (cap=${cap}) — a slot holder may be wedged; proceeding unslotted. Escape hatch: WE_HEAVY_ADMISSION=off.\n`);
        return { ok: false, slot: null, timedOut: true, ceilingHit: true, waitedMs: attempt - startedAt };
      }
      if (isOldestLiveWaiter({ lockRoot, owner, nowMs: attempt, kind: jobKind, ...seams })) {
        const nowIso = new Date(attempt).toISOString();
        // `meta` carries the kind + acquire time so the release can record the hold duration by kind.
        const meta = { kind: jobKind, acquiredAt: nowIso, lane: lane ?? null };
        const r = tryAcquireSlot({ lockRoot, cap, owner, nowMs: attempt, nowIso, pid, leaseMinutes, meta, slots: slotOrder });
        if (r.ok) return { ok: true, slot: r.slot, timedOut: false, waitedMs: attempt - startedAt };
      }
      if (attempt - lastLoggedAt >= stillWaitingLogMs) {
        log(`heavy-command admission: still waiting for a free slot (cap=${cap}) after ${Math.round((attempt - startedAt) / 60_000)}m — every held slot's holder still appears alive; will proceed unslotted at the ${Math.round(ceilingMs / 60_000)}m ceiling.\n`);
        lastLoggedAt = attempt;
      }
      await sleep(pollMs);
    }
  } finally {
    clearWaiting({ lockRoot, owner });
  }
}

// ── hold durations + the queue baseline (card xkyw1x4) ──────────────────────────────────────────────────
// Every release of a slot whose entry carries `meta.kind` (written by {@link acquireSlotBlocking}) appends ONE
// line to `durations.jsonl` beside the slots: `{kind, ms, lane, repo, at}`. {@link readStandardMinutes} turns the
// tail of that log into the rolling typical time per kind. Best-effort on both sides: a write failure never
// fails a release, and an unreadable log reads as "no samples" (the seeds apply).

const DURATIONS_LOG = 'durations.jsonl';
/** Keep the log bounded: once it passes this many lines, the next append rewrites it to the newest half. */
export const DURATIONS_LOG_MAX_LINES = 2000;

/** Append one hold-duration record. Never throws. */
export function recordHoldDuration({ lockRoot, kind, ms, lane = null, repo = null, at = new Date().toISOString(), dispatchKind = null, session = null, leaseAcquiredAt = null }) {
  if (!Number.isFinite(ms) || ms < 0) return false;
  const file = join(lockRoot, DURATIONS_LOG);
  try {
    mkdirSync(lockRoot, { recursive: true });
    appendFileSync(file, JSON.stringify({
      kind: normalizeKind(kind), ms: Math.round(ms), lane, repo, at,
      ...(dispatchKind != null ? { dispatchKind } : {}),
      ...(session != null ? { session } : {}),
      ...(leaseAcquiredAt != null ? { leaseAcquiredAt } : {}),
    }) + '\n', 'utf8');
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length > DURATIONS_LOG_MAX_LINES) writeFileSync(file, lines.slice(-Math.floor(DURATIONS_LOG_MAX_LINES / 2)).join('\n') + '\n', 'utf8');
    return true;
  } catch { return false; }
}

/** The hold that is being released, recorded by kind. Only entries this card's code wrote (with `meta.kind`)
 *  are recorded — an older holder's kind is unknown, and a guess would poison the typical value. */
function recordReleasedHold(lockRoot, entry, nowMs = Date.now()) {
  const kind = entry?.meta?.kind;
  if (!kind) return;
  const started = Date.parse(entry.meta.acquiredAt || entry.heartbeatAt);
  if (Number.isNaN(started)) return;
  const repo = repoOfOwner(entry.owner);
  let lease = null;
  try { if (repo) lease = readLaneLease(repo); } catch { /* lease metadata is best-effort */ }
  recordHoldDuration({
    lockRoot, kind, ms: nowMs - started, lane: entry.meta.lane ?? null, repo, at: new Date(nowMs).toISOString(),
    dispatchKind: classifyDispatchKind(lease), session: lease?.holder || lease?.session || null, leaseAcquiredAt: lease?.acquiredAt || null,
  });
}

/** Parsed duration records, oldest first. Corrupt lines are skipped. */
export function readHoldDurations(lockRoot) {
  let raw = '';
  try { raw = readFileSync(join(lockRoot, DURATIONS_LOG), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { const r = JSON.parse(line); if (r && Number.isFinite(r.ms)) out.push(r); } catch { /* corrupt line */ }
  }
  return out;
}

/** The rolling typical minutes per kind (+ where each came from: `rolling` n samples, or the `seed`). */
export function readStandardMinutes(lockRoot) {
  return typicalMinutes(readHoldDurations(lockRoot));
}

/** A slot owner is `<repo>` (verify-lane) or `<repo>#<pid>` (the `run` wrapper) — the repo part. */
function repoOfOwner(owner) {
  return String(owner || '').replace(/#\d+$/, '') || null;
}

/** Resolve the max projected wait (minutes) from env, clamped to > 0. */
export function resolveQueueMaxWaitMinutes(env = process.env) {
  const n = Number(env?.[QUEUE_MAX_WAIT_ENV]);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_QUEUE_MAX_WAIT_MINUTES;
}

/** True when the queue-time gate is switched off (`WE_QUEUE_ADMISSION=off|0|false|no`). */
export function isQueueAdmissionOff(env = process.env) {
  return /^(?:off|0|false|no)$/i.test(String(env?.[QUEUE_ADMISSION_SWITCH_ENV] || ''));
}

/**
 * Every lane lease under the pool root (`<pool>/<repo-pool>/lane-N/.git/.lane-lease`), as `{repo, lease}`.
 * The heavy-admission root is host-wide (`<pool>/.admission/heavy`), so every repo pool's lanes feed it.
 */
export function readPoolLeases(poolRoot) {
  const out = [];
  let pools = [];
  try { pools = readdirSync(poolRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name); } catch { return out; }
  for (const pool of pools) {
    let lanes = [];
    try { lanes = readdirSync(join(poolRoot, pool)).filter((n) => /^lane-\d+$/.test(n)); } catch { continue; }
    for (const lane of lanes) {
      const repo = join(poolRoot, pool, lane);
      const lease = readLaneLease(repo);
      if (lease) out.push({ repo, lease });
    }
  }
  return out;
}

/**
 * THE QUEUE BASELINE — everything already on its way to the heavy slots, in slot-minutes, plus what a caller
 * needs to cost new dispatches against it (`createQueueBudget` in `./heavy-queue-projection.mjs`). Split by
 * queue lane (PR #2707 operator decision): heavy demand over the `cap` heavy slots, short demand (short holders /
 * waiters + every pending dispatch) over the fast slots + the heavy slots no heavy job holds or waits for.
 * `projectedWaitMinutes` is the SHORT-lane wait — what a new dispatch's checks would see; `heavyWaitMinutes` is
 * what a new full suite would see.
 *   • held:    each held slot's kind (its `meta.kind`; `other` for a holder written by older code) and elapsed time;
 *   • waiting: each LIVE waiter ({@link isRankableWaiter} — the same rule the FCFS ranking uses) and its kind;
 *   • pending: each lane leased by a recognised dispatched session (`classifyDispatchKind`) within the last
 *     `arrivalWindowMinutes`, that is not holding or waiting yet and has not already finished a hold since its
 *     lease began — costed at its dispatch kind's expected demand.
 * Read-only: never reaps, never writes. `WE_QUEUE_ADMISSION=off` → `{bypassed:'off'}` and
 * `CI` → `{bypassed:'ci'}`, both of which every consumer treats as "admit everything".
 * @param {{lockRoot:string, cap:number, nowMs?:number, env?:object, arrivalWindowMinutes?:number,
 *   readLeases?:(poolRoot:string)=>Array<{repo:string, lease:object}>, isLiveWaiter?:Function}} o
 */
export function resolveQueueBaseline({
  lockRoot, cap, nowMs = Date.now(), env = process.env, arrivalWindowMinutes = DEFAULT_ARRIVAL_WINDOW_MINUTES,
  readLeases = readPoolLeases, isLiveWaiter = isRankableWaiter,
}) {
  const maxWaitMinutes = resolveQueueMaxWaitMinutes(env);
  const fastSlots = resolveFastSlots(env);
  const base = { slots: cap + fastSlots, heavySlots: cap, fastSlots, maxWaitMinutes, arrivalWindowMinutes, observedAt: new Date(nowMs).toISOString() };
  if (isQueueAdmissionOff(env)) return { ...base, bypassed: 'off' };
  if (/^(?:true|1)$/i.test(String(env?.CI || ''))) return { ...base, bypassed: 'ci' };

  const { minutes: standardMinutes, source: standardSource } = readStandardMinutes(lockRoot);
  const durations = readHoldDurations(lockRoot);
  const { minutes: dispatchMinutes, source: dispatchSource } = typicalDispatchMinutes(durations);
  const prepareAdmission = resolvePrepareAdmission(env);
  const held = heldSlots({ lockRoot, cap, fastSlots }).map((h) => {
    const startedIso = h.meta?.acquiredAt || h.heartbeatAt;
    const started = Date.parse(startedIso);
    return {
      slot: h.slot, kind: normalizeKind(h.meta?.kind), repo: repoOfOwner(h.owner), lane: h.meta?.lane ?? null,
      elapsedMinutes: Number.isNaN(started) ? 0 : Math.round(((nowMs - started) / 60_000) * 100) / 100,
    };
  });
  const waiting = listWaiting(lockRoot)
    .filter((m) => isLiveWaiter(m, { nowMs }))
    .map((m) => ({ kind: normalizeKind(m.kind), repo: waiterRepo(m), lane: m.lane ?? null, requestedAt: m.requestedAt }));

  const busyRepos = new Set([...held.map((h) => h.repo), ...waiting.map((w) => w.repo)].filter(Boolean));
  const windowMs = arrivalWindowMinutes * 60_000;
  const pending = [];
  let leases = [];
  try { leases = readLeases(poolRootOf(lockRoot)) || []; } catch { leases = []; }
  for (const { repo, lease } of leases) {
    const acquired = Date.parse(lease?.acquiredAt);
    if (Number.isNaN(acquired) || nowMs - acquired > windowMs || nowMs < acquired) continue;
    if (isLeaseStale(lease, nowMs)) continue;
    if (busyRepos.has(repo)) continue; // already counted as held / waiting
    // Already ran (and finished) a heavy command since this lease began → it has arrived; not pending.
    if (durations.some((d) => d.repo === repo && Date.parse(d.at) >= acquired)) continue;
    const dispatchKind = classifyDispatchKind(lease);
    if (!dispatchKind) continue;
    const demandMinutes = dispatchDemandMinutes(dispatchKind, { standardMinutes, dispatchMinutes, prepareAdmission });
    if (demandMinutes <= 0) continue;
    pending.push({
      repo, lane: (/lane-(\d+)$/.exec(repo) || [])[1] ?? null, dispatchKind, purpose: lease.purpose ?? null,
      session: lease.session ?? null, ageMinutes: Math.round(((nowMs - acquired) / 60_000) * 10) / 10, demandMinutes,
    });
  }

  const backlog = queueBacklog({ held, waiting, pending, standardMinutes });
  const lanes = laneProjection({
    heavySlots: cap, fastSlots, heavyBacklogMinutes: backlog.heavyBacklogMinutes, shortBacklogMinutes: backlog.shortBacklogMinutes,
    heldHeavyCount: backlog.heldHeavyCount, waitingHeavyCount: backlog.waitingHeavyCount,
  });
  return {
    ...base, standardMinutes, standardSource, dispatchMinutes, dispatchSource, prepareAdmission,
    heldRemainingMinutes: backlog.heldRemainingMinutes, waitingMinutes: backlog.waitingMinutes, pendingMinutes: backlog.pendingMinutes,
    backlogMinutes: backlog.backlogMinutes,
    heavyBacklogMinutes: backlog.heavyBacklogMinutes, shortBacklogMinutes: backlog.shortBacklogMinutes,
    heldHeavyCount: backlog.heldHeavyCount, waitingHeavyCount: backlog.waitingHeavyCount,
    freeHeavySlots: lanes.freeHeavySlots, shortCapacity: lanes.shortCapacity,
    heavyWaitMinutes: lanes.heavyWaitMinutes,
    projectedWaitMinutes: lanes.shortWaitMinutes,
    held: backlog.held, waiting: backlog.waiting, pending,
  };
}

/**
 * The one-call live baseline for a checkout (the fix / ci-heal daemons and the tick IO shell use this): lock root
 * + cap from env, then {@link resolveQueueBaseline}. FAILS OPEN — any read error returns `{bypassed:'error'}`.
 * The pool root is `guardedPoolRoot`'s: inside a vitest worker with no `LANE_POOL_ROOT` override it throws, so a
 * test that forgot to inject a baseline admits everything instead of reading the real host queue.
 */
export function resolveLiveQueueBaseline({ checkoutRoot = process.cwd(), env = process.env, nowMs = Date.now() } = {}) {
  try {
    return resolveQueueBaseline({ lockRoot: join(guardedPoolRoot(checkoutRoot, env), SUBDIR), cap: resolveCap(env), nowMs, env });
  } catch (e) {
    return { bypassed: 'error', error: String((e && e.message) || e).split('\n')[0] };
  }
}

// ── status — what `tick-core.mjs` reads for the `waiting-for-capacity` note ────────────────────────────

export function admissionStatus({ lockRoot, cap, nowMs = Date.now(), fastSlots = 0, ...reapSeams }) {
  // `fastSlots` (card xkyw1x4): the heavy-admission CLI passes its fast-lane slots so they show as held / free;
  // other pools on these primitives (gh-throttle) have none.
  const held = heldSlots({ lockRoot, cap, fastSlots });
  const waiting = listWaiting(lockRoot).filter((marker) => isRankableWaiter(marker, { nowMs, ...reapSeams }));
  // xaipsbs — `reaped` is what the reap has removed so far; `staleWaiting` is what it WOULD remove right now.
  const staleWaiting = reapStaleWaiters({ lockRoot, nowMs, apply: false, ...reapSeams }).reaped.length;
  const heavyHeld = held.filter((h) => h.slot < cap).length;
  return {
    cap, fastSlots, heldCount: held.length, freeCount: Math.max(0, cap + fastSlots - held.length),
    heavyFreeCount: Math.max(0, cap - heavyHeld), fastFreeCount: Math.max(0, fastSlots - (held.length - heavyHeld)),
    held, waiting, staleWaiting, reaped: reapHistory(lockRoot),
  };
}

/**
 * Why the wrapper should NOT queue this command, or null to queue it (xaipsbs). Pure over `env` + `poolExists`.
 *   • `held` — an outer wrapper (or `verify-lane.mjs`) already holds a slot for this work;
 *   • `ci`   — `CI=true`/`1`: a CI runner is its own machine and has no host pool;
 *   • `off`  — `WE_HEAVY_ADMISSION=off|0|false`, the explicit switch;
 *   • `no-pool` — the lane-pool root does not exist (a fresh clone, a VM with no pool), so there is nothing
 *     to share and nothing to create.
 */
export function admissionBypassReason({ env = process.env, poolExists = true } = {}) {
  if (env[ADMISSION_HELD_ENV] === '1') return 'held';
  if (/^(?:true|1)$/i.test(String(env.CI || ''))) return 'ci';
  if (isAdmissionOff(env)) return 'off'; // xhlriy2 — same switch/regex acquireSlotBlocking now checks directly
  if (!poolExists) return 'no-pool';
  return null;
}

/** The pool root a lock root lives under (`<pool>/.admission/heavy` → `<pool>`). */
export function poolRootOf(lockRoot) {
  return dirname(dirname(lockRoot));
}

// ── run-under-admission — general-purpose wrapper, WITH the #3621 container hook built in ─────────────────
//
// This is the minimal general-purpose "acquire a slot → run a command → release" wrapper this module did not
// yet have on `main` as of this POC (a fuller version exists on the separate, still-unmerged
// `lane/mechanical-dispatcher` integration branch — #3383's own finding — landing here independently rather
// than waiting on that branch, since main needed a real entry point for THIS item's container work today; the
// two will need reconciling, likely a straightforward union, whenever that branch merges).
//
// The `exec` seam is exactly what makes the #3621 heavy-command-pool container POC possible: by default it
// runs `command` on the HOST (`execSync`, unchanged behaviour), but a caller can inject
// `scripts/lib/container-exec.mjs#execContainerized` instead — same acquire/execute/release sequencing, the
// command now runs inside a real, CPU/memory-capped Apple `container` instance. See that module's own header
// for exactly what is (and is not yet) proven to work this way.

/**
 * Run `command` synchronously in the FOREGROUND, admitted through the SAME capacity semaphore this module's
 * `acquire`/`release` CLI modes already use. FAILS OPEN on a queuing timeout (mirrors `acquireSlotBlocking`
 * itself): `command` still runs, unslotted, with a stderr warning, rather than being refused — a queuing
 * timeout must never strand an otherwise-healthy caller.
 * @param {object} opts
 * @param {string} opts.lockRoot
 * @param {number} opts.cap
 * @param {string} opts.owner
 * @param {string|null} [opts.lane]
 * @param {string|null} [opts.num]
 * @param {number} [opts.ceilingMs]        hard give-up ceiling passed to {@link acquireSlotBlocking} (xhlriy2)
 * @param {number} [opts.leaseMinutes]
 * @param {string} opts.command            the shell command to run (already shell-quoted by the CLI)
 * @param {string} [opts.cwd]              defaults to process.cwd()
 * @param {(cmd:string, opts:object)=>void} [opts.exec]  defaults to `execSync` — injectable; #3621's
 *   container POC passes `container-exec.mjs#execContainerized` here instead
 * @param {(msg:string)=>void} [opts.log]  defaults to `process.stderr.write` — injectable for tests
 * @param {object} [opts.env]              defaults to `process.env` — injectable for tests
 * @param {() => number} [opts.now]
 * @param {(ms:number) => Promise<void>} [opts.sleep]
 * @returns {Promise<{ exitCode:number, admission:object }>}
 */
export async function runUnderAdmission({
  lockRoot, cap, owner, lane = null, num = null, repo = null, ceilingMs = DEFAULT_ADMISSION_CEILING_MS, leaseMinutes = ADMISSION_LEASE_MINUTES,
  kind = null, command, cwd = process.cwd(), exec = (cmd, o) => execSync(cmd, o), log = (m) => process.stderr.write(m),
  now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  bypass = null, env = process.env,
}) {
  // The child always runs with the re-entrancy flag, so anything it runs that is itself wrapped passes through.
  const childEnv = { ...env, [ADMISSION_HELD_ENV]: '1' };
  if (bypass) {
    let exitCode = 0;
    try { exec(command, { cwd, stdio: 'inherit', env: bypass === 'held' ? env : childEnv }); }
    catch (e) { exitCode = Number.isFinite(e && e.status) ? e.status : 1; }
    return { exitCode, admission: { ok: false, slot: null, timedOut: false, waitedMs: 0, bypassed: bypass } };
  }
  mkdirSync(lockRoot, { recursive: true });
  // xhlriy2: `log`/`env` threaded through so acquireSlotBlocking's still-waiting/ceiling warnings and its own
  // `WE_HEAVY_ADMISSION=off` check apply to the `run` wrapper's wait too, not just this function's own messages.
  // Card xkyw1x4 — the kind is read off the wrapped command itself unless the caller names it.
  const admission = await acquireSlotBlocking({ lockRoot, cap, owner, lane, num, repo, kind: kind ?? classifyCommandKind(command), ceilingMs, leaseMinutes, now, sleep, log, env });
  if (admission.timedOut) {
    log(`⚠ heavy-command admission: timed out after ${admission.waitedMs}ms waiting for capacity (cap=${cap}) — proceeding unslotted.\n`);
  } else if (admission.waitedMs > 0) {
    log(`heavy-command admission: acquired slot-${admission.slot} after waiting ${admission.waitedMs}ms (cap=${cap}).\n`);
  }
  let exitCode = 0;
  try {
    exec(command, { cwd, stdio: 'inherit', env: childEnv });
  } catch (e) {
    exitCode = Number.isFinite(e && e.status) ? e.status : 1;
  } finally {
    if (admission.ok) releaseOwnedSlot({ lockRoot, cap, owner, fastSlots: resolveFastSlots(env) });
  }
  return { exitCode, admission };
}

/**
 * The argv that runs `file args…` through the `run` wrapper, for SYNCHRONOUS callers (`execFileSync` /
 * `spawnSync`) that cannot await {@link runUnderAdmission} (xaipsbs). The wrapper is a child process whose
 * stdio, exit code and output are the wrapped command's own, so a caller that captures output or reads
 * `e.status` keeps working unchanged. Pass it as `execFileSync(r.file, r.args, opts)`.
 * @returns {{ file:string, args:string[] }}
 */
export function admittedArgv(file, args = []) {
  return { file: process.execPath, args: [HEAVY_ADMISSION_CLI, 'run', '--', file, ...args] };
}

/** The shell command line that runs a shell command string through the `run` wrapper (as `sh -c <cmd>`, so
 *  `&&`/`||` in it keep their meaning and the whole chain holds ONE slot). For `execSync(string)` callers. */
export function admittedShellCommand(command) {
  return [process.execPath, HEAVY_ADMISSION_CLI, 'run', '--', 'sh', '-c', command].map(shellQuoteWord).join(' ');
}

/** Re-quote a single already-split argv word for a shell command line — a no-op for a plain word,
 *  single-quoted (embedded `'` escaped the POSIX way) otherwise, so `run`'s command tail round-trips through
 *  `execSync`'s underlying `/bin/sh -c` re-parse without gluing words containing spaces to their neighbour. */
export function shellQuoteWord(w) {
  return /^[A-Za-z0-9_\-.\/:=@%,]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`;
}

// ── CLI (IO shell) ──────────────────────────────────────────────────────────────────────────────────────

function parseFlags(argv) {
  const flags = {};
  const positionals = [];
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) flags[a.slice(2)] = true; else flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else positionals.push(a);
  }
  return { flags, positionals };
}

async function main(argv) {
  // `run`'s command tail lives after a literal `--` and must never be parsed as this CLI's OWN flags (a
  // `--coverage` meant for the wrapped command would otherwise be read as a flag of THIS script).
  const dashDashIdx = argv.indexOf('--');
  const preArgv = dashDashIdx === -1 ? argv : argv.slice(0, dashDashIdx);
  const { flags, positionals } = parseFlags(preArgv);
  // Resolve before lock-root derivation so relative --repo uses the same shared pool and execution cwd.
  const repo = resolve(typeof flags.repo === 'string' ? flags.repo : process.cwd());
  const cap = flags.cap != null ? Number(flags.cap) : resolveCap(process.env);
  const lockRoot = admissionLockRoot(repo, process.env);
  // `run` gets a PER-PROCESS owner (xaipsbs): two wrapped commands typed in the same checkout must be two
  // owners, or the second would "re-acquire" the first one's slot (own-slot refresh) and break the cap —
  // and the first to finish would release the slot the other is still using.
  const owner = typeof flags.owner === 'string' ? flags.owner : (positionals[0] === 'run' ? `${repo}#${process.pid}` : repo);
  const lane = typeof flags.lane === 'string' ? flags.lane : null;
  const num = typeof flags.num === 'string' ? flags.num : null;
  const asJson = !!flags.json;
  const emit = (obj) => writeAllSync(1, JSON.stringify(obj) + '\n');
  const mode = positionals[0] || 'status';

  if (mode === 'status') {
    const fastSlots = resolveFastSlots(process.env);
    if (!existsSync(lockRoot)) { emit({ cap, fastSlots, heldCount: 0, freeCount: cap + fastSlots, heavyFreeCount: cap, fastFreeCount: fastSlots, held: [], waiting: [], staleWaiting: 0, reaped: { count: 0, last: null } }); return; }
    emit(admissionStatus({ lockRoot, cap, fastSlots }));
    return;
  }
  if (mode === 'load-status') {
    // #4076/#4343 — the load-admission gate's live decision. A DIFFERENT axis from `status` above (that reads
    // the heavy-command semaphore's held slots); this reads the host-sampler's latest idle%/mem-pressure (plus
    // load1/cores as a backstop) and decides whether NEW dispatched-session launches should be held this tick.
    // `tick-core.mjs`'s IO shell shells this exact mode. `--min-idle-pct=` overrides
    // `WE_LOAD_ADMISSION_MIN_IDLE_PCT`, `--window=` overrides `WE_LOAD_ADMISSION_WINDOW`, `--min-pressure-level=`
    // overrides `WE_LOAD_ADMISSION_MIN_PRESSURE_LEVEL`, `--max-per-core=` overrides the backstop ratio's OWN env
    // var `WE_LOAD_ADMISSION_BACKSTOP_PER_CORE` (mirrors `--cap=`; the flag keeps its pre-#4343 name for CLI
    // continuity — only the underlying env var was renamed, per the module header's own reasoning). `--load-root=`
    // points at a fixture telemetry root instead of the real shared workspace store — a test seam (mirrors
    // `--repo=` for the lock root above), never used by a live caller.
    //
    // Pass each flag straight through as a `resolveLoadAdmission` PARAM (never `undefined` when the flag is
    // absent, so its own env var / default still applies) — it validates a param through the EXACT SAME clamp
    // an env var goes through (see its own doc comment for why: a raw CLI value can be garbage or out-of-range,
    // and a bare passthrough would silently defeat the check it overrides instead of falling back to the
    // default, the bug class #4343's review fixed). `--max-per-core=` keeps its pre-#4343 SPELLING for operator
    // continuity but maps to the backstop's OWN param (never the old, differently-scaled env var — see the
    // module header for why that name must stay inert for this purpose).
    const numOrUndef = (name) => (flags[name] != null ? Number(flags[name]) : undefined);
    const loadRoot = typeof flags['load-root'] === 'string' ? flags['load-root'] : undefined;
    const decision = resolveLoadAdmission({
      minIdlePct: numOrUndef('min-idle-pct'),
      minPressureLevel: numOrUndef('min-pressure-level'),
      backstopPerCore: numOrUndef('max-per-core'),
      window: numOrUndef('window'),
      root: loadRoot,
    });
    if (asJson) { emit(decision); return; }
    // Plain-text fallback (no `--json`) when `decision.reason` is absent (an ADMITTED tick has none — see
    // `loadAdmissionDecision`'s own doc comment). Report whichever real reading is actually available, in the
    // SAME idle → backstop → no-sample priority the decision itself checks — reporting a flat "no sample" when
    // idle-telemetry is merely absent but a real load1/cores reading exists (and was admitted) would misreport
    // an ordinary admit as a sampler outage.
    const reading = decision.reason && decision.reason !== 'no-sample'
      ? decision.reason
      : decision.idlePct != null
        ? `cpu idle ${decision.idlePct.toFixed(1)}% (min ${decision.minIdlePct}%)`
        : decision.perCore != null
          ? `load1 ${decision.load1.toFixed(2)}/${decision.cores} cores (${decision.perCore.toFixed(2)}, backstop ${decision.backstopPerCore})`
          : `no sample${decision.bypassed ? ` (${decision.bypassed})` : ''}`;
    process.stdout.write(`${decision.held ? 'HELD' : 'admitted'} — ${reading}\n`);
    return;
  }
  if (mode === 'queue-status') {
    // Card xkyw1x4 — the queue baseline (backlog in slot-minutes, standard times per kind, pending dispatched
    // sessions) that `tick-core.mjs`'s IO shell feeds to planTick's `queue-cap` gate. Read-only.
    const b = resolveQueueBaseline({ lockRoot, cap });
    if (asJson) { emit(b); return; }
    if (b.bypassed) { process.stdout.write(`queue admission bypassed (${b.bypassed})\n`); return; }
    process.stdout.write(`projected wait if you start now: ~${b.projectedWaitMinutes}m for a dispatch's short checks (max ${b.maxWaitMinutes}m), ~${b.heavyWaitMinutes}m for a full suite — `
      + `short ${b.shortBacklogMinutes} slot-min over ${b.shortCapacity} slot(s) (${b.fastSlots} fast + ${b.freeHeavySlots} free heavy), `
      + `heavy ${b.heavyBacklogMinutes} slot-min over ${b.heavySlots} heavy slot(s)\n`);
    return;
  }
  if (mode === 'reap') {
    // Preview by default; `--apply` removes. `--ttl-minutes=` overrides WAITING_TTL_MINUTES.
    const ttlMin = flags['ttl-minutes'] != null ? Number(flags['ttl-minutes']) : WAITING_TTL_MINUTES;
    const r = reapStaleWaiters({ lockRoot, ttlMs: ttlMin * 60_000, apply: !!flags.apply });
    if (asJson) { emit({ applied: !!flags.apply, ...r }); return; }
    const verb = flags.apply ? 'reaped' : 'would reap';
    for (const w of r.reaped) process.stdout.write(`${verb}: ${w.owner} (waiting since ${w.requestedAt}; ${w.reason})\n`);
    for (const w of r.kept) process.stdout.write(`kept:  ${w.owner} (${w.reason})\n`);
    process.stdout.write(`${r.reaped.length} ${verb}, ${r.kept.length} kept${flags.apply ? '' : ' — pass --apply to remove'}\n`);
    return;
  }
  if (mode === 'release') {
    // A fresh CLI invocation is, by definition, a different real process than whichever one is stuck holding
    // the slot — pid: null opts into the loose owner-only match (#3383's deliberate manual/operator escape
    // hatch; see releaseOwnedSlot's own docstring).
    const r = releaseOwnedSlot({ lockRoot, cap, owner, pid: null });
    if (asJson) emit(r); else process.stderr.write(r.released ? `released slot-${r.slot} for ${owner}\n` : `${owner} held no slot\n`);
    return;
  }
  if (mode === 'acquire') {
    mkdirSync(lockRoot, { recursive: true });
    // xhlriy2: the hard give-up ceiling. `--ceiling-ms`/`WE_HEAVY_ADMISSION_CEILING_MS` is the current knob;
    // the old `--timeout-ms` still works too (legacy fallback), it just now feeds the same ceiling rather than
    // the vestigial 20-minute give-up.
    const ceilingMs = flags['ceiling-ms'] != null ? Number(flags['ceiling-ms'])
      : flags['timeout-ms'] != null ? Number(flags['timeout-ms'])
      : resolveCeilingMs(process.env);
    const r = await acquireSlotBlocking({ lockRoot, cap, owner, lane, num, ceilingMs, kind: typeof flags.kind === 'string' ? flags.kind : null });
    if (asJson) emit(r);
    else process.stderr.write(r.ok ? `acquired slot-${r.slot} (waited ${r.waitedMs}ms)\n` : `timed out after ${r.waitedMs}ms waiting for capacity (cap=${cap}) — proceeding unslotted\n`);
    process.exit(0); // fail-open: a queuing timeout is not a usage error, the caller proceeds regardless
  }
  if (mode === 'run') {
    if (dashDashIdx === -1 || dashDashIdx === argv.length - 1) {
      process.stderr.write(`usage: heavy-admission.mjs run [--repo=] [--cap=] [--owner=] [--lane=] [--num=] [--kind=] [--ceiling-ms=] [--container] [--container-node-modules] -- <command…>\n`);
      process.exit(3);
    }
    const command = argv.slice(dashDashIdx + 1).map(shellQuoteWord).join(' ');
    // xhlriy2: the hard give-up ceiling (default 120 minutes); `--timeout-ms` is kept as a legacy fallback.
    const ceilingMs = flags['ceiling-ms'] != null ? Number(flags['ceiling-ms'])
      : flags['timeout-ms'] != null ? Number(flags['timeout-ms'])
      : resolveCeilingMs(process.env);
    // #3621 sequencing note (tracked on #3383) — the heavy-command-pool container POC. Opt-in ONLY: a caller
    // must explicitly ask for real OS-level isolation via `--container` or `WE_HEAVY_ADMISSION_CONTAINER=1`;
    // every existing caller (and the bare default here) still runs on the host, byte-identical to before this
    // flag existed. See scripts/lib/container-exec.mjs's own header for exactly what is proven to work this
    // way (check:standards, and — with `--container-node-modules` below — test:unit).
    const useContainer = !!flags.container || process.env.WE_HEAVY_ADMISSION_CONTAINER === '1';
    // The `test:unit` slice's own opt-in — layered ON TOP of `--container` (meaningless without it, checked
    // below). See this file's own header and container-exec.mjs's "test:unit slice" section for why a plain
    // `--container` mount alone is not enough for test:unit (native darwin bindings in vitest's own closure).
    const useNodeModulesVolume = !!flags['container-node-modules'] || process.env.WE_HEAVY_ADMISSION_CONTAINER_NODE_MODULES === '1';
    if (useContainer) {
      // Fail with a clear, actionable message rather than a raw ENOENT/"image not found" surfaced from deep
      // inside execFileSync — a caller that opted into real isolation should get a real reason it isn't
      // available, not a cryptic subprocess error.
      if (!containerCliAvailable()) {
        process.stderr.write(`✗ --container requested but the \`container\` CLI is not available on this host (Apple-Silicon-only tool — #3621's own permanent-portability finding). Install it or omit --container.\n`);
        process.exit(1);
      }
      const image = resolveContainerImage(process.env);
      if (!containerImageAvailable(image)) {
        process.stderr.write(`✗ --container requested but image "${image}" is not built. Build it: container build -f scripts/lib/container-exec/Containerfile -t ${image} .\n`);
        process.exit(1);
      }
      if (useNodeModulesVolume) {
        const volume = resolveNodeModulesVolume(process.env);
        if (!nodeModulesVolumeAvailable(volume)) {
          process.stderr.write(`✗ --container-node-modules requested but volume "${volume}" does not exist yet. Build/seed it: node scripts/lib/container-exec/build-test-unit-deps.mjs\n`);
          process.exit(1);
        }
      }
    } else if (useNodeModulesVolume) {
      process.stderr.write(`✗ --container-node-modules requires --container (it shadows a mount --container itself creates).\n`);
      process.exit(1);
    }
    const bypass = admissionBypassReason({ env: process.env, poolExists: existsSync(poolRootOf(lockRoot)) });
    const runOpts = { lockRoot, cap, owner, lane: lane ?? (/lane-(\d+)/.exec(repo) || [])[1] ?? null, num, repo, ceilingMs, command, cwd: repo, bypass, kind: typeof flags.kind === 'string' ? flags.kind : null };
    if (useContainer) runOpts.exec = (cmd, o) => execContainerized(cmd, { ...o, nodeModulesVolume: useNodeModulesVolume });
    const { exitCode } = await runUnderAdmission(runOpts);
    process.exit(exitCode);
  }
  process.stderr.write(`usage: heavy-admission.mjs <status|load-status|queue-status|acquire|release|run|reap> [--apply] [--ttl-minutes=] [--repo=] [--cap=] [--max-per-core=] [--min-idle-pct=] [--min-pressure-level=] [--window=] [--owner=] [--lane=] [--num=] [--json] [--ceiling-ms=] [-- <command…>]\n`);
  process.exit(3);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`✗ heavy-admission error: ${String(e && e.stack || e)}\n`); process.exit(1); });
}
