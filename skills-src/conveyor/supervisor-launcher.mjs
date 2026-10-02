#!/usr/bin/env node
/**
 * @file skills-src/conveyor/supervisor-launcher.mjs
 * @description #3874 (epic #3383) — the thin top-level launcher that gives EVERY resident conveyor daemon
 *   named in {@link ./daemon-manifest.mjs}'s closed allowlist the same restart-on-crash / back-off-on-a-
 *   crash-loop protection we:skills-src/conveyor/supervisor.mjs already built for the Dispatcher
 *   (we:skills-src/conveyor/runner.mjs) alone — without a single line of supervisor.mjs changing.
 *
 * CORRECTED PREMISE #1 (documented in full in this item's own backlog card, backlog/3874-…md's `## Progress`
 * section). The card that opened this item asks whether we:skills-src/conveyor/supervisor.mjs's CLI "takes a
 * `--pass=` style flag itself" to pick which script it supervises. Read directly (its own `main()`): it does
 * not. `main()` hardcodes `RUNNER_PATH = join(HERE, 'runner.mjs')` and forwards every OTHER flag straight to
 * that fixed target — there is no flag, env var, or other lever to redirect it. Spawning N copies of
 * `node supervisor.mjs` would therefore spawn N supervisors of the SAME runner.mjs, never one per manifest
 * entry. What supervisor.mjs's own file DOES already offer, proven generic by its OWN test suite (see
 * `makeRealSpawnChild — real node child processes, never runner.mjs itself` in
 * we:skills-src/conveyor/__tests__/supervisor.test.mjs, which spawns arbitrary `-e` scripts, never
 * runner.mjs), is its EXPORTED pure core: {@link runSupervisorLoop} (the whole restart/backoff control flow,
 * every effect injected) and `makeRealSpawnChild` (the real `child_process` wiring, parameterized by
 * `runnerPath`/`extraArgs`). This launcher imports both UNMODIFIED and drives one restart/backoff loop per
 * manifest entry — each of which spawns a REAL, independent child OS process running that entry's own
 * script — inside this one launcher process. Zero edits to supervisor.mjs.
 *
 * CORRECTED PREMISE #2. {@link DAEMON_MANIFEST} does NOT already carry 15 real entries. Read directly (its
 * own file header, and we:skills-src/conveyor/__tests__/daemon-manifest.test.mjs's own first assertion): it
 * starts EMPTY, by design — #3871 built the mechanism only. #3873 (wiring the 8 watcher passes onto
 * we:skills-src/conveyor/pass-daemon.mjs) is still `status: open`, unbuilt, at the time this launcher was
 * written. This launcher is built to be correct against that reality: it takes whatever names are CURRENTLY
 * registered (or an explicit `--only=` subset) with zero hardcoded entry names of its own, so the exact same,
 * unchanged file picks up #3873's watchers — and any later Dispatcher/Fix-dispatch/Review/Verify entries —
 * the moment a sibling slice registers them, with no code change here. It deliberately does NOT itself
 * register any new entries into the shared allowlist: {@link resolveManifestEntry} is also what
 * we:skills-src/conveyor/pass-daemon.mjs resolves `--pass=<name>` through, so adding an entry here would
 * silently change what THAT daemon can also be pointed at — a real product decision belonging to whichever
 * slice actually wires each script, not a side effect of building this launcher (this item's own `scope`
 * only ever named we:skills-src/conveyor/supervisor.mjs).
 *
 * CORRECTED PREMISE #3 (round 2 of PR #2472's review; documented in full in backlog/3874-…md's `## Progress`
 * section, fourth correction). The paragraph immediately below this one, as originally written, claimed "no
 * new locking primitive is needed at this layer" and that EVERY resident script this launcher targets
 * "already protects itself against a duplicate live instance with its OWN lease." Read directly against what
 * this file's OWN manifest entries actually are TODAY (every one of the 15 real {@link DAEMON_MANIFEST}
 * entries, #3873): none of `branch-drift.mjs`/`ci-queue-watch.mjs`/etc. take their own lease directly — that
 * lease (we:skills-src/conveyor/pass-daemon.mjs's `passDaemonLeaseKey(name)`) is acquired ONLY by
 * we:skills-src/conveyor/pass-daemon.mjs's OWN IO shell, which THIS launcher bypassed entirely by spawning
 * each entry's script directly. Worse, {@link planLaunchTargets} silently dropped every entry's own
 * `intervalMs` (documented on {@link ../daemon-manifest.mjs}'s own `DaemonManifestEntry` typedef as "how often
 * pass-daemon.mjs re-runs this pass"), so a launched entry's clean, expected exit (`code:0`) fell straight
 * into supervisor.mjs's `decideRestart`, which gives an ordinary clean exit `delayMs: 0` — an IMMEDIATE
 * respawn, forever, completely ignoring the entry's own pacing. That is worse than the race this section
 * used to describe as the worst case: not an occasional overlap with a concurrently-running
 * `pass-daemon.mjs --pass=<name>`, but a permanent zero-delay busy-loop re-running every currently-registered
 * entry nonstop the instant this launcher's `main()` is ever actually invoked against real manifest entries.
 *
 * FIXED by making {@link launchEntry} do two things supervisor.mjs's own reused-unmodified core cannot do on
 * its own, since every current manifest entry is a PERIODIC ONE-SHOT pass (runs to completion, then waits
 * `intervalMs`, then runs again) — a fundamentally different shape than supervisor.mjs's own target
 * (we:skills-src/conveyor/runner.mjs, a process that should basically never exit, where any exit is a crash to
 * restart-with-backoff):
 *   1. Take the SAME `passDaemonLeaseKey(name)` lease we:skills-src/conveyor/pass-daemon.mjs would take for
 *      `--pass=<name>` — imported and reused UNMODIFIED, never re-derived — before spawning anything, so a
 *      real concurrent `pass-daemon.mjs --pass=<name>` instance and this launcher's own copy of the same
 *      entry genuinely contend for one lease rather than both running. One held for this entry's WHOLE
 *      lifetime (acquired once, heartbeat throughout, released on stop) — mirrors
 *      we:skills-src/conveyor/pass-daemon.mjs's own `main()` shape exactly, not a per-run acquire/release.
 *   2. Drive each entry through {@link runPeriodicSupervisorLoop} (this file's own new pure-core function,
 *      NOT supervisor.mjs's `runSupervisorLoop`) instead: reuses supervisor.mjs's `classifyExit`/`decideRestart`
 *      UNMODIFIED for the "was this actually a crash" question (a non-zero exit or death-by-signal is still
 *      classified and backed off exactly as supervisor.mjs already does), but a CLEAN exit paces the next run
 *      by the entry's own `intervalMs` (now threaded through by {@link planLaunchTargets}) — mirroring
 *      we:skills-src/conveyor/pass-daemon.mjs's own `runPassDaemonLoop` pacing — rather than supervisor.mjs's
 *      `delayMs: 0` assumption, which is only correct for a long-running resident whose exit is a polite
 *      stand-down, never for a periodic pass whose clean exit is the NORMAL, expected outcome of every run.
 *
 * `classifyExit`'s own `too-short` heuristic (anything under `crashThresholdMs`, default 3s) is tuned for
 * we:skills-src/conveyor/runner.mjs's own tick shape — "a real tick reliably costs low-hundreds of ms," per
 * that file's own doc comment — which does NOT hold for an arbitrary one-shot watcher pass that may
 * legitimately finish in well under 3s (e.g. a quick "nothing to do" check). Reusing the 3s default here would
 * misclassify a fast, successful, expected run as a crash. {@link runPeriodicSupervisorLoop} therefore calls
 * `classifyExit` with `crashThresholdMs: 0` by default (still overridable) — signal-death and a non-zero exit
 * code are UNAMBIGUOUS crash signals regardless of runtime and are still always classified `'crash'`; only the
 * runtime-based `'too-short'` heuristic (inapplicable to this class of script) is disabled.
 *
 * WHAT THIS DOES NOT SOLVE (open question, not this fix's scope — see backlog/3874-…md's own THIRD
 * correction). {@link DAEMON_MANIFEST}'s schema (#3871) requires `intervalMs` on EVERY entry; there is today no
 * discriminator marking an entry as a genuinely long-running RESIDENT (Dispatcher, Fix-dispatch, Review,
 * Verify — this card's own stated eventual targets) rather than a periodic one-shot pass. A resident entry
 * has no periodic-pacing concept and should still go through supervisor.mjs's own `runSupervisorLoop`
 * unchanged; that split needs a manifest-schema addition (e.g. an explicit `kind` field) belonging to whichever
 * slice actually registers the first resident entry — this fix only corrects what is real today, where every
 * entry is a periodic one-shot pass.
 *
 * PURE-CORE / IO-SHELL SPLIT (mirrors this epic's established shape — see we:skills-src/conveyor/pass-daemon.mjs
 * and we:skills-src/conveyor/review-daemon.mjs headers):
 *   • {@link planLaunchTargets}, {@link defaultLaunchNames}, and {@link runPeriodicSupervisorLoop} are the pure
 *     core — no IO of their own, `resolveEntry`/`manifest`/every effect injected, unit-tested against fixture
 *     manifests and fake effects (skills-src/conveyor/__tests__/supervisor-launcher.test.mjs) — never the real
 *     `DAEMON_MANIFEST` for the fixture-driven cases. One bad name never aborts the rest (mirrors this epic's
 *     own "one bad entry never aborts the rest" discipline: reconcile-pass.mjs's per-PR isolation,
 *     review-daemon.mjs's per-repo isolation).
 *   • {@link launchEntry} and {@link launchAll} are IO-shell GLUE that itself takes injectable
 *     `runLoop`/`makeSpawnChild`/`makeLog`/`acquireLease`/`heartbeatLease`/`releaseLease` (defaulting to the
 *     real, unmodified exports this header describes above) — unit-tested with fakes for all of those, so no
 *     real subprocess and no real lease file is ever touched by the unit suite. A SEPARATE integration suite
 *     (skills-src/conveyor/__tests__/supervisor-launcher.integration.test.mjs) drives `launchEntry` with NO
 *     injected `spawnChild`/`runLoop` against a realistic one-shot fixture script, proving the real
 *     `classifyExit`/`runPeriodicSupervisorLoop`/lease path — the exact gap the review named (every prior test
 *     here only ever exercised injected fakes).
 *   • `main()` (gated on direct invocation, exactly like supervisor.mjs's own) is the ONLY code path that
 *     actually spawns real children — it resolves the CLI's requested names, launches one supervised loop
 *     per entry, and forwards SIGINT/SIGTERM to every live child so a stopped launcher never leaves one
 *     orphaned.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveManifestEntry, DAEMON_MANIFEST } from './daemon-manifest.mjs';
import {
  classifyExit, decideRestart, makeRealSpawnChild, makeJsonlLog,
  DEFAULT_BASE_BACKOFF_MS, DEFAULT_MAX_BACKOFF_MS,
} from './supervisor.mjs';
import { passDaemonLeaseKey, DEFAULT_HEARTBEAT_INTERVAL_MS } from './pass-daemon.mjs';
import {
  RUNNER_LOCK_ROOT, makeOwner, acquireRunnerLease, heartbeatRunnerLease, releaseRunnerLeaseIfOwned,
} from './runner-lock.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Where each entry's own supervisor JSONL history lands — one file per entry name, under the SAME lock root
 *  every other resident piece of this epic uses (memory rule 105), never a third state location, and never
 *  interleaved with a sibling entry's own history. */
