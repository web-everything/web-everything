#!/usr/bin/env node
/**
 * @file skills-src/conveyor/verify-daemon.mjs
 * @description #3878 (epic #3383) — the standalone Verify daemon: a long-lived process that runs
 *   {@link ../../scripts/conveyor/verify-dispatch.mjs}'s `runVerifyDispatch` on its own interval, standalone,
 *   instead of relying on whatever else might invoke that script.
 *
 * 2026-10-05 hung-gate incident: ticks launch gates without awaiting settlement, using one in-flight
 * registry for the process lifetime. A code-change restart waits (still ticking) until it is empty; shutdown
 * kills its process groups.
 *
 * THE GAP THIS CLOSES (confirmed by direct read — the one real gap named in the whole daemon-split epic).
 * `we:scripts/conveyor/verify-dispatch.mjs`'s own header justified its blocking safety entirely on "the runner
 * is a SINGLETON... so there is no risk of two dispatches racing the same lane's marker" — a property that
 * lives in `we:skills-src/conveyor/runner.mjs`, not in that file itself; it held no lock of its own. Worse, a
 * direct grep of `runner.mjs` turns up ZERO references to `verify-dispatch.mjs` at all — that file was never
 * actually wired into the runner's own `makeCliMechanicalPasses` list on `main` (see
 * `we:scripts/conveyor/verify-dispatch.mjs`'s own "CORRECTION (#3878...)" header note, and this item's
 * `## Progress` section, for the full finding). So "the runner is a SINGLETON" was, at best, a borrowed,
 * code-unenforced assumption about however else that file happened to be invoked — never a property it
 * actually held. This daemon closes the gap FOR REAL: it takes its OWN keyed
 * `we:skills-src/conveyor/runner-lock.mjs` lease ({@link VERIFY_DAEMON_LEASE_KEY}, #3877's generalized `key`
 * param) BEFORE ticking `runVerifyDispatch` at all — unlike #3870's Fix-dispatch daemon or #3876's Review
 * daemon (whose keyed leases are pure efficiency, not a correctness requirement, since their own dispatch
 * scripts already fence through an independent durable ledger or upstream liveness read), a live lease here IS
 * the only thing standing between "at most one gate run per lane at a time" and two standalone copies of this
 * daemon racing the same `.lane-verify` marker.
 *
 * ROLLING CUTOVER, DEVIATING FROM THE CARD'S OWN LITERAL WORDING (documented per this epic's established
 * practice — see #3870/#3876/#3873's own cards). The card's own digest says to "drop it from
 * `we:skills-src/conveyor/runner.mjs`'s own mechanicalPasses list" once this daemon exists. That step is
 * SKIPPED here, and not only because (per the finding above) there is nothing on `main` to drop: this epic's
 * established, safer practice is a ROLLING, pass-by-pass cutover — stand up the new standalone daemon, prove
 * it stable, and only THEN retire whatever else invokes the old script, in a separate, later change. That
 * caution matters doubly here, specifically because this item's whole point is that `verify-dispatch.mjs`'s
 * safety used to depend entirely on a borrowed, unverified assumption — removing whatever else might invoke it
 * today before this daemon's own lease is proven correct in production would trade one unverified safety story
 * for another, not close the gap this item exists to close.
 *
 * PURE-CORE / IO-SHELL SPLIT (mirrored from #3870's own daemon and runner.mjs's header): {@link runDaemonLoop}
 * has no `setTimeout`/`setInterval`, no real lease, no real dispatch — every effect (stepping one tick,
 * sleeping, heartbeating, logging) is injected, so the whole loop/backoff/stop-condition decision is
 * unit-tested with fakes. {@link runVerifyTick} is the thin per-tick effect (the real `runVerifyDispatch` call
 * is itself injectable, so it is unit-tested with a fake — no real subprocess/gh/git in unit tests). The IO
 * shell (`main()`, gated on the direct-invocation check) wires the real `runVerifyDispatch`, a real interval
 * sleep, and the real keyed runner-lock lease.
 *
 * `runDaemonLoop` is duplicated from #3870's own file rather than imported, matching this epic's own stated
 * precedent (#3870/#3876): none of the sibling daemon files have landed on `main` as a shared module at the
 * time each was written, so each carries its own identical copy; a follow-up can dedup them into one shared
 * file once several exist there together.
 */

