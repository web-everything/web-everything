#!/usr/bin/env node
/**
 * @file skills-src/conveyor/pass-daemon.mjs
 * @description #3871 (epic #3383) — the GENERIC single-pass daemon: runs ONE mechanical pass script
 *   (resolved ONLY through {@link ./daemon-manifest.mjs}'s closed allowlist — see that file's header) on its
 *   own interval, forever, standalone. Where #3870's `reconcile-fix-dispatch-daemon.mjs` is a bespoke daemon
 *   for one in-process function, this file is the generic form any FUTURE pass can plug into by adding one
 *   manifest entry — no new daemon file, no new loop to write.
 *
 * WHY A SUBPROCESS, NOT AN IN-PROCESS CALL (unlike #3870). Every mechanical pass in this epic is already a
 * standalone CLI (`node scripts/conveyor/<pass>.mjs <args>`) — that is what `runner.mjs`'s own
 * `makeCliMechanicalPasses` already shells today. Spawning it as a real child process (never `require`-ing
 * or dynamic-`import`-ing its module) means: (a) a pass that crashes or hangs cannot take this daemon down
 * with it — its own event loop keeps running the heartbeat regardless; (b) THE INDEPENDENT HEARTBEAT this
 * item's own card calls for falls out for free — `main()` below starts a real `setInterval` heartbeat BESIDE
 * the `await` on the child process's exit, so a long-running pass (`we:scripts/conveyor/infra-blocked.mjs`'s
 * own header: its `resumeOpen` call "can legitimately block for minutes on pr-land's own green-wait") never
 * silently stalls this daemon's own liveness signal the way it would if the heartbeat only fired BETWEEN
 * ticks (today's single-runner behavior, and #3870's own simpler loop — safe there only because that pass
 * never blocks nearly this long).
 *
 * PURE-CORE / IO-SHELL SPLIT (mirrored from runner.mjs and #3870's own daemon):
 *   • {@link runPassDaemonLoop} has no `child_process`, no real timer, no real lease — every effect (spawning
 *     the pass, sleeping between runs) is injected, unit-tested with fakes.
 *   • The IO SHELL (`main()`) resolves the manifest entry, spawns the real child, starts the REAL independent
 *     heartbeat `setInterval` (never inside the loop's own await chain), and owns the real keyed lease
 *     (#3877) — its own distinct key, one per `--pass=<name>`, so two different passes running under this
 *     daemon never contend with each other or with the Dispatcher's own lease.
 *
 * GITHUB APP TOKEN, NOT THE OPERATOR'S PERSONAL ONE (xsdm0n7, epic #3383). Every one of these watchers'
 * pass scripts shells `gh` as a child process, inheriting `process.env` — so setting `GH_TOKEN` here, right
 * before each spawn via {@link ensureFreshGithubAppEnv}, covers every pass this daemon can run without
 * touching any pass script itself. The daemon installs a refusal guard before refreshing; inability to
 * install it stops the loop. Missing App config or mint failures remain subject to the guard's fallback
 * policy — see that module's own header. Six resident `lane-pool-health-watch`/`parked-pr-conflict-watch`
 * launchd jobs run through this exact file; their personal-token draw is what exhausted the operator's
 * 5,000/hr budget ("API rate limit already exceeded for user ID 760299") on 2026-09-23.
 *
 * SELF-SYNC (#3383 daemon POC, xdpemd4). Unlike `review-daemon.mjs`/`reconcile-fix-dispatch-daemon.mjs`,
 * this generic daemon never wired `we:scripts/lib/daemon-self-sync.mjs#withSelfSync` in — every OTHER
 * resident daemon self-syncs its clone between ticks, so a `pass-daemon.mjs`-driven watcher (the
 * `lane-pool-health-watch`/`parked-pr-conflict-watch` launchd jobs this file's own header names) never did.
 * {@link main} now wraps its one-shot `runPass` effect in `withSelfSync` exactly the way `review-daemon.mjs`
 * wraps its own `tickOnce` — same `root`/`onRestart` shape, same opt-in POC-mode env var
 * (`DAEMON_SELF_SYNC_BRANCH`) `withSelfSync` itself already resolves, so this file needs no new env
 * convention of its own. Unset (the default), this is a no-op: `withSelfSync` ticks straight through.
 */

import { createHash } from 'node:crypto';
import { CONSTELLATION_REPOS } from '../../scripts/lib/constellation-repos.mjs';
import { enqueueItemTask } from '../../scripts/lib/daemon-item-tasks.mjs';
import { defineJobKind, markClaimed, markSucceeded, markFailed, taskDeadlineDecision } from '../../scripts/lib/daemon-jobs.mjs';
import { createJobStore, launchJob, reattachTick, probeHandle, stopHandle, hostName, localHostAliases, readProcStart, reapDeadGroup } from '../../scripts/lib/daemon-jobs-runtime.mjs';
import { daemonJobsDir } from '../../scripts/operations/run-store.mjs';
import { formatJobHandle, parseJobHandle, TERMINAL_JOB_STATUSES } from '../../scripts/operations/job-record.mjs';
import { appendDaemonEvent } from '../../scripts/lib/daemon-events.mjs';
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAEMON_MANIFEST, resolveManifestEntry } from './daemon-manifest.mjs';
import {
  RUNNER_LOCK_ROOT, makeOwner,
  acquireRunnerLease, heartbeatRunnerLease, releaseRunnerLeaseIfOwned,
} from './runner-lock.mjs';
import { ensureFreshGithubAppEnv, FLEET_APP_AUTH_OPTS, isGithubAppAuthGuardError } from '../../scripts/lib/github-app-auth-env.mjs';
import { withSelfSync, resolvePocSyncBranch, DAEMON_SELF_SYNC_BRANCH_ENV } from '../../scripts/lib/daemon-self-sync.mjs';
import { StringDecoder } from 'node:string_decoder';
import { notifyDesktopChecked } from '../../scripts/conveyor/branch-sync.mjs';
import { installDaemonLog, stripLogTimestamp } from './daemon-log.mjs';