export const DEFAULT_LOG_ROOT = join(RUNNER_LOCK_ROOT, 'supervisor-launcher');

// ── PURE CORE (no IO — every effect is injected; unit-tested directly) ─────────────────────────────────────

/**
 * Resolve a requested list of manifest names into concrete launch targets, isolating one unresolvable name
 * from the rest rather than aborting the whole launch over one typo or one not-yet-registered entry. Pure —
 * `resolveEntry` is injected (defaults to the real {@link resolveManifestEntry}) so this is unit-tested
 * against a fixture manifest, never the real `DAEMON_MANIFEST`.
 *
 * CORRECTED (round 2 of PR #2472's review — see this file's own header, "CORRECTED PREMISE #3"): this used to
 * drop each entry's own `intervalMs` on the floor, carrying only `script`/`args` into the resolved target. That
 * silently threw away the ONE piece of information {@link launchEntry} needs to pace a periodic one-shot pass
 * correctly instead of handing every exit straight to supervisor.mjs's crash-restart machinery. Now carried
 * through unchanged from the resolved manifest entry.
 * @param {string[]} names
 * @param {{ manifest?: Record<string, object>, resolveEntry?: (name:string, manifest:object) => object }} [o]
 * @returns {{
 *   targets: Array<{ name:string, script:string, args:string[], intervalMs:number }>,
 *   failures: Array<{ name:string, error:string }>,
 * }}
 */