import { isUnderTest } from '../../scripts/lib/under-test.mjs';
import { hostname } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  RUNNER_LOCK_ROOT, makeOwner,
  acquireRunnerLease, heartbeatRunnerLease, releaseRunnerLeaseIfOwned,
} from './runner-lock.mjs';
import { runVerifyDispatch, recordKilledVerification } from '../../scripts/conveyor/verify-dispatch.mjs';
import { loadVerifySettingsFile, resolveVerifySettings } from '../../scripts/lib/verify-settings.mjs';
import { installDaemonLog } from './daemon-log.mjs';

/** This daemon's own lease key — distinct from the Dispatcher's default sentinel and from the Fix-dispatch
 *  and Review daemons' own keys (#3870, #3876), so none of them ever contend on the same lock dir (#3877).
 *  UNLIKE those two, this key gates real correctness, not just efficiency — see the file header. */
export const VERIFY_DAEMON_LEASE_KEY = '<conveyor:verify-daemon-lease>';

/** DRAIN marker (2026-10-05): while this file exists the daemon dispatches NO new gate but keeps ticking, so the
 *  gates already in flight finish and settle their markers. Once a tick logs `in flight 0 (draining)` the job can
 *  be booted out and bootstrapped (the only way launchd picks up plist env changes) without orphaning a `running`
 *  marker. Remove the file to resume dispatch. */
export const VERIFY_DAEMON_DRAIN_FILE = process.env.WE_VERIFY_DAEMON_DRAIN_FILE || join(RUNNER_LOCK_ROOT, 'verify-daemon.drain');

/** The real drain probe. Under vitest it is off, so a live marker on the host can never change a unit test's dispatch. */
function defaultIsDraining() { return !isUnderTest() && existsSync(VERIFY_DAEMON_DRAIN_FILE); }

/** Matches runner.mjs's own tick cadence (DEFAULT_TICK_INTERVAL_MS) and every sibling daemon in this epic —
 *  standing alone, there is no reason to run this pass faster or slower. */
export const DEFAULT_INTERVAL_MS = 120_000;

/** #4130 (epic #3383 audit finding V1). How often the INDEPENDENT heartbeat timer fires, regardless of
 *  whether a tick (a full `runVerifyDispatch` sweep, itself possibly awaiting a 20+ minute gate — see the
 *  file header) is mid-flight. Deliberately far below both this daemon's own `DEFAULT_INTERVAL_MS` and the
 *  15-minute runner-lock TTL — it exists precisely to keep beating DURING a long gate run, not just between
 *  ticks (mirrors `pass-daemon.mjs`'s own constant of the same name and value). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

// ── PURE CORE (no IO — every effect is injected; unit-tested directly) ─────────────────────────────────────

/**
 * The daemon's whole control flow — IDENTICAL in shape to #3870's own `runDaemonLoop` (see that file's header
 * for why it is duplicated here rather than imported). Ticks `tickOnce` forever (or until `maxTicks`/
 * `shouldStop`), isolating a single tick's failure (logged via `onTickError`, never fatal) so a transient
 * `verify-lane.mjs`/gate hiccup degrades to "try again next tick", not a dead daemon.
 *
 * #4130: `isAlive` (mirrors `pass-daemon.mjs#runPassDaemonLoop`) replaces the old `heartbeat` effect. The OLD
 * shape awaited a heartbeat call itself only after `tickOnce` resolved — for a 20+ minute gate against a
 * 15-minute lease TTL, that meant the lease could lapse mid-gate with nothing beating it (this item's whole
 * finding). The heartbeat now beats on its OWN real timer, independent of this loop's await chain (see
 * {@link startIndependentHeartbeat} and `main()` below); this loop just SAMPLES that timer's latest verdict
 * (sync, no await) after each tick, before sleeping — continuing to dispatch gate runs once the lease is
 * already known lost would reopen exactly the double-dispatch risk this daemon exists to close.
 * @param {{
 *   tickOnce: () => Promise<object>|object,
 *   sleep: (ms:number) => Promise<void>,
 *   isAlive?: () => boolean,
 *   onTick?: (result:object, tick:number) => void,
 *   onTickError?: (error:Error, tick:number) => void,
 *   intervalMs?: number,
 *   maxTicks?: number,
 *   fixedCadence?: boolean, // builder opt-in; subtract elapsed work from the interval
 *   now?: () => number, // monotonic milliseconds
 *   codeChanged?: () => boolean, // 2026-10-04 — true once this daemon's own clone moved under it
 * }} o
 * @returns {Promise<{ticks:number, stoppedReason:string}>}
 */
