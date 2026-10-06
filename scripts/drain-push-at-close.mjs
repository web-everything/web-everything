#!/usr/bin/env node
/**
 * drain-push-at-close.mjs — fire ONE detached, self-terminating drain watch when a serial batch closes (#2395,
 * under #2387). The "push the handoff" half of serial-batch → drain coordination.
 *
 * WHY: a `/batch` close already ENQUEUES every worked item as an open `ready-to-merge` PR (via
 * `pr-land --label-on-green`, batch SKILL step 3), but nothing LANDS them until someone runs `/drain` (the
 * deferred sweep). That leaves a green, ready chain sitting unlanded for however long until the next manual
 * drain. This launcher closes that gap: at close it optionally PUSHES the handoff — fires a detached drain
 * that lands the chain — while staying correct with it OFF (the deferred sweep is always the backstop).
 *
 * THE RULE — exactly one drain regardless of how many sessions close (#2395):
 *   1. Read the WHOLE-PROCESS drain lease (#2391, {@link drainLeaseStatus}). HELD (a live drain watch is
 *      already running) ⇒ NO-OP: the item is already enqueued and the running watch will collect it on its
 *      next poll. This is the fast, common no-spawn path.
 *   2. FREE (or a stale/reclaimable lease) ⇒ fire ONE **detached, self-terminating** drain watch:
 *      `merge-ai-prs --label=ready-to-merge --watch --until-batches-idle --hold-drain-lease --max-runtime-min=N`.
 *      (Since #2449 the lease is ALWAYS-ON for watches — `--hold-drain-lease` is a kept-for-clarity no-op
 *      alias. With the #2449 resident drain daemon installed, step 1 sees ITS lease held and this launcher
 *      no-ops permanently — retired by construction, kept as the daemon-absent fallback.)
 *      The child ACQUIRES the lease itself (the atomic O_EXCL race winner), so if two
 *      closes both saw FREE and both fired, exactly one child wins the lease and drains — the other no-ops.
 *      The lease is thus the honest "a drain is running" signal a later close reads at step 1.
 *
 * DETACHMENT (true, per-platform): spawned with `detached: true` (Node calls `setsid`, a new session leader),
 * `stdio` redirected to a durable log file, and `.unref()` so the parent (the closing session) exits without
 * waiting. No `nohup` needed — `detached + unref + fd-backed stdio` is the portable equivalent on darwin/linux.
 *
 * BOUNDED LIFETIME: the child carries `--max-runtime-min` (a wall-clock cap) so an `--until-batches-idle` watch
 * that finds NO batch feed (INERT ⇒ would poll forever) still terminates. Its natural exit is batch-idle; the
 * cap is the backstop. Correctness holds if the cap fires mid-flight: unlanded PRs ride the next drain.
 *
 * Usage:
 *   node scripts/drain-push-at-close.mjs                 # fire a detached drain iff the lease is free (else no-op)
 *   node scripts/drain-push-at-close.mjs --dry-run       # report the fire/no-op decision, spawn NOTHING
 *   node scripts/drain-push-at-close.mjs --json          # machine-readable result
 *   node scripts/drain-push-at-close.mjs --max-runtime-min=90 --interval=45
 *
 * Flags:
 *   --repo=<path>            the primary checkout to drain from (default: the cwd's git toplevel — where main
 *                            lands and the active-progress feed lives; NEVER a lane clone)
 *   --interval=<sec>         watch poll interval handed to the drain (default 30)
 *   --max-runtime-min=<min>  wall-clock lifetime cap on the detached drain (default 60)
 *   --dry-run                decide + report, but spawn nothing
 *   --json                   emit a JSON result object
 *
 * Exit codes: 0 = fired a drain OR intentionally no-op'd (both are success); 3 = could not spawn.
 */
import { spawn } from 'node:child_process';
import { readGit } from './lib/proc-read.mjs';
import { openSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drainLeaseStatus, DRAIN_LOCK_ROOT, localRepoSlug } from './readiness/drain-lock.mjs'; // #3440 — localRepoSlug keys the lease check per-repo
import { writeAllSync } from './lib/write-all-sync.mjs';

// ── pure decision + arg building (unit-tested; no side effects) ───────────────────────────────────────

/**
 * Should a closing batch FIRE a detached drain, or only enqueue? Pure (#2395).
 *   • lease HELD (a live watch is draining) ⇒ `{ fire: false, reason: 'drain-in-flight' }` — the running watch
 *     collects the just-enqueued PR; firing a second drain would be redundant.
 *   • lease FREE / STALE (no live watch) ⇒ `{ fire: true }` — nothing is draining, so push the handoff.
 * The decision is ADVISORY (a fast no-spawn path): the real "exactly one" guarantee is the fired child's own
 * `acquireDrainLease` (the atomic race winner). So a stale lease still fires — the child reclaims it.
 * @param {{held:boolean, stale:boolean, owner:string|null}} leaseStatus
 * @returns {{fire:boolean, reason:string, heldBy:string|null}}
 */
export function decidePushAtClose(leaseStatus = { held: false, stale: false, owner: null }) {
  if (leaseStatus.held) return { fire: false, reason: 'drain-in-flight', heldBy: leaseStatus.owner };
  return { fire: true, reason: leaseStatus.stale ? 'stale-lease-reclaim' : 'no-drain-running', heldBy: null };
}

/**
 * Build the argv for the detached drain child (pure). The self-terminating, lease-holding, wall-clock-capped
 * push-at-close drain over `scripts/merge-ai-prs.mjs`.
 * @returns {string[]} argv AFTER the node script path
 */