export function planLaunchTargets(names, { manifest = DAEMON_MANIFEST, resolveEntry = resolveManifestEntry } = {}) {
  const list = Array.isArray(names) ? names : [];
  const targets = [];
  const failures = [];
  for (const name of list) {
    try {
      const entry = resolveEntry(name, manifest);
      targets.push({
        name, script: entry.script, args: Array.isArray(entry.args) ? entry.args : [], intervalMs: entry.intervalMs,
      });
    } catch (e) {
      failures.push({ name, error: String((e && e.message) || e) });
    }
  }
  return { targets, failures };
}

/**
 * The names to launch when the CLI is given none of its own: every name CURRENTLY registered in the manifest
 * except entries marked `defaultLaunch: false` (start-by-name only), sorted for a deterministic launch order. Today (see this file's own header): none — #3873 and any later
 * daemon-launcher slice are what populate the real manifest; this same, unchanged function then picks up
 * whatever they register with zero code change here. Pure.
 * @param {Record<string, object>} [manifest]
 * @returns {string[]}
 */
export function defaultLaunchNames(manifest = DAEMON_MANIFEST) {
  return Object.keys(manifest).filter((name) => manifest[name]?.defaultLaunch !== false).sort();
}

/** Below this runtime, a `classifyExit`-eligible exit would ordinarily read as `'too-short'` (see
 *  supervisor.mjs's own `DEFAULT_CRASH_THRESHOLD_MS`, 3s) — a heuristic tuned for we:runner.mjs's own tick
 *  shape, not for an arbitrary periodic one-shot pass, which may legitimately finish in well under 3s (e.g. a
 *  quick "nothing to do" check). `0` disables that ONE heuristic — a non-zero exit code or death-by-signal is
 *  still always classified `'crash'` by `classifyExit` regardless of this value. See this file's own header,
 *  "CORRECTED PREMISE #3". */