export async function runDaemonLoop({
  tickOnce, sleep, isAlive = () => true, onTick = () => {}, onTickError = () => {},
  intervalMs = DEFAULT_INTERVAL_MS, maxTicks = Infinity,
  fixedCadence = false, now = () => performance.now(), codeChanged = () => false,
}) {
  if (typeof tickOnce !== 'function') throw new TypeError('runDaemonLoop requires a tickOnce effect');
  let tick = 0;
  for (;;) {
    const started = now();
    try {
      const result = await tickOnce();
      onTick(result, tick, { elapsedMs: Math.round(now() - started), intervalMs });
    } catch (error) {
      onTickError(error, tick, { elapsedMs: Math.round(now() - started), intervalMs });
    }
    if (!isAlive()) return { ticks: tick + 1, stoppedReason: 'lease-lost' };
    // 2026-10-04 — exit between ticks once the clone's code moved, so the supervisor (launchd KeepAlive) relaunches
    // on the new tree. Without this a fix overlaid onto this clone never reached the running process: the ENOTDIR
    // fix sat on disk while the in-memory sweep kept failing every tick (see `cloneHeadChanged`).
    if (codeChanged()) return { ticks: tick + 1, stoppedReason: 'code-changed' };
    if (tick + 1 >= maxTicks) return { ticks: tick + 1, stoppedReason: 'max-ticks' };
    // Start-to-start cadence: long rounds consume their interval. Never overlap or replay missed ticks.
    await sleep(fixedCadence ? Math.max(0, intervalMs - (now() - started)) : intervalMs);
    if (fixedCadence && !isAlive()) return { ticks: tick + 1, stoppedReason: 'lease-lost' };
    tick += 1;
  }
}

/**
 * One tick: run a full `runVerifyDispatch` sweep. Thin on purpose — unlike #3876's Review daemon (a real
 * multi-step sequence worth its own per-step effects), `verify-dispatch.mjs`'s own sweep is already ONE
 * self-contained unit of work (scan every pool/lane, spawn a bounded gate run per lane needing one) — this
 * wrapper exists so the dispatch call itself is a named, injectable effect (unit-tested with a fake `runVerify`
 * — no real subprocess/gh/git in unit tests), the same discipline `sleep`/`heartbeat` already get one level up
 * in {@link runDaemonLoop}.
 * @param {{inFlight?:Map<string, object>, awaitSettle?:boolean, runVerify?: (o:object) => Promise<{dryRun:boolean, dispatched:Array<object>, failures:Array<object>}>}} [o]
 * @returns {Promise<{dryRun:boolean, dispatched:Array<object>, failures:Array<object>}>}
 */
export async function runVerifyTick({ runVerify = runVerifyDispatch, ...options } = {}) {
  return runVerify(options);
}