const CLOSE_GRACE_MS = 5000;
/** The most output a relayed child stream may buffer without a newline before it is flushed as a line of its own. */
const MAX_RELAY_LINE_CHARS = 1024 * 1024;

/** How often the INDEPENDENT heartbeat timer fires, regardless of whether a pass is mid-run. Deliberately
 *  much shorter than any pass's own `intervalMs` — it exists precisely to keep beating DURING a long single
 *  run, not just between them. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** This daemon's own lease key, one per pass name — distinct from the Dispatcher's default sentinel, from
 *  #3870's Fix-dispatch daemon key, and from every OTHER pass's own key, so N pass-daemon instances never
 *  contend with each other. */
export function passDaemonLeaseKey(passName) { return `<conveyor:pass-daemon:${passName}-lease>`; }

/** The env var that turns self-sync ON for this generic daemon (xdpemd4). UNLIKE `review-daemon.mjs`'s own
 *  unconditional self-sync, this one stays OPT-IN: six resident launchd jobs already run this exact file
 *  (`lane-pool-health-watch`/`parked-pr-conflict-watch`) with no expectation their clone ever advances on its
 *  own, so wiring `withSelfSync` in unconditionally would be a silent behavior change for every one of them,
 *  not a fix scoped to the daemon POC that asked for it. Setting `we:scripts/lib/daemon-self-sync.mjs`'s own
 *  `DAEMON_SELF_SYNC_BRANCH` (POC mode) ALSO turns self-sync on for this daemon — a caller who already opted
 *  into tracking a POC branch does not need a second flag to mean the same "yes, self-sync" — this var exists
 *  only for the plain main-tracking case that flag doesn't cover. */
export const PASS_DAEMON_SELF_SYNC_ENV = 'PASS_DAEMON_SELF_SYNC';

/**
 * Is self-sync ON for this run? PURE. Mirrors `we:scripts/lib/daemon-self-sync.mjs#resolvePocSyncBranch`'s own
 * blank-counts-as-unset treatment.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function passDaemonSelfSyncEnabled(env = process.env) {
  if (env?.[PASS_DAEMON_SELF_SYNC_ENV] === '1') return true;
  const pocBranch = typeof env?.DAEMON_SELF_SYNC_BRANCH === 'string' ? env.DAEMON_SELF_SYNC_BRANCH.trim() : '';
  return pocBranch !== '';
}

/** #4044 Module E — passes whose own job IS landing onto `main` (the periodic orphan merge sweep
 *  `merge-orphan-sweep` runs — see `daemon-manifest.mjs`'s own header for why that one is NOT the drain role)
 *  must never self-sync onto an OVERLAY: an overlay is unreviewed, unmerged code, and landing decisions have to
 *  be made from `origin/main` alone. `withSelfSync`'s `mainOnly` option (which the underlying rebuild —
 *  `daemon-rebuild.mjs#rebuildClone` — refuses every registered overlay for, Module C) is how this daemon asks
 *  for that; see {@link main} for the POC-mode refusal this implies. Every entry MUST be a `DAEMON_MANIFEST`
 *  key — any other name can never reach this check. The resident drain watch (`merge-ai-prs.mjs --watch`) is
 *  deliberately NOT a manifest pass and has no self-sync wiring at all; a future change that wires it into
 *  `withSelfSync` must pass `mainOnly: true` at that call site itself. */
export const MAIN_ONLY_PASSES = new Set(['merge-orphan-sweep']);

// ── PURE CORE (no IO — every effect is injected; unit-tested directly) ─────────────────────────────────────

/**
 * The daemon's run/sleep control flow — deliberately does NOT own the heartbeat (that runs on its own real
 * timer in the IO shell, see the file header for why); this loop only isolates a failing run and paces the
 * `intervalMs` between them.
 * `refreshAuth` runs right before EVERY spawn (never on its own background timer — a resident watcher's
 * personal `gh` token exhausting the operator's own 5,000/hr budget was live-caught 2026-09-23; a timer would
 * be starved by this same loop's blocking work between spawns, the same reason {@link withGithubAppAuth}
 * refreshes per-tick rather than on a timer). Transient refresh errors are logged via `onRefreshError`;
 * a missing refusal guard is fatal and stops the loop before the next spawn.
 * @param {{
 *   runPass: () => Promise<{code:number|null}>,
 *   sleep: (ms:number) => Promise<void>,
 *   isAlive?: () => boolean,
 *   onRun?: (result:object, run:number) => void,
 *   onRunError?: (error:Error, run:number) => void,
 *   refreshAuth?: () => Promise<any>,
 *   onRefreshError?: (error:Error, run:number) => void,
 *   intervalMs: number,
 *   maxRuns?: number,
 * }} o
 * @returns {Promise<{runs:number, stoppedReason:string}>}
 */