export const DEFAULT_PERIODIC_CRASH_THRESHOLD_MS = 0;

/**
 * Drive ONE periodic one-shot manifest entry's own run/pace/backoff control flow — a reducer over injected
 * effects, unit-testable with fakes, no IO of its own. Reuses supervisor.mjs's {@link classifyExit} and
 * {@link decideRestart} UNMODIFIED for the "was this actually a crash" question (a non-zero exit or
 * death-by-signal still gets the exact same doubling backoff supervisor.mjs itself applies to `runner.mjs`),
 * but a CLEAN exit paces the NEXT run by `intervalMs` — mirroring we:skills-src/conveyor/pass-daemon.mjs's own
 * `runPassDaemonLoop` pacing — rather than supervisor.mjs's own `decideRestart`, which gives an ordinary clean
 * exit `delayMs: 0` (correct for a long-running resident whose exit is a polite stand-down; wrong here, where
 * a clean exit is the NORMAL, expected outcome of every run of a periodic pass). See this file's own header,
 * "CORRECTED PREMISE #3", for the full review-round context this function was built to close.
 *
 * @param {object} effects
 * @param {()=>Promise<{code:number|null,signal:string|null,ranMs:number}>} effects.spawnChild
 * @param {number} effects.intervalMs        how long to wait after a CLEAN exit before the next run
 * @param {(entry:object)=>any} [effects.log]
 * @param {(ms:number)=>any} [effects.sleep]
 * @param {number} [effects.maxRestarts]
 * @param {()=>boolean} [effects.shouldStop]
 * @param {number} [effects.baseBackoffMs]
 * @param {number} [effects.maxBackoffMs]
 * @param {number} [effects.crashThresholdMs]  see {@link DEFAULT_PERIODIC_CRASH_THRESHOLD_MS}
 * @returns {Promise<{ restarts: number, stoppedReason: 'max-restarts'|'signal' }>}
 */