/**
 * Did this daemon's own clone move to a different commit since boot? Pure over an injected `readHead`.
 * Live 2026-10-04: the verify daemon ran 25 h on one in-memory tree (no self-sync, unlike build-dispatch). A
 * daemon-rebuild of its clone (`wev-control`) updated the files on disk but never the running sweep, so the
 * ENOTDIR fix could not take effect without a hand restart. A head we cannot read (null) is never "changed" —
 * a transient git failure must not bounce the daemon.
 * @param {{bootHead: string|null, readHead: () => string|null}} o
 * @returns {boolean}
 */
export function cloneHeadChanged({ bootHead, readHead }) {
  if (!bootHead) return false;
  const now = readHead();
  return !!now && now !== bootHead;
}

// ── IO SHELL (runs only as a CLI — owns the real lease + the real dispatch pass) ─────────────────────────────

// LIVE-CAUGHT BUG, already hit three times this epic (#3870's reconcile-fix-dispatch-daemon.mjs, #3871's
// pass-daemon.mjs, #3876's review-daemon.mjs — see each file's own postmortem comment): `.unref()`-ing this
// timer told Node it was fine to exit before it fired — with nothing else keeping the event loop alive between
// ticks (a spawned child's own stdio is `ignore`d, no other ref'd handle exists), a daemon built this way
// exited right after its FIRST tick instead of waiting and looping. A REF'd timer (Node's default — no
// `.unref()`) is exactly what a resident daemon needs: the sleep IS the reason this process stays alive
// between ticks, not incidental background bookkeeping safe to drop on exit. Copied here verbatim, on purpose
// — do NOT add `.unref()` to this function.
export function realSleep(ms) { return new Promise((resolve) => { setTimeout(resolve, ms); }); }

/**
 * #4130 — THE INDEPENDENT HEARTBEAT: a real `setInterval`, started BESIDE (never inside) `runDaemonLoop`'s own
 * await chain, so it keeps beating the lease throughout a tick no matter how long that tick blocks (mirrors
 * `pass-daemon.mjs#main`'s own inline heartbeat timer, factored out here into a reusable function since this
 * item's own "Done when" — a stubbed 20-minute gate against a real 15-minute lease — wants it exercised
 * directly, with a fake `heartbeat` effect, rather than only indirectly through a full `main()` run).
 * Deliberately `.unref()`'d — unlike the daemon LOOP's own sleep timer (which must stay ref'd to keep the
 * process alive between ticks, see `realSleep`'s own comment), this timer is a side-channel signal, never
 * itself a reason for the process to keep running.
 * REVIEW FINDING (PR #2664, correctness, confirmed): the injected `heartbeat` effect runs inside a bare
 * `setInterval` callback — before this fix, an exception it threw (e.g. `heartbeatRunnerLease`'s underlying
 * `writeFileSync` racing a concurrent reclaim, or hitting ENOSPC/EACCES) was an UNCAUGHT exception that
 * crashed the whole process, bypassing `main()`'s top-level `.catch()` entirely. That window is new and worse
 * than the OLD shape this item replaces: the old awaited-heartbeat call only ever ran between ticks, where a
 * throw WAS caught by `main()`'s `.catch()`; this timer instead beats every `intervalMs` for the full duration
 * of a possibly 20+ minute in-flight tick, so the exposure is far larger. A throwing heartbeat is now treated
 * exactly like a `false` return (lease lost) — never propagated.
 * @param {{
 *   lockRoot?: string,
 *   owner: string,
 *   key?: string,
 *   intervalMs?: number,
 *   heartbeat?: (o:{key:string}) => boolean,
 *   onLost?: () => void,
 * }} o
 * @returns {{isAlive: () => boolean, stop: () => void}}
 */