export async function runPassDaemonLoop({
  runPass, sleep, isAlive = () => true, onRun = () => {}, onRunError = () => {},
  refreshAuth = async () => {}, onRefreshError = () => {},
  intervalMs, maxRuns = Infinity, tickWhileRunning = false,
  failureAlertAfter = 0, onConsecutiveFailures = () => {},
}) {
  if (typeof runPass !== 'function') throw new TypeError('runPassDaemonLoop requires a runPass effect');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new TypeError('runPassDaemonLoop requires a positive intervalMs');
  let run = 0;
  let streak = 0;
  const failed = (result) => !result || result.spawnError != null || result.signal != null || (result.code ?? 1) !== 0;
  // Who watches the watcher: a pass that fails `failureAlertAfter` runs in a row (non-zero exit, killed, OOM,
  // spawn error, throw) is reported through `onConsecutiveFailures` — from THIS daemon, never the pass itself,
  // which is the thing that is broken. Fires at the threshold, then at every 6th multiple, not on every tick.
  const noteRun = (bad, detail) => {
    streak = bad ? streak + 1 : 0;
    if (failureAlertAfter > 0 && bad && streak >= failureAlertAfter
      && (streak - failureAlertAfter) % (failureAlertAfter * 6) === 0) {
      try { onConsecutiveFailures({ count: streak, detail }); } catch { /* alerting must never stop the loop */ }
    }
  };
  const runOnce = async (startedRun) => {
    try {
      const result = await runPass();
      onRun(result, startedRun);
      noteRun(failed(result), result);
    } catch (error) {
      onRunError(error, startedRun);
      noteRun(true, { error: String((error && error.message) || error) });
    }
  };
  let inFlight = null;
  try {
    for (;;) {
      if (!inFlight) {
        try {
          await refreshAuth();
        } catch (error) {
          if (isGithubAppAuthGuardError(error)) throw error;
          onRefreshError(error, run);
        }
        if (tickWhileRunning) {
          // Opt-in (#5755): the pass is a bounded timed job, so the loop keeps its cadence while it runs.
          inFlight = runOnce(run).finally(() => { inFlight = null; });
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        } else await runOnce(run);
      }
      if (!isAlive()) { await inFlight; return { runs: run + 1, stoppedReason: 'lease-lost' }; }
      if (run + 1 >= maxRuns) { await inFlight; return { runs: run + 1, stoppedReason: 'max-runs' }; }
      await sleep(intervalMs);
      run += 1;
    }
  } finally {
    // Error exits must preserve the monitor just like max-runs and lease loss.
    await inFlight;
  }
}

// ── IO SHELL (runs only as a CLI — owns the real child process + the real independent heartbeat) ────────────

// Live-caught bug (#3870/#3876, both built on this same pattern): `.unref()`-ing this timer told Node it
// was fine to exit before it fired. Between pass runs, nothing else keeps the event loop alive (a completed
// child's stdio no longer holds a reference), so the daemon would exit right after its first run instead of
// waiting out `intervalMs` and looping. A REF'd timer (Node's default — no `.unref()`) is exactly what a
// resident daemon needs here: the sleep IS the reason it stays alive between runs. (The heartbeat
// `setInterval` below is correctly left `.unref()`'d — it is not meant to be a standalone keep-alive; this
// timer already guarantees survival once fixed.)
/** Consecutive failed runs before a watched pass raises an operator alert (knob `WE_PASS_FAILURE_ALERT_AFTER`,
 *  default 2). Only manifest entries marked `alertOnConsecutiveFailures` are watched; 0 turns it off. PURE. */
export const DEFAULT_FAILURE_ALERT_AFTER = 2;
export function resolveFailureAlertAfter(entry, env = process.env) {
  if (!entry?.alertOnConsecutiveFailures) return 0;
  const raw = env.WE_PASS_FAILURE_ALERT_AFTER;
  const n = raw == null || raw === '' ? DEFAULT_FAILURE_ALERT_AFTER : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_FAILURE_ALERT_AFTER;
}

/** The operator-visible alert: a desktop notification (the existing `notifyDesktopChecked` path) plus a log line
 *  that survives a missed notification. Never throws. */
export function alertConsecutiveFailures(passName, count, detail, { notify = notifyDesktopChecked, log = console } = {}) {
  const why = detail?.error ?? (detail?.spawnError ?? (detail?.signal ? `killed by ${detail.signal}` : `exit code ${detail?.code}`));
  const body = `"${passName}" has failed ${count} runs in a row (last: ${why}). The watcher is not watching — check its log.`;
  log.error(`pass-daemon: ALERT ${body}`);
  try {
    const r = notify({ title: `${passName} is failing`, body });
    if (r && r.ok === false) log.error(`pass-daemon: desktop alert for "${passName}" not delivered: ${r.error}`);
  } catch (e) { log.error(`pass-daemon: alert for "${passName}" threw: ${String((e && e.message) || e)}`); }
}

export function realSleep(ms) { return new Promise((resolve) => { setTimeout(resolve, ms); }); }

/** #5129 — an older clone may not yet register a launchd job's pass. Stay resident before acquiring a
 *  lease or spawning anything; exiting would make KeepAlive crash-loop. The imported manifest is static:
 *  update the clone and restart to pick up a newly registered entry. Malformed entries still fail closed. */