export async function runPeriodicSupervisorLoop({
  spawnChild,
  intervalMs,
  log = () => {},
  sleep = () => {},
  maxRestarts = Infinity,
  shouldStop = () => false,
  baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  crashThresholdMs = DEFAULT_PERIODIC_CRASH_THRESHOLD_MS,
} = {}) {
  if (typeof spawnChild !== 'function') throw new TypeError('runPeriodicSupervisorLoop requires a spawnChild effect');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError('runPeriodicSupervisorLoop requires a positive intervalMs (the manifest entry\'s own pacing)');
  }
  let consecutiveCrashes = 0;
  let restarts = 0;
  for (;;) {
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
      shutdownRequested: shouldStop(),
    });
    if (attempt >= maxRestarts) return { restarts, stoppedReason: 'max-restarts' };
    if (shouldStop()) return { restarts, stoppedReason: 'signal' };
    if (classification.kind === 'crash') {
      // A genuine crash (non-zero exit / signal death) — same doubling backoff supervisor.mjs itself applies,
      // reused unmodified. `consecutiveIdleStops` has no periodic-pass analogue; always 0.
      const restart = decideRestart({ classification, consecutiveCrashes, consecutiveIdleStops: 0 }, { baseBackoffMs, maxBackoffMs });
      consecutiveCrashes = restart.consecutiveCrashes;
      log({ event: 'backoff', at: new Date().toISOString(), delayMs: restart.delayMs, kind: 'crash', consecutiveCrashes });
      if (restart.delayMs > 0) await sleep(restart.delayMs);
    } else {
      // A clean, expected one-shot completion — pace the NEXT run by this entry's own intervalMs, never
      // supervisor.mjs's delayMs:0 assumption (see this function's own header for why that assumption is
      // wrong here).
      consecutiveCrashes = 0;
      log({ event: 'backoff', at: new Date().toISOString(), delayMs: intervalMs, kind: 'interval' });
      await sleep(intervalMs);
    }
  }
}

// ── IO SHELL (owns the real child processes — every effect defaults to supervisor.mjs's own real, UNMODIFIED
//    exports, but is injectable so the unit suite never spawns a real subprocess) ───────────────────────────

/** Resolve one manifest entry's repo-relative `script` against a repo root — pure string-join, no IO, kept
 *  here (not in the pure-core section above) because its only caller is the real-spawn IO glue below. */
export function resolveScriptPath(script, { root = REPO_ROOT } = {}) {
  return join(root, script);
}

/** Where one entry's own supervisor history JSONL lands. Pure string-join. */
export function entryLogPath(name, { logRoot = DEFAULT_LOG_ROOT } = {}) {
  return join(logRoot, `${name}.jsonl`);
}