export function startIndependentHeartbeat({
  lockRoot = RUNNER_LOCK_ROOT, owner, key = VERIFY_DAEMON_LEASE_KEY,
  intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS, heartbeat = (o) => heartbeatRunnerLease(lockRoot, owner, o),
  onLost = () => {},
} = {}) {
  if (!owner) throw new TypeError('startIndependentHeartbeat requires an owner');
  let alive = true;
  const timer = setInterval(() => {
    let ok;
    try {
      ok = heartbeat({ key });
    } catch {
      ok = false; // a throwing heartbeat is treated as lease-lost, never left to crash the process (PR #2664 review finding)
    }
    if (!ok) {
      alive = false;
      clearInterval(timer);
      onLost();
    }
  }, intervalMs);
  timer.unref?.();
  return {
    isAlive: () => alive,
    stop: () => clearInterval(timer),
  };
}

// #verify-inflight-reconcile — only ESRCH proves the process is gone.
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

// #verify-inflight-reconcile — does any member of the process group led by `pid` remain? Only ESRCH says no.
export function processGroupAlive(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

// #verify-inflight-reconcile — child exit can precede stdio close indefinitely. Dropping the entry is the whole
// requeue: laneNeedsVerifyDispatch accepts a fresh `running` marker, so the next tick re-selects this request
// with its identity and SHA unchanged, and a settled marker is never re-selected.
export function reconcileInFlight(inFlight, {
  isAlive = pidAlive, groupAlive = processGroupAlive, nowMs = Date.now(), spawnGraceMs = 120_000,
  killGroup = (group) => process.kill(group, 'SIGKILL'), log = console.error,
  adoptedCeilingMs = DEFAULT_ADOPTED_CEILING_MS, settleKilled = settleKilledAdopted,
} = {}) {
  const orphaned = [];
  for (const [dir, entry] of inFlight) {
    const { pool, lane, runId, pid, startedMs } = entry;
    // #65 — an ADOPTED gate (left running by a predecessor daemon) has no spawn promise here, so its ceilings are
    // not armed: bound its total age instead, and settle its marker like any ceiling kill.
    if (entry.adopted && pid > 0 && isAlive(pid) && nowMs - startedMs > adoptedCeilingMs) {
      try { if (groupAlive(pid)) killGroup(-pid); } catch {}
      inFlight.delete(dir);
      try { settleKilled(entry, adoptedCeilingMs); } catch {}
      log(`verify-daemon: ${pool}/lane-${lane} adopted run ${String(runId).slice(0, 8)} exceeded ${adoptedCeilingMs}ms — killed`);
      orphaned.push({ pool, lane, runId, pid, reason: 'adopted-ceiling' });
      continue;
    }
    const reason = pid > 0
      ? (!isAlive(pid) ? 'pid-gone' : null)
      : ((pid == null || pid === 0) && nowMs - startedMs > spawnGraceMs ? 'never-spawned' : null);
    if (!reason) continue;
    // The leader is gone. A pid is not reused while a process group still carries it, so a group that still has
    // members is ours (the stuck stdio holders). An empty one means the pid may already belong to an unrelated
    // process that became its own group leader, so kill nothing. (Narrows the window; a group that empties and a
    // pid recycled between two ticks is not detectable here.)
    try { if (pid > 0 && groupAlive(pid)) killGroup(-pid); } catch {}
    inFlight.delete(dir);
    // An adopted run that exited wrote its own terminal marker; only a run that died unsettled is re-queued.
    log(entry.adopted
      ? `verify-daemon: ${pool}/lane-${lane} adopted run ${String(runId).slice(0, 8)} finished (pid ${pid} gone) — released`
      : `verify-daemon: ${pool}/lane-${lane} in-flight run ${String(runId).slice(0, 8)} orphaned (pid ${pid} gone) — dropped and re-queued`);
    orphaned.push({ pool, lane, runId, pid, reason });
  }
  return { orphaned };
}

/** Build the real effects for {@link runDaemonLoop}: a real tick of {@link runVerifyTick} (which itself calls
 *  the real `runVerifyDispatch`), a real interval sleep, and the `isAlive` sampler backed by `main()`'s own
 *  {@link startIndependentHeartbeat} timer (#4130 — no longer built in here, since the heartbeat must run on
 *  its own clock, independent of this factory's caller). Kept as its own factory (mirroring
 *  `buildCliDaemonEffects` in the sibling daemons) so `main()` stays a thin wire-up. */
export function buildCliDaemonEffects({ intervalMs = DEFAULT_INTERVAL_MS, isAlive = () => true, log = console, runVerify = runVerifyDispatch, isDraining = defaultIsDraining,
  processIsAlive = pidAlive, groupAlive, killGroup, now = Date.now, spawnGraceMs = 120_000,
} = {}) {
  const inFlight = new Map();
  // `awaitSettle:false` returns before any gate settles, so `result.failures` is always empty here: failures
  // arrive later through `onSettled`, are logged as they land, and the next tick summary counts them.
  let settledFailures = 0;
  const onSettled = (f) => {
    settledFailures += 1;
    log.error(`verify-daemon: ${f.pool}/lane-${f.lane} failed (non-fatal)${f.timedOut ? ` [timed out: ${f.timedOutPhase}]` : ''}`);
  };
  return {
    inFlight,
    intervalMs,
    tickOnce: async () => {
      // #verify-inflight-reconcile — drain and restart must also release orphaned runs.
      const { orphaned } = reconcileInFlight(inFlight, {
        isAlive: processIsAlive, groupAlive, nowMs: now(), spawnGraceMs, killGroup,
        log: (message) => log.error(message),
      });
      const result = isDraining()
        ? { dispatched: [], deferred: [], failures: [], draining: true }
        : await runVerifyTick({ runVerify, inFlight, awaitSettle: false, onSettled });
      return { ...result, orphaned };
    },
    sleep: realSleep,
    isAlive,
    onTick: (result) => {
      const { dispatched = [], deferred = [], draining = false, orphaned = [] } = result || {};
      log.error(`verify-daemon: tick — dispatched ${dispatched.length}, in flight ${inFlight.size}${draining ? ' (draining)' : ''}, deferred ${deferred.length}, failed ${settledFailures}${orphaned.length ? `, orphaned ${orphaned.length}` : ''}`);
      settledFailures = 0;
    },
    onTickError: (error) => {
      log.error(`verify-daemon: tick failed (non-fatal): ${String((error && error.message) || error).split('\n')[0]}`);
    },
  };
}

/** #65 — the in-flight hand-off file a stopping daemon writes and its successor adopts from. */
export const VERIFY_DAEMON_INFLIGHT_FILE = process.env.WE_VERIFY_DAEMON_INFLIGHT_FILE || join(RUNNER_LOCK_ROOT, 'verify-daemon.inflight.json');

/** An adopted run's total-age bound: the dispatcher's own queue + gate ceilings (2 h + 5 min + 30 min by default). */
export const DEFAULT_ADOPTED_CEILING_MS = (Number(process.env.VERIFY_DISPATCH_QUEUE_CEILING_MS) || 125 * 60_000)
  + (Number(process.env.VERIFY_DISPATCH_TIMEOUT_MS) || 30 * 60_000);

function settleKilledAdopted(entry, ceilingMs) {
  recordKilledVerification(entry.dir, { ...entry, startedAt: null }, { status: null, signal: 'SIGKILL', timedOutPhase: 'gate' }, ceilingMs);
}

/** #65 — the declared `restartInFlight` setting: `adopt` (default) or `kill` (the old teardown). */
export function resolveRestartInFlight(env = process.env, fileConfig = loadVerifySettingsFile()) {
  return resolveVerifySettings({ fileConfig, env }).values.restartInFlight;
}

/** Serialize the spawned in-flight gates for a successor. Pure: returns the records written. */
export function inFlightHandoff(inFlight) {
  return [...inFlight.values()]
    .filter((e) => e.pid > 0 && e.dir && e.runId)
    .map(({ pool, lane, dir, runId, pid, sha, suites, treeHash, requestStartedAt, startedMs, logPath }) =>
      ({ pool, lane, dir, runId, pid, sha, suites, treeHash: treeHash ?? null, requestStartedAt: requestStartedAt ?? null, startedMs, logPath: logPath ?? null }));
}

export function writeInFlightHandoff(inFlight, path = VERIFY_DAEMON_INFLIGHT_FILE) {
  const records = inFlightHandoff(inFlight);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ writtenAt: new Date().toISOString(), records }, null, 2) + '\n');
  renameSync(tmp, path);
  return records;
}