export function buildDrainArgs({ label = 'ready-to-merge', intervalSec = 30, maxRuntimeMin = 60, batchFeed = null } = {}) {
  const a = [`--label=${label}`, '--watch', '--until-batches-idle', '--hold-drain-lease'];
  if (Number.isFinite(Number(intervalSec)) && Number(intervalSec) > 0) a.push(`--interval=${intervalSec}`);
  if (Number.isFinite(Number(maxRuntimeMin)) && Number(maxRuntimeMin) > 0) a.push(`--max-runtime-min=${maxRuntimeMin}`);
  if (batchFeed) a.push(`--batch-feed=${batchFeed}`);
  return a;
}

// ── the launcher (impure shell; `spawn`/`now`/`openLog` injected for tests) ────────────────────────────

/**
 * Run the push-at-close decision and, when it fires, spawn the detached drain. Impure boundaries are injected so
 * a test can assert the decision + the spawn options (detached/unref/argv) without a real drain running.
 * @returns {{fired:boolean, reason:string, heldBy?:string|null, pid?:number, log?:string, argv?:string[]}}
 */
export function runPushAtClose({
  repo,
  lockRoot = DRAIN_LOCK_ROOT,
  drainScript,
  intervalSec = 30,
  maxRuntimeMin = 60,
  batchFeed = null,
  dryRun = false,
  now = Date.now,
  spawnFn = spawn,
  openLog = defaultOpenLog,
  repoKey = null, // #3440 — the fast-path lease check below must read the SAME per-repo lock dir the fired child will acquire
} = {}) {
  const status = drainLeaseStatus(lockRoot, { nowMs: now(), repoKey });
  const decision = decidePushAtClose(status);
  if (!decision.fire) return { fired: false, reason: decision.reason, heldBy: decision.heldBy };

  const argv = buildDrainArgs({ intervalSec, maxRuntimeMin, batchFeed });
  if (dryRun) return { fired: false, reason: 'dry-run', wouldFire: true, argv, drainScript };

  const log = openLog();
  const child = spawnFn('node', [drainScript, ...argv], {
    cwd: repo,
    detached: true,                       // new session leader (setsid) — survives the parent's exit
    stdio: ['ignore', log.fd, log.fd],    // fd-backed so output persists after the parent closes
  });
  child.unref();                          // let the closing session exit without awaiting the drain
  return { fired: true, reason: decision.reason, pid: child.pid, log: log.path, argv };
}

/** Durable, machine-local, discoverable log home for the detached drain — colocated with the lease it holds
 *  (~/.claude), never inside the lock root (file-locks scans that). Appended, best-effort. */
function defaultOpenLog() {
  const dir = join(homedir(), '.claude', 'logs');
  try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
  const path = join(dir, 'drain-push-at-close.log');
  return { path, fd: openSync(path, 'a') };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────────
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const flags = {};
  for (const a of process.argv.slice(2)) { const m = a.match(/^--([^=]+)(?:=(.*))?$/); if (m) flags[m[1]] = m[2] === undefined ? true : m[2]; }
  const AS_JSON = !!flags.json;
  const DRY_RUN = !!flags['dry-run'];
  const expandHome = (p) => (p && p.startsWith('~') ? join(homedir(), p.slice(1)) : p);
  // Resolve the PRIMARY checkout to drain from (never a lane clone): the cwd's git toplevel by default.
  let repo;
  try { repo = resolve(expandHome(flags.repo) || readGit(['rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8' }).trim()); }
  catch { repo = resolve(expandHome(flags.repo) || process.cwd()); }
  const drainScript = join(repo, 'scripts', 'merge-ai-prs.mjs');
  // Point the batch feed at the primary's copy so `--until-batches-idle` is not silently inert (#2330).
  const batchFeed = join(repo, '_site', 'active-progress.json');
  const intervalSec = Number.isFinite(Number(flags.interval)) && Number(flags.interval) > 0 ? Number(flags.interval) : 30;
  const maxRuntimeMin = Number.isFinite(Number(flags['max-runtime-min'])) && Number(flags['max-runtime-min']) > 0 ? Number(flags['max-runtime-min']) : 60;

  let result;
  try {
    result = runPushAtClose({ repo, drainScript, intervalSec, maxRuntimeMin, batchFeed, dryRun: DRY_RUN, repoKey: localRepoSlug({ cwd: repo }) });
  } catch (e) {
    result = { fired: false, reason: 'spawn-failed', detail: String((e && e.message) || e).split('\n')[0] };
    if (AS_JSON) writeAllSync(1, JSON.stringify(result) + '\n');
    else process.stderr.write(`drain-push-at-close ✗ could not fire a drain: ${result.detail}\n`);
    process.exit(3);
  }

  if (AS_JSON) writeAllSync(1, JSON.stringify(result) + '\n');
  else if (result.fired) process.stderr.write(`drain-push-at-close ✓ fired a detached drain (pid ${result.pid}, log ${result.log}) — lands the chain, self-terminates.\n`);
  else if (result.wouldFire) process.stderr.write(`drain-push-at-close · dry-run: WOULD fire a detached drain (${result.argv.join(' ')}).\n`);
  else process.stderr.write(`drain-push-at-close · no-op (${result.reason}${result.heldBy ? `, held by ${result.heldBy}` : ''}) — item is enqueued; the running drain will collect it.\n`);
  process.exit(0);
}