/**
 * Drive ONE manifest entry's own run/pace/backoff loop to completion (which, absent a stop signal, is
 * "forever" — mirrors supervisor.mjs's own `main()` shape one level up, one entry at a time). Every real
 * effect (`makeSpawnChild`, `makeLog`, `runLoop`, `acquireLease`/`heartbeatLease`/`releaseLease`) defaults to
 * the real, UNMODIFIED exports this file's own header describes; all are injectable so the unit suite proves
 * this function's wiring WITHOUT ever spawning a real subprocess or touching a real lease file.
 *
 * TAKES THE PASS-DAEMON-COMPATIBLE LEASE FIRST (round 2 of PR #2472's review — see this file's own header,
 * "CORRECTED PREMISE #3"): before spawning anything, acquires the SAME `passDaemonLeaseKey(name)` lease
 * we:skills-src/conveyor/pass-daemon.mjs would take for `--pass=<name>`, held for this entry's WHOLE lifetime
 * (one heartbeat timer, released on stop) — mirrors we:skills-src/conveyor/pass-daemon.mjs's own `main()`
 * shape exactly. A name whose lease is already held elsewhere (a real concurrent `pass-daemon.mjs
 * --pass=<name>`, or a second copy of this launcher) is never spawned at all — returns immediately with
 * `stoppedReason: 'lease-denied'` rather than racing it, and never aborts a sibling entry's own launch (same
 * per-entry isolation {@link launchAll} already gives a plan-time resolution failure).
 * @param {{ name:string, script:string, args:string[], intervalMs:number }} target
 * @param {{
 *   root?: string, logRoot?: string,
 *   onChild?: (name:string, child: import('node:child_process').ChildProcess|null) => void,
 *   shouldStop?: () => boolean,
 *   sleep?: (ms:number) => Promise<void>,
 *   makeSpawnChild?: typeof makeRealSpawnChild,
 *   makeLog?: typeof makeJsonlLog,
 *   runLoop?: typeof runPeriodicSupervisorLoop,
 *   lockRoot?: string,
 *   heartbeatIntervalMs?: number,
 *   acquireLease?: typeof acquireRunnerLease,
 *   heartbeatLease?: typeof heartbeatRunnerLease,
 *   releaseLease?: typeof releaseRunnerLeaseIfOwned,
 *   maxRestarts?: number, baseBackoffMs?: number, maxBackoffMs?: number, crashThresholdMs?: number,
 *     — forwarded to `runLoop` unchanged (see {@link runPeriodicSupervisorLoop}'s own defaults); exposed here
 *     so a bounded caller (e.g. an integration test) can cap a real run without racing a `shouldStop` timer.
 * }} [o]
 * @returns {Promise<{ restarts:number, stoppedReason:string }>}
 */