/** Is `pid` still the exact verify-lane child a predecessor spawned (its argv carries the run id)? Guards pid reuse. */
export function isDispatchedRun(pid, runId, readCommand = (p) => execFileSync('ps', ['-o', 'command=', '-p', String(p)],
  { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] })) {
  try {
    const command = readCommand(pid);
    return command.includes('verify-lane.mjs') && command.includes(`--run-id=${runId}`);
  } catch { return false; }
}

/**
 * #65 — adopt a predecessor's still-running gates into this daemon's in-flight registry, so the next tick neither
 * re-dispatches nor kills them (an identical re-request is kept by the dispatcher's supersede policy). The file is
 * consumed (removed) whatever it held; a record whose pid is gone or is no longer our child is skipped — its
 * marker either already settled or stays `running` and is re-dispatched as before.
 */
export function adoptInFlight(inFlight, { path = VERIFY_DAEMON_INFLIGHT_FILE, isOurs = isDispatchedRun, log = console.error } = {}) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
  try { rmSync(path, { force: true }); } catch {}
  const adopted = [];
  for (const record of Array.isArray(parsed?.records) ? parsed.records : []) {
    if (!(record?.pid > 0) || !record.dir || !record.runId || inFlight.has(record.dir)) continue;
    if (!isOurs(record.pid, record.runId)) continue;
    inFlight.set(record.dir, { ...record, adopted: true });
    adopted.push(record);
    log(`verify-daemon: adopted in-flight run ${String(record.runId).slice(0, 8)} for ${record.pool}/lane-${record.lane} @ ${String(record.sha).slice(0, 8)} (pid ${record.pid})`);
  }
  return adopted;
}