export async function waitForManifestEntry(passName, { manifest = DAEMON_MANIFEST, sleep = realSleep, log = console } = {}) {
  while (!Object.hasOwn(manifest, passName)) {
    log.error(`pass-daemon: "${passName}" idle (manifest-entry-missing) — update this clone and restart; no pass will run.`);
    await sleep(60_000);
  }
  return resolveManifestEntry(passName, manifest);
}

/** Spawn one real run of the manifest-resolved script to completion, async (never blocking the event loop
 *  the independent heartbeat relies on — mirrors why `runner.mjs`'s own `runQuietHeartbeating` uses `spawn`,
 *  never `execFileSync`, for anything that can outlast a beat).
 *
 *  #gh-write-burst — `env` defaults to `process.env` (unchanged for every existing caller) but a caller now MAY
 *  override it; `main()` below sets `GH_CALLER=<passName>` on it so every `gh` call this pass's own process
 *  makes (in-process, through `we:scripts/lib/gh-throttle.mjs`) is attributed to the exact manifest entry that
 *  made it — the same precision `process.argv[1]`'s own basename fallback cannot give across this pass's
 *  per-repo instances (`parked-pr-conflict-watch-we` vs `-frontierui` vs `-plateau-app` all share one script
 *  path). */
/**
 * The env a pass child is spawned with: the daemon's CURRENT env (read at call time, so the gh shim `refreshAuth`
 * just put on PATH is included) plus `GH_CALLER` attributing its gh calls to this manifest entry. PURE over `env`.
 */
export function passEnvFor(passName, env = process.env) {
  return { ...env, GH_CALLER: passName };
}

function spawnPassChild({ script, args = [] }, { root = REPO_ROOT, log = console, env = process.env, spawnFn = spawn, onChild = () => {}, capture = false, quiet = false } = {}) {
  return new Promise((resolve) => {
    // 68b: the child's output is relayed line by line through this process's own (stamped, de-duplicated, rotated)
    // console instead of inherited, so the big health-watch logs get timestamps and a size cap too.
    const child = spawnFn(process.execPath, [join(root, script), ...args], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    onChild(child);
    let output = '';
    const outputDecoder = new StringDecoder('utf8');
    let stderr = '';
    child.stderr?.on('data', chunk => {
      if (stderr.length < MAX_RELAY_LINE_CHARS) stderr = (stderr + chunk).slice(-MAX_RELAY_LINE_CHARS);
    });
    let outputBytes = 0;
    let outputError;
    if (capture) child.stdout?.on('data', chunk => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes <= 32 * 1024 * 1024) output += typeof chunk === 'string' ? chunk : outputDecoder.write(chunk);
      else outputError = 'pass output exceeded 32 MiB; inspect pass output before retrying';
    });
    // Each relayed line is stamped ONCE, by this process's log: a stamp the child already wrote is dropped first, or
    // `<ISO> <ISO> name: tick` would no longer parse as a `name:` line. A StringDecoder keeps a multi-byte character
    // split across two chunks whole.
    const relay = (stream, write) => {
      if (!stream || typeof stream.on !== 'function') return () => {};
      let pending = '';
      const decoder = new StringDecoder('utf8');
      stream.on('data', (chunk) => {
        const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
        // Split only what just arrived, never the whole buffer again: a flood of tiny newline-free chunks would
        // otherwise re-scan up to the cap on every event.
        const nl = text.lastIndexOf('\n');
        if (nl === -1) pending += text;
        else {
          const parts = (pending + text.slice(0, nl)).split('\n');
          pending = text.slice(nl + 1);
          for (const l of parts) write(stripLogTimestamp(l));
        }
        // A child that never ends a line must not grow this long-lived daemon's memory without bound: past the cap
        // the buffered text goes out as a line of its own (never splitting a surrogate pair).
        while (pending.length > MAX_RELAY_LINE_CHARS) {
          let cut = MAX_RELAY_LINE_CHARS;
          const last = pending.charCodeAt(cut - 1);
          if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
          write(stripLogTimestamp(pending.slice(0, cut)));
          pending = pending.slice(cut);
        }
      });
      return () => { pending += decoder.end(); if (pending) { write(stripLogTimestamp(pending)); pending = ''; } };
    };
    const flushOut = relay(child.stdout, (l) => { if (!capture && !quiet) log.log(l); });
    const flushErr = relay(child.stderr, (l) => log.error(l));
    // Finish on 'close' (stdio fully drained), not 'exit' (which can fire with pipe data still unread). A grandchild
    // that inherited the pipes can hold 'close' off forever, so 'exit' arms a short grace timer as a backstop.
    let finished = false;
    let graceTimer = null;
    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      if (graceTimer) clearTimeout(graceTimer);
      flushOut(); flushErr();
      if (capture && !outputError) output += outputDecoder.end();
      if (code !== 0) log.error(`pass-daemon: ${script} exited ${signal ? `on ${signal}` : `with code ${code}`}`);
      resolve({ code, signal, ...(capture ? { output } : {}), ...(code !== 0 && quiet ? { stderr } : {}), ...(outputError ? { spawnError: outputError } : {}) });
    };
    child.on('exit', (code, signal) => { graceTimer = setTimeout(() => finish(code, signal), CLOSE_GRACE_MS); graceTimer.unref?.(); });
    child.on('close', (code, signal) => finish(code, signal));
    child.on('error', (e) => { log.error(`pass-daemon: failed to spawn ${script}: ${String((e && e.message) || e)}`); resolve({ code: null, signal: null, spawnError: String((e && e.message) || e) }); });
  });
}