export async function launchEntry({ name, script, args, intervalMs }, {
  root = REPO_ROOT, logRoot = DEFAULT_LOG_ROOT,
  onChild = () => {}, shouldStop = () => false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  makeSpawnChild = makeRealSpawnChild, makeLog = makeJsonlLog, runLoop = runPeriodicSupervisorLoop,
  lockRoot = RUNNER_LOCK_ROOT, heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  acquireLease = acquireRunnerLease, heartbeatLease = heartbeatRunnerLease, releaseLease = releaseRunnerLeaseIfOwned,
  maxRestarts, baseBackoffMs, maxBackoffMs, crashThresholdMs,
} = {}) {
  const runnerPath = resolveScriptPath(script, { root });
  const baseLog = makeLog(entryLogPath(name, { logRoot }));
  const log = (entry) => baseLog({ name, ...entry });

  const leaseKey = passDaemonLeaseKey(name);
  const leaseOwner = makeOwner(`supervisor-launcher:${name}`);
  const acquired = acquireLease(lockRoot, leaseOwner, { key: leaseKey });
  if (!acquired.ok) {
    log({ event: 'lease-denied', at: new Date().toISOString(), heldBy: acquired.heldBy || null });
    return { restarts: 0, stoppedReason: 'lease-denied' };
  }

  let leaseAlive = true;
  const heartbeatTimer = setInterval(() => {
    if (!heartbeatLease(lockRoot, leaseOwner, { key: leaseKey })) {
      leaseAlive = false;
      log({ event: 'lease-lost', at: new Date().toISOString() });
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  try {
    const spawnChild = makeSpawnChild({ runnerPath, extraArgs: args, onChild: (child) => onChild(name, child) });
    return await runLoop({
      spawnChild, intervalMs, log, sleep, shouldStop: () => shouldStop() || !leaseAlive,
      maxRestarts, baseBackoffMs, maxBackoffMs, crashThresholdMs,
    });
  } finally {
    clearInterval(heartbeatTimer);
    releaseLease(lockRoot, leaseOwner, { key: leaseKey });
  }
}

/**
 * Resolve the requested names (or every currently-registered one) and launch one supervised loop per
 * resolvable target, concurrently. A name that fails to resolve is reported via `onFailure` and simply never
 * launched — it does not abort the others (see {@link planLaunchTargets}'s own header). Returns immediately
 * with the failures and the in-flight promises (one per launched entry); the caller awaits those promises to
 * know when every entry has actually stopped (normally: never, until `shouldStop()` starts returning true).
 * @param {string[]} [names]
 * @param {object} [o] — forwarded to {@link planLaunchTargets} (`manifest`, `resolveEntry`) and
 *   {@link launchEntry} (everything else), plus `onFailure((failure) => void)`.
 * @returns {{
 *   failures: Array<{ name:string, error:string }>,
 *   launched: Array<{ name:string, script:string, args:string[], intervalMs:number }>,
 *   running: Promise<{ restarts:number, stoppedReason:string }>[],
 * }}
 */
export function launchAll(names, {
  manifest = DAEMON_MANIFEST, resolveEntry = resolveManifestEntry, onFailure = () => {}, ...entryOpts
} = {}) {
  const requested = Array.isArray(names) && names.length > 0 ? names : defaultLaunchNames(manifest);
  const { targets, failures } = planLaunchTargets(requested, { manifest, resolveEntry });
  for (const failure of failures) onFailure(failure);
  const running = targets.map((target) => launchEntry(target, entryOpts));
  return { failures, launched: targets, running };
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

async function main(argv) {
  const flags = parseFlags(argv);
  const only = typeof flags.only === 'string' ? flags.only.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const root = typeof flags.root === 'string' ? flags.root : REPO_ROOT;
  const logRoot = typeof flags['log-root'] === 'string' ? flags['log-root'] : DEFAULT_LOG_ROOT;

  const requested = only.length > 0 ? only : defaultLaunchNames(DAEMON_MANIFEST);
  if (requested.length === 0) {
    process.stderr.write('[conveyor-supervisor-launcher] no manifest entries registered (and none named via --only=) — nothing to launch.\n');
    return;
  }

  const liveChildren = new Map();
  let stopRequested = false;
  const shutdown = (signal) => {
    if (stopRequested) return;
    stopRequested = true;
    process.stderr.write(`[conveyor-supervisor-launcher] ${signal} — stopping ${liveChildren.size} live child(ren).\n`);
    for (const child of liveChildren.values()) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already exited cleanly */ } }, 5_000).unref();
    }
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(sig));

  const { failures, launched, running } = launchAll(requested, {
    manifest: DAEMON_MANIFEST, root, logRoot,
    onChild: (name, child) => { if (child) liveChildren.set(name, child); else liveChildren.delete(name); },
    shouldStop: () => stopRequested,
    onFailure: (f) => process.stderr.write(`[conveyor-supervisor-launcher] "${f.name}" not launched: ${f.error}\n`),
  });
  for (const target of launched) {
    process.stderr.write(`[conveyor-supervisor-launcher] launched "${target.name}" (${target.script}${target.args.length ? ' ' + target.args.join(' ') : ''}).\n`);
  }
  if (failures.length > 0 && launched.length === 0) {
    process.exitCode = 1;
    return;
  }
  await Promise.all(running);
}

// Run the IO shell only when invoked directly — never on import (keeps the pure core side-effect-free).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`✗ supervisor-launcher error: ${String((e && e.stack) || e)}\n`); process.exit(1); });
}