/** SIGKILL the detached process group of every in-flight gate that has spawned. Shared by the signal handler
 *  and every loop exit, so no path can leave a gate running under a daemon that no longer holds the lease
 *  (a successor would then double-dispatch the same lane). An entry without a pid has not spawned yet; a pid
 *  that already exited throws and is skipped. `kill` is injectable for tests. */
export function killInFlight(inFlight, kill = process.kill.bind(process)) {
  for (const { pid } of inFlight.values()) {
    try { if (pid > 0) kill(-pid, 'SIGKILL'); } catch {}
  }
}

/** The loop's `codeChanged` predicate: a code-change restart waits for an empty in-flight registry, but the
 *  loop KEEPS TICKING meanwhile — exiting with gates running would orphan them, and pausing dispatch until
 *  they drain would re-create the starvation. */
export function makeCodeChangedGuard({ inFlight, bootHead, readHead }) {
  return () => inFlight.size === 0 && cloneHeadChanged({ bootHead, readHead });
}

/** The ONE teardown every exit path shares (SIGTERM/SIGINT and every loop exit): kill in-flight gates, stop
 *  the heartbeat, release the lease, then exit at once. Idempotent. The immediate exit matters: it stops the
 *  killed gates' settle chain from running, so their markers stay `running` and a successor re-dispatches the
 *  lane — letting that chain run would stamp a daemon-initiated kill as an `infrastructure-failure` the
 *  successor then skips. Everything effectful is injected so the lifecycle is unit-tested with fakes. */