// Adapter for opaque pass CLIs: exclusion/policy, launch and deadline recovery belong to
// the shared task/job layer. Only the CLI's original result and timing projection live here.
const activePasses = new Map();
const QUARANTINE_EVENT_INTERVAL_MS = 60 * 60 * 1000;
export function runPassAsTimedJob({ passName, repo, entry }, ports = {}) {
  const env = ports.env ?? process.env;
  const store = ports.store ?? createJobStore(daemonJobsDir('conveyor-passes', env));
  const key = JSON.stringify([store.dir, passName, repo]);
  if (activePasses.has(key)) return activePasses.get(key);
  const pending = executeTimedPass({ passName, repo, entry }, { ...ports, store, env });
  activePasses.set(key, pending);
  pending.finally(() => { if (activePasses.get(key) === pending) activePasses.delete(key); }).catch(() => {});
  return pending;
}

async function executeTimedPass({ passName, repo, entry }, ports) {
  const { store, env, root = REPO_ROOT, now = Date.now, host = hostName(), readStart = readProcStart } = ports;
  const aliases = ports.aliases ?? localHostAliases();
  // A legacy {log,error} sink carries only relayed child output; diagnostics go to the process log.
  const log = typeof ports.log === 'function' ? ports.log : line => console.error(line);
  const alert = ports.alert ?? (detail => log(`pass-daemon: ALERT ${JSON.stringify(detail)}`));
  const probe = ports.probe ?? probeHandle;
  const stop = ports.stop ?? ((handle, options) => stopHandle(handle, { ...options, probe }));
  // An injected owner probe cannot confirm detached descendants are gone.
  // Require an independent group reaper or retain quarantine for operator recovery.
  const reapGroup = ports.reapGroup ?? (ports.probe
    ? () => false
    : (handle, notAfterMs, options) => reapDeadGroup(handle, { ...options, notAfterMs }));
  const observeOwner = handle => {
    try { return probe(handle); } catch { return 'unknown'; }
  };
  const validOwnerIdentity = job => {
    const handle = parseJobHandle(job.handle);
    return handle && Number.isSafeInteger(handle.pid)
      // Locality follows the shared probes; persisted identity must still agree exactly.
      && (handle.host === host || aliases.has(handle.host)) && job.host === handle.host
      && job.pid === handle.pid && job.procStart === handle.procStart
      && (job.pgid == null || job.pgid === handle.pid);
  };
  const reapRecordedGroup = (job, observedExitAt) => {
    if (!validOwnerIdentity(job)) return false;
    // ps lstart has second precision. Never extend an old owner's window to
    // the recovery tick: its PGID may have belonged to another workload since.
    // The shared reaper also refuses any currently occupied leader PID.
    const ownerStartMs = Date.parse(job.procStart);
    const lastAliveMs = Date.parse(job.heartbeatAt ?? job.startedAt ?? '');
    // A locally observed child exit proves a fresh lifetime boundary. Its
    // descendants may have started long after the owner; recovery has no such proof.
    const cutoff = observedExitAt ?? Math.min(ownerStartMs, lastAliveMs) + 1000;
    return reapGroup(job.handle, cutoff, { requireConfirmedDeath: true }) === true;
  };
  const confirmGroupGone = (job, observedExitAt) => {
    try {
      return validOwnerIdentity(job) && observeOwner(job.handle) === 'dead'
        && reapRecordedGroup(job, observedExitAt);
    } catch { return false; }
  };
  const kindDef = defineJobKind({ kind: `pass-${createHash('sha256').update(passName).digest('hex').slice(0, 24)}`, entry: entry.script,
    codeMode: 'mutates-tree', prepareWorktree: () => root, maxAttempts: 1, resumable: false });
  const listed = store.list();
  if (listed.corrupt.length) throw new Error(`pass job store corrupt: ${listed.corrupt.join(', ')}; inspect and repair before retrying`);
  let record = listed.records.find(r => r.job.task?.kind === kindDef.kind && r.job.task.repo === repo &&
    r.job.task.item === 1 && !TERMINAL_JOB_STATUSES.includes(r.job.status));
  if (record?.job.passQuarantine) {
    let emission;
    let cleared = false;
    // Observe the fresh record under its lock: neither an absent handle nor a dead
    // owner alone proves that the detached group (whose pgid is its pid) is gone.
    store.update(record.id, r => {
      if (!r.job.passQuarantine) return null;
      const observedAt = now();
      const ts = new Date(observedAt).toISOString();
      const handle = parseJobHandle(r.job.handle);
      const validIdentity = validOwnerIdentity(r.job);
      const ownerLiveness = validIdentity ? observeOwner(r.job.handle) : 'unknown';
      const groupGone = ownerLiveness === 'dead' && confirmGroupGone(r.job);
      const startedAt = Date.parse(r.job.launchedAt ?? r.job.startedAt ?? '');
      const ageMs = Number.isFinite(startedAt) ? Math.max(0, observedAt - startedAt) : null;
      const age = ageMs === null ? 'unknown' : `${Math.floor(ageMs / 3600000)}h ${Math.floor(ageMs / 60000) % 60}m ${Math.floor(ageMs / 1000) % 60}s`;
      const detail = { ts, passName, jobId: r.id, pid: r.job.pid ?? handle?.pid ?? null,
        pgid: r.job.pgid ?? handle?.pid ?? r.job.pid ?? null, ageMs, age };
      if (groupGone) {
        delete r.job.passQuarantine;
        delete r.job.passUnreapable;
        cleared = true;
        emission = { kind: 'pass-quarantine-cleared', detail };
        return markFailed(r, { at: ts, reason: 'Pass quarantine cleared: owner dead and process group confirmed gone' });
      }
      if (ownerLiveness !== 'alive') r.job.passUnreapable = true;
      const lastEventAt = Date.parse(r.job.passQuarantineEventAt ?? '');
      if (Number.isFinite(lastEventAt) && lastEventAt <= observedAt
        && observedAt - lastEventAt < QUARANTINE_EVENT_INTERVAL_MS) return r;
      const liveness = ownerLiveness === 'alive' ? 'alive' : 'unknown';
      emission = { kind: 'pass-quarantined', detail: { ...detail, ownerLiveness, groupGone,
        liveness, livenessUnknown: liveness === 'unknown', unreapable: !!r.job.passUnreapable,
        reason: 'Pass remains quarantined; operator must inspect owner/process group if recovery stays unconfirmed' } };
      return r;
    });
    if (emission) {
      log(`pass-daemon: ${emission.kind} ${JSON.stringify(emission.detail)}`);
      if (emission.detail.unreapable) alert({ kind: 'needs-you', passName, repo, id: record.id,
        reason: 'Pass unreapable: cannot prove process-group ownership and absence; operator must inspect before recovery' });
      // Use the shared JSONL envelope (at/kind/repo/daemon/detail). Keep the test
      // port and PATH alias local; WE_DAEMON_EVENTS is the writer's standard override.
      const eventsPath = ports.eventsPath ?? env.WE_DAEMON_EVENTS_PATH ?? env.WE_DAEMON_EVENTS;
      let appended = false;
      try {
        appended = await appendDaemonEvent({ ...emission, repo, daemon: 'pass-daemon' }, {
          env: { ...env, WE_DAEMON_EVENTS: eventsPath }, now: () => new Date(emission.detail.ts),
        });
      } catch { /* reporting failure must never change quarantine/recovery */ }
      if (!appended) {
        log(`pass-daemon: failed to append ${emission.kind} for job ${record.id}`);
      } else if (emission.kind === 'pass-quarantined') {
        // Throttle only durable notifications; a failed append must retry next run.
        store.update(record.id, r => {
          if (!r.job.passQuarantine) return null;
          const lastEventAt = Date.parse(r.job.passQuarantineEventAt ?? '');
          if (lastEventAt >= Date.parse(emission.detail.ts) && lastEventAt <= now()) return null;
          r.job.passQuarantineEventAt = emission.detail.ts;
          return r;
        });
      }
    }
    if (!cleared) return { outcome: 'quarantined' };
    record = null; // terminal history stays intact; enqueue the next sequence below
  }
  const seq = listed.records.reduce((latest, r) => r.job.kind === kindDef.kind && r.job.task?.repo === repo
    ? Math.max(latest, r.job.task.seq) : latest, 0) + 1;
  if (!record) record = enqueueItemTask({ store, kindDef, repo, item: 1, seq,
    codeSha: ports.codeSha ?? null, acting: false, resourceKind: 'light', now: now(),
    policyOptions: { env, ...ports.policyOptions } });
  log(`pass-daemon: ${passName} timeoutMs=${record.job.task.timeoutMs} source=${record.job.task.sources.timeoutMs}`);
  const id = record.id;
  const at = () => new Date(now()).toISOString();
  const finish = (result, outcome, quarantine = false) => {
    let timing;
    store.update(id, r => {
      if (r.job.passResult) return null;
      timing = { type: 'task-timing', taskId: r.job.task.id, attempt: r.job.attempts,
        outcome, elapsedMs: Math.max(0, now() - Date.parse(r.job.launchedAt)) };
      r.job.passResult = result;
      r.job.passTiming = timing;
      if (quarantine) {
        r.job.passQuarantine = true;
        r.job.passUnreapable = true;
      }
      else if (!TERMINAL_JOB_STATUSES.includes(r.job.status)) r = outcome === 'failed'
        ? markFailed(r, { at: at(), reason: result.spawnError ?? `exit code ${result.code}` })
        : markSucceeded(r, { at: at() });
      return r;
    });
    if (timing) log(JSON.stringify(timing));
    if (quarantine && timing) alert({ kind: 'needs-you', passName, repo, id,
      reason: 'Pass unreapable: cannot confirm pass gone; operator must inspect and recover the retained job before retrying' });
    return store.read(id).job.passResult;
  };
  let childResult;
  let unclaimedPid;
  if (record.job.status === 'queued') {
    record = launchJob({ store, id, kindDef, now, env, snapshot: ports.snapshot,
      spawnFn: ({ cwd }) => {
        let child;
        childResult = spawnPassChild(entry, { root: cwd, env, spawnFn: ports.spawnFn ?? spawn,
          log: typeof ports.log === 'function' ? { log, error: log } : ports.log ?? console,
          capture: entry.capture, quiet: entry.quiet, onChild: c => { child = c; } });
        const pid = child?.pid;
        unclaimedPid = pid;
        const procStart = readStart(pid);
        const handle = formatJobHandle({ host, pid, procStart });
        store.update(id, r => markClaimed(r, { at: at(), handle, host, pid, procStart }));
        unclaimedPid = null;
        return pid;
      } });
  }
  if (unclaimedPid) {
    store.update(id, r => { r.job.pid = unclaimedPid; return r; });
    childResult?.catch(() => {});
    return finish({ outcome: 'quarantined' }, 'quarantined', true);
  }
  let result;
  let observedExitAt;
  childResult = childResult?.catch(error => ({ code: null, signal: null, spawnError: String(error?.message || error) }));
  childResult?.then(value => { result = value; observedExitAt = now(); });
  for (;;) {
    record = store.read(id);
    if (record.job.passResult) return record.job.passResult;
    const deadline = taskDeadlineDecision(record, { now: now() });
    const awaitingClaim = !childResult && record.job.status === 'launching' && !record.job.handle;
    if (deadline?.expired) {
      if (awaitingClaim) {
        // The launcher may already have a child and still be reading its start
        // identity. Keep its claim and result untouched so a late claim still
        // enforces this deadline; an absent handle is not proof of death.
        alert({ passName, repo, id, reason: 'Pass deadline expired before its handle was recorded; operator must inspect the retained launch' });
        return { outcome: 'quarantined' };
      }
      // Scope recovery to this pass: an unrelated slow stop cannot hold up its siblings.
      const scopedStore = { ...store, list: () => ({ records: [store.read(id)], corrupt: [] }) };
      const recovery = await reattachTick({ store: scopedStore, kinds: new Map([[kindDef.kind, kindDef]]),
        maxConcurrent: 1, observation: { now: now(), slept: false, gapMs: 0 },
        probe, stop, reapGroup: handle => {
          const job = store.read(id).job;
          return job.handle === handle && reapRecordedGroup(job, observedExitAt);
        }, staleMs: Number.MAX_SAFE_INTEGER, log });
      const quarantine = recovery.actions.some(a => a.action === 'stop-failed')
        || !TERMINAL_JOB_STATUSES.includes(store.read(id).job.status);
      return finish({ outcome: quarantine ? 'quarantined' : 'timeout' }, quarantine ? 'quarantined' : 'timeout', quarantine);
    }
    if (result) {
      // A child result does not prove its subprocess group is gone.
      // Keep the durable claim and alert if reaping cannot confirm absence.
      if (record.job.handle && !confirmGroupGone(record.job, observedExitAt)) {
        return finish({ outcome: 'quarantined' }, 'quarantined', true);
      }
      return finish(result, result.code === 0 && !result.spawnError ? 'acted' : 'failed');
    }
    if (TERMINAL_JOB_STATUSES.includes(record.job.status)) return finish({ code: null, signal: null,
      spawnError: record.job.error ?? 'pass exited without a recorded result' }, 'failed');
    // Reattached owners have no local ChildProcess; judge them through shared recovery.
    if (!childResult && !awaitingClaim && observeOwner(record.job.handle) !== 'alive') {
      const quarantine = !confirmGroupGone(record.job);
      return finish(quarantine ? { outcome: 'quarantined' } : { code: null, signal: null,
        spawnError: 'pass owner exited without a recorded result' }, quarantine ? 'quarantined' : 'failed', quarantine);
    }
    let timer;
    try {
      await Promise.race([...(childResult && !result ? [childResult] : []),
        new Promise(resolve => { timer = setTimeout(resolve, Math.min(1000, Math.max(1, deadline.deadlineAt - now()))); })]);
    } finally { clearTimeout(timer); }
  }
}

