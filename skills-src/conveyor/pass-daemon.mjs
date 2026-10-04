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
 * touching any pass script itself. Opt-in (the three `WE_GITHUB_APP_*` env vars), never throws, and falls
 * back to the operator's personal `gh auth login` token unchanged if the App isn't configured or a mint
 * fails — see that module's own header. Six resident `lane-pool-health-watch`/`parked-pr-conflict-watch`
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

import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveManifestEntry } from './daemon-manifest.mjs';
import {
  RUNNER_LOCK_ROOT, makeOwner,
  acquireRunnerLease, heartbeatRunnerLease, releaseRunnerLeaseIfOwned,
} from './runner-lock.mjs';
import { ensureFreshGithubAppEnv, FLEET_APP_AUTH_OPTS } from '../../scripts/lib/github-app-auth-env.mjs';
import { withSelfSync, resolvePocSyncBranch, DAEMON_SELF_SYNC_BRANCH_ENV } from '../../scripts/lib/daemon-self-sync.mjs';

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
 * refreshes per-tick rather than on a timer). A failed refresh is isolated exactly like a failed run — logged
 * via `onRefreshError`, never allowed to skip the spawn: falling back to whatever auth is already in effect
 * (personal, if the App isn't configured or its mint failed) is always preferable to the watcher not running.
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
  intervalMs, maxRuns = Infinity,
}) {
  if (typeof runPass !== 'function') throw new TypeError('runPassDaemonLoop requires a runPass effect');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new TypeError('runPassDaemonLoop requires a positive intervalMs');
  let run = 0;
  for (;;) {
    try {
      await refreshAuth();
    } catch (error) {
      onRefreshError(error, run);
    }
    try {
      const result = await runPass();
      onRun(result, run);
    } catch (error) {
      onRunError(error, run);
    }
    if (!isAlive()) return { runs: run + 1, stoppedReason: 'lease-lost' };
    if (run + 1 >= maxRuns) return { runs: run + 1, stoppedReason: 'max-runs' };
    await sleep(intervalMs);
    run += 1;
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
export function realSleep(ms) { return new Promise((resolve) => { setTimeout(resolve, ms); }); }

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
export function spawnPassOnce({ script, args = [] }, { root = REPO_ROOT, log = console, env = process.env, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    const child = spawnFn(process.execPath, [join(root, script), ...args], { stdio: ['ignore', 'inherit', 'inherit'], env });
    child.on('exit', (code, signal) => {
      if (code !== 0) log.error(`pass-daemon: ${script} exited ${signal ? `on ${signal}` : `with code ${code}`}`);
      resolve({ code, signal });
    });
    child.on('error', (e) => { log.error(`pass-daemon: failed to spawn ${script}: ${String((e && e.message) || e)}`); resolve({ code: null, signal: null, spawnError: String((e && e.message) || e) }); });
  });
}

async function main(argv) {
  const flags = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    flags[eq === -1 ? a.slice(2) : a.slice(2, eq)] = eq === -1 ? true : a.slice(eq + 1);
  }
  const passName = typeof flags.pass === 'string' ? flags.pass : null;
  if (!passName) { console.error('pass-daemon: --pass=<name> is required (see skills-src/conveyor/daemon-manifest.mjs for known entries).'); process.exit(1); }

  let entry;
  try { entry = resolveManifestEntry(passName); }
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

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.error(`pass-daemon: ${signal} — releasing "${passName}"'s lease and exiting.`);
    clearInterval(heartbeatTimer);
    releaseRunnerLeaseIfOwned(RUNNER_LOCK_ROOT, owner, { key });
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // xdpemd4 — self-sync this watcher's clone between runs, same contract every other resident daemon already
  // has (see the file header). A no-op unless DAEMON_SELF_SYNC_BRANCH (or plain main-tracking self-sync) is
  // opted into; `restartOntoNewCode` mirrors `shutdown` (release the lease, exit 0) so launchd's KeepAlive
  // brings this pass back up on the freshly-merged code, exactly like `review-daemon.mjs`'s own restart path.
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
  const passEnv = { ...process.env, GH_CALLER: passName };
  const runPassSelfSynced = passDaemonSelfSyncEnabled()
    ? withSelfSync({ tickOnce: () => spawnPassOnce(entry, { env: passEnv }) }, {
      root: REPO_ROOT, onRestart: restartOntoNewCode, mainOnly, env: selfSyncEnv,
    }).tickOnce
    : () => spawnPassOnce(entry, { env: passEnv });

  console.error(`pass-daemon: started "${passName}" (${entry.script}) on interval ${intervalMs}ms, heartbeat every ${heartbeatIntervalMs}ms.`);
  const { stoppedReason } = await runPassDaemonLoop({
    runPass: runPassSelfSynced,
    sleep: realSleep,
    isAlive: () => alive,
    intervalMs,
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