export function createCleanup({ inFlight, stopHeartbeat, release, kill, exit = (code) => process.exit(code), log = console,
  restartInFlight = 'kill', handoff = writeInFlightHandoff }) {
  let stopping = false;
  return {
    isStopping: () => stopping,
    /** `adoptable` — a restart (SIGTERM/SIGINT): under `restartInFlight: adopt` the running gates are handed to the
     *  successor instead of killed (#65). A lease loss still kills: another live daemon already owns dispatch. */
    stopAndExit(why, { adoptable = false } = {}) {
      if (stopping) return;
      stopping = true;
      log.error(`verify-daemon: ${why} — releasing the lease and exiting.`);
      let handedOff = false;
      if (adoptable && restartInFlight === 'adopt' && inFlight.size > 0) {
        try {
          const records = handoff(inFlight);
          handedOff = true;
          log.error(`verify-daemon: left ${records.length} in-flight gate(s) running for the successor to adopt (restartInFlight: adopt).`);
        } catch (error) {
          log.error(`verify-daemon: in-flight hand-off failed (${String(error?.message || error)}) — killing them instead.`);
        }
      }
      if (!handedOff) killInFlight(inFlight, kill);
      stopHeartbeat();
      release();
      exit(0);
    },
  };
}

/** Run the loop; whichever way it stops, tear down through `cleanup` (a no-op if a signal already did). */
export async function runDaemon({ effects, codeChanged, cleanup }) {
  const out = await runDaemonLoop({ ...effects, codeChanged });
  cleanup.stopAndExit(`loop stopped (${out.stoppedReason})`);
  return out;
}

async function main() {
  installDaemonLog(); // item 68a: ISO-stamp every log line (WE_DAEMON_LOG_TIMESTAMPS=0 turns it off)
  const owner = makeOwner('verify-daemon');
  const acquired = acquireRunnerLease(RUNNER_LOCK_ROOT, owner, { key: VERIFY_DAEMON_LEASE_KEY });
  if (!acquired.ok) {
    // Unlike the Fix-dispatch/Review daemons' own no-op case, this refusal IS the correctness guarantee this
    // daemon exists to provide, not merely an efficiency short-circuit — see the file header.
    console.error(`verify-daemon: a live instance already holds the lease (${acquired.heldBy}) — exiting.`);
    return;
  }
  // #4130 — started BEFORE the loop, on its own real timer: this is what keeps the lease fresh throughout a
  // single long gate tick, not just between ticks (see startIndependentHeartbeat's own header).
  const { isAlive, stop: stopHeartbeat } = startIndependentHeartbeat({
    owner,
    onLost: () => console.error(`verify-daemon: lease lost mid-run — will stop after the current tick.`),
  });
  const effects = buildCliDaemonEffects({ isAlive });
  const cleanup = createCleanup({
    inFlight: effects.inFlight,
    kill: process.kill.bind(process),
    stopHeartbeat,
    release: () => releaseRunnerLeaseIfOwned(RUNNER_LOCK_ROOT, owner, { key: VERIFY_DAEMON_LEASE_KEY }),
    restartInFlight: resolveRestartInFlight(process.env),
  });
  process.on('SIGTERM', () => cleanup.stopAndExit('SIGTERM', { adoptable: true }));
  process.on('SIGINT', () => cleanup.stopAndExit('SIGINT', { adoptable: true }));
  // #65 — take over the gates a predecessor left running (a restart under restartInFlight: adopt).
  adoptInFlight(effects.inFlight);
  console.error(`verify-daemon: started on ${hostname()}:${process.pid}, tick every ${DEFAULT_INTERVAL_MS}ms, heartbeat every ${DEFAULT_HEARTBEAT_INTERVAL_MS}ms.`);
  const cloneRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const readHead = () => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: cloneRoot, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  const bootHead = readHead();
  await runDaemon({
    effects,
    codeChanged: makeCodeChangedGuard({ inFlight: effects.inFlight, bootHead, readHead }),
    cleanup,
  });
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  main().catch((e) => { console.error(`verify-daemon: fatal: ${String((e && e.message) || e)}`); process.exit(1); });
}