export function spawnPassOnce(entry, ports = {}) {
  const args = entry.args ?? [];
  const repo = ports.repo ?? args.find(a => a.startsWith('--repo='))?.slice(7) ?? CONSTELLATION_REPOS.we.slug;
  return runPassAsTimedJob({ passName: ports.passName ?? entry.script, repo, entry }, ports);
}

async function main(argv) {
  installDaemonLog(); // item 68a: ISO-stamp every log line (WE_DAEMON_LOG_TIMESTAMPS=0 turns it off)
  const flags = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    flags[eq === -1 ? a.slice(2) : a.slice(2, eq)] = eq === -1 ? true : a.slice(eq + 1);
  }
  const passName = typeof flags.pass === 'string' ? flags.pass : null;
  if (!passName) { console.error('pass-daemon: --pass=<name> is required (see skills-src/conveyor/daemon-manifest.mjs for known entries).'); process.exit(1); }

  let entry;
  try { entry = await waitForManifestEntry(passName); }
  catch (e) { console.error(String((e && e.message) || e)); process.exit(1); return; }

  const intervalMs = flags.interval ? Number(flags.interval) : entry.intervalMs;
  const heartbeatIntervalMs = flags['heartbeat-interval'] ? Number(flags['heartbeat-interval']) : DEFAULT_HEARTBEAT_INTERVAL_MS;
  const key = passDaemonLeaseKey(passName);
  const owner = makeOwner(`pass-daemon:${passName}`);

  const acquired = acquireRunnerLease(RUNNER_LOCK_ROOT, owner, { key });
  if (!acquired.ok) { console.error(`pass-daemon: a live "${passName}" instance already holds the lease (${acquired.heldBy}) — exiting.`); return; }

  let alive = true;
  const heartbeatTimer = setInterval(() => {
    // THE INDEPENDENT HEARTBEAT — fires on its own real timer regardless of whether a pass run is in flight.
    if (!heartbeatRunnerLease(RUNNER_LOCK_ROOT, owner, { key })) {
      alive = false;
      console.error(`pass-daemon: lease lost for "${passName}" — will stop after the current run.`);
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  let activePass = null;
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    alive = false;
    console.error(`pass-daemon: ${signal} — waiting for "${passName}" before releasing its lease and exiting.`);
    await Promise.allSettled([activePass]);
    clearInterval(heartbeatTimer);
    releaseRunnerLeaseIfOwned(RUNNER_LOCK_ROOT, owner, { key });
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // xdpemd4 — self-sync this watcher's clone between runs, same contract every other resident daemon already
  // has (see the file header). A no-op unless DAEMON_SELF_SYNC_BRANCH (or plain main-tracking self-sync) is
  // opted into. Self-sync runs before the next spawn, with no previous pass in flight.
  // Do not await activePass here: it contains this very callback. Release the lease
  // and exit so launchd brings this pass back up on the freshly-merged code.
  const restartOntoNewCode = () => {
    if (stopping) return;
    stopping = true;
    console.error(`pass-daemon: "${passName}" self-synced onto new code — releasing the lease and exiting.`);
    clearInterval(heartbeatTimer);
    releaseRunnerLeaseIfOwned(RUNNER_LOCK_ROOT, owner, { key });
    process.exit(0);
  };
  // #4044 Module E — a main-only pass (see MAIN_ONLY_PASSES) never self-syncs onto an overlay: if POC mode
  // (DAEMON_SELF_SYNC_BRANCH) is also set, that would otherwise track a POC branch instead of plain `main` —
  // refuse it here, loudly, and fall back to a plain main-only rebuild rather than silently doing either the
  // wrong thing (tracking the POC branch) or nothing (skipping self-sync entirely for this pass).
  const mainOnly = MAIN_ONLY_PASSES.has(passName);
  let selfSyncEnv = process.env;
  if (mainOnly && resolvePocSyncBranch({ env: process.env })) {
    console.error(
      `pass-daemon: "${passName}" is a main-only pass — refusing POC mode `
      + `(${DAEMON_SELF_SYNC_BRANCH_ENV}=${process.env[DAEMON_SELF_SYNC_BRANCH_ENV]}); self-sync falls back to plain origin/main only.`,
    );
    selfSyncEnv = { ...process.env, [DAEMON_SELF_SYNC_BRANCH_ENV]: '' };
  }
  // #gh-write-burst — every `gh` call this pass's own process makes is now attributable to THIS exact manifest
  // entry (see `spawnPassOnce`'s own docblock above for why a per-repo pass needs this and argv[1] alone can't
  // give it).
  // Built PER SPAWN, never once up front (live 2026-10-09): `refreshAuth` (per-owner App auth) puts the gh shim on
  // `process.env.PATH` right before each spawn. A snapshot taken here, before the first refresh, never had it, so
  // every pass child ran gh on the operator's PERSONAL stored login for the daemon's whole life.
  const passEnv = () => passEnvFor(passName);
  // Card 89 S5: on a versioned clone withSelfSync sets `tickContext.tickRoot` to the version folder this tick is
  // pinned to, and the pass child spawns from THERE (a switch mid-tick never moves a running child's tree).
  const tickContext = {};
  const runPassSelfSynced = passDaemonSelfSyncEnabled()
    ? withSelfSync({ tickOnce: () => spawnPassOnce(entry, { passName, env: passEnv(), root: tickContext.tickRoot ?? REPO_ROOT }) }, {
      root: REPO_ROOT, onRestart: restartOntoNewCode, mainOnly, env: selfSyncEnv, tickContext,
    }).tickOnce
    : () => spawnPassOnce(entry, { passName, env: passEnv() });

  const failureAlertAfter = resolveFailureAlertAfter(entry, process.env);
  console.error(`pass-daemon: started "${passName}" (${entry.script}) on interval ${intervalMs}ms, heartbeat every ${heartbeatIntervalMs}ms.`);
  const { stoppedReason } = await runPassDaemonLoop({
    runPass: () => (activePass = runPassSelfSynced()),
    sleep: realSleep,
    isAlive: () => alive,
    intervalMs, tickWhileRunning: true,
    failureAlertAfter,
    onConsecutiveFailures: ({ count, detail }) => alertConsecutiveFailures(passName, count, detail),
    refreshAuth: () => ensureFreshGithubAppEnv(FLEET_APP_AUTH_OPTS),
    onRunError: (e) => console.error(`pass-daemon: "${passName}" run failed (non-fatal): ${String((e && e.message) || e).split('\n')[0]}`),
    onRefreshError: (e) => console.error(`pass-daemon: "${passName}" GitHub App token refresh failed (non-fatal, falling back to personal auth): ${String((e && e.message) || e).split('\n')[0]}`),
  });
  if (!stopping) {
    console.error(`pass-daemon: "${passName}" loop stopped (${stoppedReason}) — releasing the lease and exiting.`);
    clearInterval(heartbeatTimer);
    releaseRunnerLeaseIfOwned(RUNNER_LOCK_ROOT, owner, { key });
  }
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  main(process.argv.slice(2)).catch((e) => { console.error(`pass-daemon: fatal: ${String((e && e.message) || e)}`); process.exit(1); });
}
