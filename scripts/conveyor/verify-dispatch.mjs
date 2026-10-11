#!/usr/bin/env node
/**
 * @file scripts/conveyor/verify-dispatch.mjs
 * @description The CONVEYOR VERIFY DISPATCH pass (#3105). Picks up a lane's `request`-stamped `.lane-verify`
 *   marker (`scripts/verify-lane.mjs request`) and runs the gate ITSELF, as the runner's own long-lived
 *   process — never inside an interactive agent's own Bash call, which is exactly what #3105 found cannot
 *   finish inside the tool's ~120s foreground window once the gate legitimately takes 150–350s.
 *
 * 2026-10-05 hung-gate incident: daemon ticks no longer await gate settlement. A shared in-flight
 * registry bounds outstanding runs and prevents repeat dispatch across ticks; CLI calls still await.
 * Marker detection precedes tail truncation so chatty gates cannot escape the gate-phase ceiling.
 *
 * Historical blocking/concurrent-dispatch rationale follows; the daemon now uses the registry above.
 * WHY THIS IS SAFE TO RUN BLOCKING, HERE, WHEN IT WAS NOT SAFE ON THE AGENT'S OWN TURN. The 120s ceiling is a
 * property of the interactive agent tool's own foreground command window — it does not apply to a subprocess
 * this file spawns from `skills-src/conveyor/runner.mjs`'s own already-running, singleton-locked, supervised
 * process (`runner-lock.mjs` + `supervisor.mjs`). Running the gate to completion here simply makes ONE tick
 * take longer; nothing here is bound by a per-turn window.
 *
 * NO NEW MARKER VOCABULARY. A `request`-stamped marker is byte-identical in shape to an ordinary in-flight
 * `running` one — {@link ../lib/lane-verify.mjs}'s `verifyGateDecision` already treats it correctly (refused,
 * "unfinished") with zero changes. This file only decides WHEN to act on one: a lane whose marker is `running`
 * for its OWN current HEAD sha, and re-runs `verify-lane.mjs`'s own `verify` mode UNCHANGED — the exact
 * "re-verifying is legitimate" path the marker's own start-write guard already sanctions (including the
 * recovery case where a prior runner process died mid-run, stranding the marker: the next tick's dispatch just
 * re-runs it, same as a human would).
 *
 * OFFERS EVERY PENDING LANE TO THE ADMISSION SEMAPHORE AT ONCE — THIS FILE DOES NOT ITSELF BOUND CONCURRENCY
 * (#4360). Earlier revisions of this file `await`ed each lane's `spawnGateBounded` call before starting the
 * next one, which serialized every dispatch to ONE lane at a time even though `heavy-admission.mjs`'s own cap
 * (2 heavy + 1 fast by default) already lets that many gates run at once safely. The fix is entirely in this
 * file's own loop: collect every pending lane's `spawnGateBounded` promise WITHOUT awaiting between them, then
 * `Promise.allSettled` them together (never `Promise.all` — one lane's timeout/non-zero exit must never sink
 * another lane's `dispatched`/`failures` bookkeeping). NO NEW ADMISSION LOGIC LIVES HERE, BY DESIGN (card
 * #4360's own corrected plan, argued at length there): `verify-lane.mjs`'s own `acquireSlotBlocking` call
 * remains the SOLE chokepoint (see the comment at that call site) — this file must NEVER also acquire a slot
 * itself before spawning, which would either double-admit (two slots consumed per lane) or stall a child
 * behind a slot its own parent holds. What actually bounds REAL CONCURRENT GATE EXECUTION at the cap is each
 * spawned child's own wait on that ONE shared semaphore — this loop merely stops artificially limiting itself
 * to offering one candidate at a time; it names no cap and enforces none.
 *
 * TWO REAL BEHAVIORAL DELTAS FROM THE OLD SERIAL LOOP, STATED PLAINLY RATHER THAN GLOSSED OVER:
 *   (a) `acquireSlotBlocking` FAILS OPEN on its own queuing timeout (`heavy-admission.mjs`'s own documented
 *       residual-risk tradeoff, unchanged by this file) — a lane that waits that long proceeds UNSLOTTED. With
 *       several lanes now offered at once instead of one, a backlog larger than the cap makes that fail-open
 *       path reachable in a way the old serial loop's near-always-empty queue rarely hit; when it fires, more
 *       gates run concurrently than the cap names.
 *   (b) each pending lane's OWN `QUEUE_PHASE_CEILING_MS` timer (below) now starts AT SPAWN — i.e. ALL of them
 *       at once — rather than one at a time the way the old serial loop gave each lane a fresh, uncontended
 *       queue budget. A lane queued behind the cap now spends real time waiting on siblings' admission before
 *       its own gate starts, counted against ITS OWN ceiling from the moment this loop offered it; if that wait
 *       outlasts the ceiling, the lane is killed with `timedOutPhase:'queue'` and recorded as an infrastructure failure — new
 *       contention the serial loop never created for itself, though `QUEUE_PHASE_CEILING_MS` is set well above
 *       `heavy-admission.mjs`'s own hard give-up ceiling specifically so a lane that is merely queued, not
 *       stuck, is not expected to trip it in the ordinary case.
 * THE RUNNER IS STILL A SINGLETON (only one live daemon dispatches at all, #3878's runner-lock lease) and a
 * single sweep still walks each lane AT MOST ONCE (`laneIndicesIn` never repeats a directory), so no same-lane
 * double-dispatch is possible — there is no per-lane lock to add, only this invariant to keep true. Concurrent
 * lanes still contend for host CPU exactly as directly-run `npm run test:unit` calls always have (#3372 already
 * shrinks the common case); this file changes how MANY gates it may OFFER to the semaphore at once, not how
 * many the semaphore actually admits, and not how expensive any one of them is.
 *
 * CORRECTION (#3878, epic #3383). The paragraph above states the intended safety property, but confirmed by
 * direct read (grep over `we:skills-src/conveyor/runner.mjs` turns up zero references to this file), this
 * script was NEVER actually wired into that runner's own `makeCliMechanicalPasses` list on `main` — there is
 * no `mechanicalPasses` entry for it to be "dropped" once a standalone daemon exists, contrary to what this
 * file's own header (and #3878's own card digest, copying it) implied. So "the runner is a SINGLETON" was, at
 * best, a borrowed, code-unenforced assumption about however else this file happened to be invoked — never a
 * property THIS file held. #3878 closes that gap for real: `we:skills-src/conveyor/verify-daemon.mjs` now
 * wraps {@link runVerifyDispatch} (below) as a standalone daemon that takes its OWN keyed
 * `we:skills-src/conveyor/runner-lock.mjs` lease (`<conveyor:verify-daemon-lease>`) before ticking it, so at
 * most one live copy of that daemon ever dispatches a gate run at a time — independent of whatever else may
 * invoke this file directly (a human running the CLI by hand, say), which carries the same standing,
 * unchanged risk it always has.
 *
 * A HARD WALL-CLOCK CEILING, NOT JUST A DOCUMENTED ONE (epic #3383, live incident 2026-09-14). The gate's
 * documented normal range is 150-350s; before this, nothing here bounded it — a single genuinely-stuck (or
 * merely starved, under heavy concurrent-lane contention) gate blocked EVERY lane's dispatch indefinitely,
 * because this pass is synchronous and one request is handled to completion before the next is even looked
 * at. `VERIFY_DISPATCH_TIMEOUT_MS` (default 30 minutes — several multiples of the documented ceiling, chosen
 * generously so a legitimately slow run under contention is never killed for being merely slow — the live
 * incident's own gate finished on its own at ~19-20 minutes under heavy contention, which is why the cap is
 * NOT tucked in near the 15-20 minute range) bounds that wait. On timeout the WHOLE process tree is killed,
 * not just the immediate child: `verify-lane.mjs` itself `execSync`s the gate command through a shell, so the
 * actual test runner is a grandchild that would never see a signal sent only to its parent — spawning the
 * dispatch with `detached: true` puts that whole tree in one process group up front, so the timeout handler
 * can kill the group as a unit. The tick then moves on, counting the lane as a dispatch failure. The dispatcher records a terminal
 * infrastructure failure for the still-owned marker. A killed run requires diagnosis and an explicit retry;
 * it must never silently cycle through full execution budgets on successive ticks.
 *
 * TWO SEPARATE CEILINGS, NOT ONE (Skeptic-review fix, 2026-09-14, same epic). The FIRST cut of the ceiling
 * above measured wall-clock time from the moment this file SPAWNS `verify-lane.mjs` — which is BEFORE that
 * child even tries to acquire its own `heavy-admission.mjs` capacity slot, not after. `heavy-admission.mjs`'s
 * admission wait lets a spawned verify legitimately spend real time just WAITING for a free admission slot
 * before its actual gate work starts — real queuing, not a hang. A single 30-minute ceiling measured from
 * spawn therefore conflates "queued a while then ran a normal 5-minute gate" (healthy) with "queued a while
 * then ran a genuinely-stuck gate" (also healthy-looking until it blows past 30) — and worse, a HEALTHY run
 * that queues and then hits the very contention this ceiling was built to survive (the live incident's own
 * ~19-20 minute gate) could total more than 30 minutes and get killed anyway, defeating the ceiling's own
 * stated purpose of distinguishing hung from merely-queued. The fix: measure GATE time only. `verify-lane.mjs`
 * now writes an UNCONDITIONAL marker line to its own stderr ({@link GATE_STARTED_MARKER}) the instant before
 * it runs the real gate command — after admission, win or fail-open, every time. This file watches the
 * child's stderr as it streams (a `spawn`, not the old blocking `execFileSync`) and runs TWO SEPARATE timers,
 * never stacked: `QUEUE_PHASE_CEILING_MS` from spawn until the marker appears — a safety net barely above
 * `heavy-admission.mjs`'s own hard give-up ceiling (xhlriy2, #3383: {@link resolveCeilingMs}, 120 minutes by
 * default — NOT the vestigial 20-minute `resolveTimeoutMs`/`DEFAULT_TIMEOUT_MS`, which no longer bounds how
 * long `acquireSlotBlocking` legitimately waits while a slot holder is alive), since that ceiling already
 * bounds a HEALTHY wait; this one only fires on a hang BEFORE admission is even reached, or a dropped marker
 * write — and `VERIFY_DISPATCH_TIMEOUT_MS` (unchanged, 30 minutes, same generous multiple of the documented
 * 150-350s range) from the marker until the gate itself finishes. Seeing the marker CANCELS the queue timer
 * and starts a fresh gate timer — it does not extend or add to the queue one. On EITHER timeout the whole
 * process-group kill above still applies unchanged.
 *
 * LATER-PHASE WAITS (#verify-phase-admission). Per-phase admission makes the child queue AGAIN after the first
 * marker (scan / standards / retry slots). It brackets each such wait with a `⏳ {@link GATE_QUEUED_MARKER}` line
 * and a repeat of the `⏱ {@link GATE_STARTED_MARKER}` line: the first pauses the gate budget (what is left of it
 * is kept) and runs the queue ceiling, the second resumes the gate timer with that remainder. A healthy wait is
 * never charged as hung gate time, a hung wait is still bounded, and total real gate time is still capped.
 *
 * PURE-CORE / IO-SHELL SPLIT (mirrors lease-reaper.mjs): {@link laneNeedsVerifyDispatch} is pure (no fs/git);
 * the IO shell owns the POOL_ROOT walk, marker reads, the `git rev-parse HEAD` per lane, and the actual
 * `verify-lane.mjs` spawn. {@link runVerifyDispatch} is that whole IO-shell sweep, exported and exit-free (it
 * never calls `process.exit`) — the same "export the sweep, let the CLI own exit/format" shape
 * `we:scripts/conveyor/reconcile-fix-dispatch.mjs#runReconcileFixDispatch` already established, which is what
 * lets #3878's standalone `we:skills-src/conveyor/verify-daemon.mjs` tick it directly. `main()` below is now a
 * thin CLI shell over it.
 */
import { readGit } from '../lib/proc-read.mjs';
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync, openSync, closeSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import { readVerifyMarker, VERIFY_FILENAME, verifyFinishBody, verificationInfrastructureFailure, VERIFY_MARKER_NONCE_ENV, markerNonceSuffix } from '../lib/lane-verify.mjs';
import { writeAllSync } from '../lib/write-all-sync.mjs';
import { resolveCeilingMs as resolveAdmissionCeilingMs } from '../readiness/heavy-admission.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
import { branchMatchesQueueIds, isQueueScopeEnabled, readScopedQueueIds } from './queue-scope.mjs';
import { loadVerifySettingsFile, resolveVerifySettings } from '../lib/verify-settings.mjs';

/** Several multiples of the gate's documented 150-350s normal range — generous on purpose (see file header):
 *  a slow-but-healthy GATE run under contention must never be mistaken for a stuck one. Applies ONLY to the
 *  post-{@link GATE_STARTED_MARKER} phase — see {@link spawnGateBounded}. Overridable so tests don't need to
 *  wait 30 real minutes to prove the mechanism. */
const DEFAULT_VERIFY_DISPATCH_TIMEOUT_MS = 30 * 60 * 1000;
const VERIFY_DISPATCH_TIMEOUT_MS =
  Number(process.env.VERIFY_DISPATCH_TIMEOUT_MS) > 0
    ? Number(process.env.VERIFY_DISPATCH_TIMEOUT_MS)
    : DEFAULT_VERIFY_DISPATCH_TIMEOUT_MS;

/** The literal marker `verify-lane.mjs` writes to its OWN stderr the instant before it runs the real gate
 *  command (see that file's call site) — the ONE signal this file needs to tell "still queuing" from "gate
 *  work has actually started," without inventing a second, parallel marker vocabulary. */
export const GATE_STARTED_MARKER = 'gate execution starting';

/** Per-phase admission (#verify-phase-admission) makes the child queue AGAIN after {@link GATE_STARTED_MARKER}
 *  (scan / standards / retry phases). It writes this line before each such wait and re-writes the started line
 *  once the slot is held, so the dispatcher can pause the gate budget while the child is merely queued instead of
 *  counting the wait as hung gate time. Only line-anchored occurrences ending with the per-run nonce suffix (#5189) count after the first started marker, so
 *  gate output that merely mentions the text can never move a timer. */
export const GATE_QUEUED_MARKER = 'gate queueing for admission';

/** The PRE-marker (queuing) ceiling — a safety net, not the primary defense against a stuck queue wait. The
 *  real ceiling on legitimate queuing is `heavy-admission.mjs`'s own hard give-up ceiling (xhlriy2, #3383:
 *  `DEFAULT_ADMISSION_CEILING_MS` / `WE_HEAVY_ADMISSION_CEILING_MS`, 120 minutes by default) — NOT the
 *  vestigial `DEFAULT_TIMEOUT_MS` / `WE_HEAVY_ADMISSION_TIMEOUT_MS` (20 minutes), which no longer decides when
 *  `acquireSlotBlocking` gives up: a waiter now keeps polling for as long as a slot holder is provably alive,
 *  so a HEALTHY queuing wait can legitimately run all the way to the 120-minute ceiling before
 *  `acquireSlotBlocking` FAILS OPEN and `verify-lane.mjs` proceeds unslotted, logging one of its two admission
 *  lines and then — unconditionally, win or fail-open — {@link GATE_STARTED_MARKER}. So a HEALTHY run's
 *  pre-marker phase can never legitimately exceed that same ~120-minute figure. `QUEUE_PHASE_BUFFER_MS` on top
 *  of it covers overhead OUTSIDE the admission wait itself (the lane's own `git` calls, marker read/write,
 *  gate resolution) plus scheduling slack — this ceiling exists to catch a hang BEFORE `verify-lane.mjs` ever
 *  reaches admission (or a bug that silently drops the marker write), not to re-bound the admission wait a
 *  second time. Derived from the SAME env `verify-lane.mjs`'s own admission wait resolves from
 *  (`resolveAdmissionCeilingMs`), so tuning `WE_HEAVY_ADMISSION_CEILING_MS` keeps this safety net correctly
 *  proportioned automatically. Overridable independently via `VERIFY_DISPATCH_QUEUE_CEILING_MS`, so a test can
 *  shrink either phase without touching the other. */
const QUEUE_PHASE_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_QUEUE_PHASE_CEILING_MS = resolveAdmissionCeilingMs(process.env) + QUEUE_PHASE_BUFFER_MS;
const QUEUE_PHASE_CEILING_MS =
  Number(process.env.VERIFY_DISPATCH_QUEUE_CEILING_MS) > 0
    ? Number(process.env.VERIFY_DISPATCH_QUEUE_CEILING_MS)
    : DEFAULT_QUEUE_PHASE_CEILING_MS;

// ── PURE CORE (no fs / git / clock) ─────────────────────────────────────────────────────────────────────────

/**
 * Should this lane's gate be run NOW? Pure. A dispatch fires on exactly one shape: the marker is `running`
 * (whether freshly `request`-stamped or stranded from a dead prior run — both recover the same way) AND its
 * `sha` matches the lane's OWN current HEAD. Anything else — no marker, a terminal `green`/`red`/`corrupt`
 * record, or a `running` record for a sha that is no longer HEAD (nobody has asked to verify the new one) —
 * is left alone; dispatch only ever reacts to an explicit ask, never re-verifies a lane on its own initiative.
 * @param {{status?:string, sha?:string, corrupt?:boolean}|null} marker
 * @param {string|null} headSha
 * @returns {boolean}
 */
export function laneNeedsVerifyDispatch(marker, headSha) {
  if (!marker || marker.corrupt || !headSha) return false;
  return marker.status === 'running' && marker.sha === headSha;
}

/**
 * Is this lane in scope for THIS checkout? Pure, and the ONE place this pass's own cross-instance leak is
 * closed (epic #3383).
 *
 * A DIFFERENT LEAK AXIS FROM THE PR PASSES, WORTH STATING PLAINLY. The three `gh pr list` watches and
 * `reconcile-pass.mjs` leak across the whole REPOSITORY. This pass never touches `gh` at all — it walks the
 * HOST-WIDE lane pool (`LANE_POOL_ROOT`, default `~/workspace/.lanes`), so a deliberately-scoped scratch
 * instance would happily run a full `verify-lane.mjs` gate for a lane belonging to a completely different
 * conveyor instance on the same machine. Same class of "an isolated instance is not actually isolated" bug,
 * reached through the filesystem rather than through GitHub.
 *
 * DEFAULT OFF, exactly like the PR passes: `enabled: false` ⇒ `true` for every lane, i.e. today's behavior to
 * the byte. Scoped ⇒ the lane's own branch must name a queued item. A lane with NO readable branch (a detached
 * HEAD, an unreadable checkout) is OUT of scope when scoping is on — the safe direction here, since the whole
 * point of a scoped instance is to touch only what it can positively identify as its own.
 * @param {string|null} branch the lane's current branch (`git -C <laneDir> rev-parse --abbrev-ref HEAD`)
 * @param {{enabled?:boolean, ids?:string[]}} [scope]
 * @returns {boolean}
 */
export function laneInQueueScope(branch, { enabled = false, ids = [] } = {}) {
  if (!enabled) return true;
  return branchMatchesQueueIds(branch, ids);
}

/** Resolve the cap on outstanding dispatches (admission still owns execution capacity).
 * @param {Record<string, string|undefined>} env
 * @returns {number}
 */
export function resolveMaxInFlight(env) {
  const value = Number(env.VERIFY_DISPATCH_MAX_IN_FLIGHT);
  return Number.isInteger(value) && value > 0 ? value : 8;
}

/** #65 — is a re-stamped marker the SAME request this in-flight run already serves: same sha, same gate command,
 *  and the same (known) working-tree hash? An agent that re-runs `verify-lane request` after a wait timeout does
 *  exactly this; the running gate already answers it, so killing it only throws away minutes of gate work.
 * @param {{sha?:string, suites?:string, treeHash?:string|null}} entry
 * @param {{sha?:string, suites?:string, treeHash?:string|null}} marker
 * @returns {boolean}
 */
export function sameVerifyRequest(entry, marker) {
  return !!entry?.sha && entry.sha === marker?.sha && entry.suites === marker?.suites
    && entry.treeHash != null && entry.treeHash === marker?.treeHash;
}

/** Whether a pending marker belongs to a different request than this in-flight run AND that request may kill it,
 *  per the declared `supersede` setting (#65): `newer` (default) kills only for a different sha, gate or tree —
 *  never an identical re-request; `never` kills nothing; `any` is the old behaviour (every re-stamp kills).
 * @param {{runId:string, requestStartedAt:string|null, sha?:string, suites?:string, treeHash?:string|null}} entry
 * @param {object|null} marker
 * @param {string|null} headSha
 * @param {'newer'|'never'|'any'} [policy]
 * @returns {boolean}
 */
export function inFlightSuperseded(entry, marker, headSha, policy = 'newer') {
  const differentRequest = laneNeedsVerifyDispatch(marker, headSha)
    && marker.runId !== entry.runId && marker.startedAt !== entry.requestStartedAt;
  if (!differentRequest || policy === 'never') return false;
  return policy === 'any' || !sameVerifyRequest(entry, marker);
}

/** The declared `supersede` setting (env `WE_VERIFY_SUPERSEDE` over the running checkout's settings file). */
export function resolveSupersedePolicy(env = process.env, fileConfig = loadVerifySettingsFile()) {
  return resolveVerifySettings({ fileConfig, env }).values.supersede;
}

// ── IO SHELL (runs only as a CLI) ───────────────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFY_LANE_CLI = join(HERE, '..', 'verify-lane.mjs');
const expandHome = (p) => (p && p.startsWith('~') ? join(homedir(), p.slice(1)) : p);
const POOL_ROOT = expandHome(process.env.LANE_POOL_ROOT) || join(homedir(), 'workspace', '.lanes');

const log = (m) => process.stderr.write(m + '\n');

/** Lane indices under a pool dir (`lane-N` children), sorted — mirrors lane-pool's own `laneIndicesIn`. */
export function laneIndicesIn(poolDir) {
  if (!existsSync(poolDir)) return [];
  // A plain FILE beside the pools (macOS's `.metadata_never_index` Spotlight marker, a stray `.DS_Store`) is
  // not a pool: `readdirSync` on it throws ENOTDIR, and that one throw used to fail the WHOLE tick, every
  // tick — no gate ran host-wide for hours (2026-10-04 incident). A non-directory holds no lanes; skip it.
  let names;
  try { names = readdirSync(poolDir); } catch (e) { if (e?.code === 'ENOTDIR') return []; throw e; }
  return names
    .filter((d) => /^lane-\d+$/.test(d))
    .map((d) => Number(d.slice(5)))
    .sort((a, b) => a - b);
}

/** Pool names under `poolRoot` that hold lanes — mirrors lease-reaper.mjs's `poolsToScan` (no `--pool` filter
 *  here: unlike the reaper, a delivery agent may request verification from any pool this runner drives).
 *  Defaults to the module-level {@link POOL_ROOT}; a caller only ever overrides it in a test (#4360), never in
 *  production. */
function poolsToScan(poolRoot = POOL_ROOT) {
  if (!existsSync(poolRoot)) return [];
  return readdirSync(poolRoot)
    .filter((name) => laneIndicesIn(join(poolRoot, name)).length > 0)
    .sort();
}

function tryGit(args, cwd) {
  try {
    // #x5n4zn3 — was bare (no timeout). This file's own main `verify-lane.mjs` spawn already has its own
    // dedicated two-phase queue/gate timeout (see file header) — deliberately untouched here — but this SEPARATE
    // small git helper (pool-scan / marker reads) had none at all.
    return readGit(args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' }).trim();
  } catch {
    return null;
  }
}

/** #65 — where a dispatched child's stderr is written (next to the marker, overwritten per run). */
export const DISPATCH_LOG_FILENAME = '.lane-verify.dispatch.log';
function dispatchLogPath(laneDir) {
  const gitDir = tryGit(['rev-parse', '--absolute-git-dir'], laneDir) || join(laneDir, '.git');
  return join(gitDir, DISPATCH_LOG_FILENAME);
}

/** Read a lane's `.lane-verify` marker via the real (possibly worktree-relocated) git dir — mirrors
 *  `verify-lane.mjs`'s own resolution, never a hardcoded `join(dir, '.git', …)` (that throws in a worktree). */
function markerFor(laneDir) {
  const gitDir = tryGit(['rev-parse', '--absolute-git-dir'], laneDir) || join(laneDir, '.git');
  return readVerifyMarker(gitDir);
}

/** Is the on-disk `running` marker still the request THIS dispatch owns? With a `runId` (the dispatcher always
 *  passes one) ownership is exact even before the gate started — when `startedAt` is still unknown, which is the
 *  queue-phase kill: the marker is ours only if our child stamped it (`runId` matches) or the child never got to
 *  restamp and it is still byte-for-byte the request we observed (`requestStartedAt`). A newer same-sha/suites/
 *  tree request has neither, so it is left alone. Without a `runId` (a caller that predates it) the old
 *  `startedAt` comparison applies. */
function ownsMarker(current, expected) {
  if (expected.runId) {
    if (current.runId === expected.runId) return true;
    return !current.runId && !!expected.requestStartedAt && current.startedAt === expected.requestStartedAt;
  }
  return !expected.startedAt || current.startedAt === expected.startedAt;
}

/** A killed child cannot write its result. Settle only the still-owned request; never requeue it silently. */
export function recordKilledVerification(dir, expected, error, ceilingMs) {
  const infrastructure = verificationInfrastructureFailure({ exitCode: error?.status, signal: error?.signal,
    timedOutPhase: error?.timedOutPhase, ceilingMs });
  if (!infrastructure) return;
  const gitDir = tryGit(['rev-parse', '--absolute-git-dir'], dir) || join(dir, '.git');
  const current = readVerifyMarker(gitDir);
  if (!current || current.status !== 'running') return;
  // A marker bearing OUR runId was stamped by our own child, so it is ours whatever tree/sha that child captured at
  // its start (the agent may have edited the tree after `request`). Anything else must still match, field for
  // field, the request we observed — and settle under that request's sha.
  const ours = !!expected.runId && current.runId === expected.runId;
  if (!ours && (current.sha !== expected.sha || current.suites !== expected.suites
      || current.treeHash !== expected.treeHash || !ownsMarker(current, expected))) return;
  const finished = verifyFinishBody(current, { sha: ours ? current.sha : expected.sha, exitCode: error?.status,
    infrastructure, finishedAt: new Date().toISOString(), treeHash: null });
  const path = join(gitDir, VERIFY_FILENAME);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(finished, null, 2) + '\n');
  renameSync(tmp, path);
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

/**
 * Run `node <args…>` (the `verify-lane.mjs` spawn), bounded by TWO SEPARATE wall-clock ceilings instead of
 * one blanket one (the fix this exports — see the file header's "TWO SEPARATE CEILINGS" section):
 * `queueCeilingMs` covers everything BEFORE the child logs {@link GATE_STARTED_MARKER} to its own stderr;
 * `gateCeilingMs` covers everything AFTER. Whichever ceiling is ACTIVE is whichever phase the child is really
 * in — seeing the marker CANCELS the queue-phase timer and starts a FRESH gate-phase one; it never stacks or
 * extends them. `detached: true` mirrors the old `execFileSync` behavior exactly: the whole spawned tree gets
 * its own process group so a timeout kill reaches `verify-lane.mjs` → its own `execSync`'d shell → the real
 * test runner as a unit, never orphaning the grandchild (the same failure mode the original ceiling PR fixed).
 * @param {string[]} args        argv for `node` (the target script path first, mirrors `execFileSync`'s usage)
 * @param {{queueCeilingMs:number, gateCeilingMs:number, onGateStarted?:() => void, onSpawn?:(pid:number) => void}} ceilings `onGateStarted`
 *   (#4360) fires exactly once, synchronously, the instant {@link GATE_STARTED_MARKER} is seen — the caller's
 *   one hook for recording a real per-lane gate-start timestamp (the live proof this card's Proof plan needs),
 *   never used to alter timing or control flow here. A throwing callback is swallowed — a logging hook must
 *   never be able to break the gate run it is only observing. `onSpawn` fires once immediately after spawn.
 * @returns {Promise<{pid:number}>} resolves on a clean (possibly non-zero, non-timeout) exit
 * @throws {Error & {status:number|null, signal:string|null, pid:number, timedOutPhase?:'queue'|'gate'}}
 *   shaped like `execFileSync`'s own timeout/non-zero errors, plus `timedOutPhase` so the caller can log which
 *   ceiling actually fired.
 */
export function spawnGateBounded(args, { queueCeilingMs, gateCeilingMs, onGateStarted, onSpawn, logPath, onNotice, tailIntervalMs = 250 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    // #65 — with `logPath`, stderr is a FILE the child owns (stdout is discarded, as before) and is tailed here,
    // so the gate never depends on this process staying alive to read a pipe: a restarted daemon can adopt it.
    let logFd = null;
    if (logPath) {
      try { logFd = openSync(logPath, 'w'); } catch { logFd = null; }
    }
    // #5189 — fresh per run: only a later marker line ending with this run's suffix may move a timer.
    const nonce = randomBytes(16).toString('hex');
    const nonceSuffix = markerNonceSuffix(nonce);
    const child = spawn('node', args, { stdio: logFd != null ? ['ignore', 'ignore', logFd] : ['ignore', 'pipe', 'pipe'], detached: true,
      env: { ...process.env, [VERIFY_MARKER_NONCE_ENV]: nonce } });
    if (logFd != null) { try { closeSync(logFd); } catch {} }
    // Observer hooks cannot interfere with process supervision.
    try { onSpawn?.(child.pid); } catch {}
    let stderrTail = '';
    let markerSeen = false;
    let timedOutPhase = null;

    const onTimeout = (phase) => () => {
      timedOutPhase = phase;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone — fine, that's the goal.
      }
    };
    let timer = setTimeout(onTimeout('queue'), queueCeilingMs);
    // After the first marker: the gate budget left while the child re-queues for a later phase's slot, and the
    // partial trailing line carried between chunks (only complete lines can be a line-anchored marker).
    let gateBudgetMs = gateCeilingMs;
    let gateResumedAt = 0;
    let requeueing = false;
    let lineCarry = '';

    const armGate = () => {
      clearTimeout(timer);
      gateResumedAt = Date.now();
      timer = setTimeout(onTimeout('gate'), gateBudgetMs);
    };
    // A later-phase wait is queue time: pause the gate budget (keeping what is left of it) and run the queue
    // ceiling instead, so a healthy wait is never killed as a hung gate and a hung one is still bounded.
    const onRequeue = () => {
      if (requeueing) return;
      requeueing = true;
      gateBudgetMs = Math.max(0, gateBudgetMs - (Date.now() - gateResumedAt));
      clearTimeout(timer);
      timer = setTimeout(onTimeout('queue'), queueCeilingMs);
    };
    const onResume = () => {
      if (!requeueing) return;
      requeueing = false;
      armGate();
    };
    const scanLaterMarkers = (text) => {
      const lines = (lineCarry + text).split('\n');
      lineCarry = lines.pop().slice(-4096);
      for (const line of lines) {
        if (!line.endsWith(nonceSuffix)) continue; // unauthenticated (spoofed / stale-nonce) line: ignored
        if (line.startsWith(`⏳ ${GATE_QUEUED_MARKER}`)) onRequeue();
        else if (line.startsWith(`⏱ ${GATE_STARTED_MARKER}`)) onResume();
      }
    };

    // #66 — child notices (`⚠ verify-lane: …` at a line start) are surfaced to the caller's log, whole lines only.
    let noticeCarry = '';
    const scanNotices = (text) => {
      if (typeof onNotice !== 'function') return;
      const lines = (noticeCarry + text).split('\n');
      noticeCarry = lines.pop().slice(-4096);
      for (const line of lines) {
        if (line.startsWith('⚠ verify-lane:')) { try { onNotice(line); } catch {} }
      }
    };
    const onStderr = (chunk) => {
      scanNotices(chunk.toString('utf8'));
      if (markerSeen) {
        scanLaterMarkers(chunk.toString('utf8'));
        return;
      }
      // Bounded tail — this only ever needs to catch ONE short literal line near the start of the stream;
      // keeping the last ~4KB is generous headroom without letting a chatty gate grow this buffer forever.
      const output = stderrTail + chunk.toString('utf8');
      const hasMarker = output.includes(GATE_STARTED_MARKER);
      stderrTail = output.slice(-4096);
      if (hasMarker) {
        markerSeen = true;
        armGate();
        // Whatever follows the first marker in this same chunk may already be a re-queue line.
        scanLaterMarkers(output.slice(output.indexOf(GATE_STARTED_MARKER) + GATE_STARTED_MARKER.length));
        if (typeof onGateStarted === 'function') {
          try {
            onGateStarted();
          } catch {
            // A logging hook's own failure must never take down the gate run it is only observing.
          }
        }
      }
    };
    let tail = null;
    let drainTail = () => {};
    if (logFd != null) {
      // Decode across read boundaries: the marker lines carry a multi-byte emoji a raw read could split.
      const decoder = new StringDecoder('utf8');
      let offset = 0;
      drainTail = () => {
        let fd;
        try { fd = openSync(logPath, 'r'); } catch { return; }
        try {
          const buffer = Buffer.alloc(64 * 1024);
          for (;;) {
            const read = readSync(fd, buffer, 0, buffer.length, offset);
            if (read <= 0) break;
            offset += read;
            const text = decoder.write(buffer.subarray(0, read));
            if (text) onStderr(text);
          }
        } catch { /* a transient read failure retries on the next poll */ } finally { try { closeSync(fd); } catch {} }
      };
      tail = setInterval(drainTail, tailIntervalMs);
    } else {
      // Decode across read boundaries: the marker lines carry a multi-byte emoji a raw chunk could split.
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', onStderr);
      // Drain stdout so a full pipe buffer can never back-pressure/stall the child — this file never reads it
      // (mirrors the old `execFileSync` call site, which discarded it too).
      child.stdout.on('data', () => {});
    }
    const stopTail = () => { if (tail) { clearInterval(tail); tail = null; drainTail(); } };

    child.on('error', (err) => {
      clearTimeout(timer);
      stopTail();
      rejectPromise(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      stopTail();
      if (timedOutPhase) {
        const e = new Error(`verify-lane exceeded the ${timedOutPhase}-phase ceiling`);
        e.status = null;
        e.signal = signal || 'SIGKILL';
        e.pid = child.pid;
        e.timedOutPhase = timedOutPhase;
        rejectPromise(e);
      } else if (code !== 0) {
        const e = new Error(`verify-lane exited with code ${code}`);
        e.status = code;
        e.signal = signal;
        e.pid = child.pid;
        rejectPromise(e);
      } else {
        resolvePromise({ pid: child.pid });
      }
    });
  });
}

/**
 * Run ONE lane's gate to settlement: spawn `verify-lane.mjs` under both ceilings ({@link spawnGateBounded}) and,
 * when the run was killed (a ceiling, a signal), stamp the infrastructure failure on the still-owned marker
 * ({@link recordKilledVerification}). Resolves on a clean exit; rejects with the spawn error otherwise (exit 2 =
 * red is a rejection with `status: 2`, exactly as before). Shared by the in-process sweep below and the detached
 * gate job (#4135, we:scripts/conveyor/verify-gate-job.mjs), so both settle a lane by the same code.
 * @param {{pool:string, lane:number, dir:string, headSha:string, marker:object, runId:string,
 *   spawnGate?:typeof spawnGateBounded, log?:(m:string)=>void, onSpawn?:(pid:number, logPath:string)=>void,
 *   onGateStarted?:()=>void, logPath?:string}} o
 * @returns {Promise<{pid:number}>}
 */
export function runLaneGate({ pool, lane, dir, headSha, marker, runId, spawnGate = spawnGateBounded, log: say = log,
  onSpawn, onGateStarted, logPath = dispatchLogPath(dir) }) {
  let owned = { ...marker, startedAt: null, requestStartedAt: marker.startedAt ?? null, runId };
  const args = [VERIFY_LANE_CLI, `--repo=${dir}`, '--json', `--run-id=${runId}`];
  if (marker.suites) args.push(`--gate=${marker.suites}`);
  let gate;
  try { gate = spawnGate(args, {
    onSpawn: (pid) => { try { onSpawn?.(pid, logPath); } catch {} },
    // #65 — the child's stderr goes to a file, not a pipe into this process, so a daemon restart that adopts
    // in-flight gates (restartInFlight: adopt) never breaks the gate's output stream mid-run.
    logPath,
    onNotice: (line) => say(`  ${line.trim().replace(/^⚠ verify-lane:/, `⚠ ${pool}/lane-${lane}:`)}`),
    queueCeilingMs: QUEUE_PHASE_CEILING_MS,
    gateCeilingMs: VERIFY_DISPATCH_TIMEOUT_MS,
    // #4360 — the live proof this card's Proof plan needs: a real per-lane timestamp for when the gate
    // actually started (as opposed to when it was merely offered to the semaphore), so two lanes' overlap
    // can be shown from real evidence rather than assumed from the code shape.
    onGateStarted: () => {
      const started = markerFor(dir);
      if (started?.runId === runId) owned = started;
      say(`  ▶ gate started for ${pool}/lane-${lane} @ ${String(headSha).slice(0, 8)} — ${new Date().toISOString()}`);
      try { onGateStarted?.(); } catch {}
    },
  }); } catch (error) { gate = Promise.reject(error); }
  return Promise.resolve(gate).catch((error) => {
    const ceilingMs = error?.timedOutPhase === 'queue' ? QUEUE_PHASE_CEILING_MS : VERIFY_DISPATCH_TIMEOUT_MS;
    try { recordKilledVerification(dir, owned, error, ceilingMs); }
    catch (writeError) { say(`  ⚠ ${pool}/lane-${lane}: could not record infrastructure failure: ${writeError.message}`); }
    throw error;
  });
}

/** The two ceilings in force for this process (the gate job reports them in its result). */
export function gateCeilings() {
  return { queueCeilingMs: QUEUE_PHASE_CEILING_MS, gateCeilingMs: VERIFY_DISPATCH_TIMEOUT_MS };
}

/** Exposed for the gate job: the lane's marker (worktree-safe git-dir resolution) and HEAD. */
export function readLaneState(dir) {
  return { marker: markerFor(dir), headSha: tryGit(['rev-parse', 'HEAD'], dir) };
}

/**
 * Run one full sweep: scan every pool/lane for a lane whose marker needs a verify dispatch (per
 * {@link laneNeedsVerifyDispatch}), spawn a bounded gate run for each, and return a plain summary. Never calls
 * `process.exit` — this is the one thing #3878's standalone Verify daemon
 * (`we:skills-src/conveyor/verify-daemon.mjs`) ticks directly, and `main()` below is now a thin CLI shell over
 * it (exit code + `--json`/plain formatting only).
 *
 * Gates launch concurrently; admission remains the sole execution semaphore. With `inFlight`, outstanding
 * runs are capped and same-lane dispatch is suppressed across sweeps. `awaitSettle: false` returns launches
 * immediately; the same settlement handler records failures and removes each registry entry in the background.
 * With `awaitSettle:false` the returned `failures` is empty at return time, so a caller that must SEE a late
 * failure passes `onSettled(failure)`, called once per failure as it settles (a throwing observer is isolated).
 * #4135 — with `launchGate({pool, lane, dir, headSha, marker, runId}) → {id}` (the verify daemon's job mode) a
 * pending lane is handed to that launcher (it queues a detached gate job) instead of spawned here; the registry
 * entry carries the `jobId`, and settlement is the job's, not this sweep's. A superseded JOB entry is killed only
 * through `killJobGate(entry)`, which re-probes the job's gate handle first — never by the registry `pid` alone
 * (proven at the last sync, possibly exited and reused since); with no `killJobGate` a job entry is not signalled.
 * `laneHeld(dir) → string|null` (the job store's lane claims) is asked right before each start, in both modes: a held
 * lane is deferred (`reason: 'lane-held'`), never spawned or queued.
 * @param {{dryRun?:boolean, spawnGate?:typeof spawnGateBounded, poolRoot?:string,
 *   inFlight?:Map<string, object>|null, awaitSettle?:boolean, maxInFlight?:number,
 *   onSettled?:((failure:object) => void)|null}} [o] `spawnGate` and
 *   `poolRoot` (#4360) default to the real {@link spawnGateBounded} and the module-level {@link POOL_ROOT} — the
 *   ONLY reason either is ever overridden is a test that needs a controllable fake and an isolated fixture pool
 *   to prove lanes are dispatched concurrently, never a production caller.
 * @returns {Promise<{dryRun:boolean, dispatched:Array<object>, failures:Array<object>, skippedOutOfScope:Array<object>, deferred:Array<object>, superseded:Array<object>}>}
 */
export async function runVerifyDispatch({ dryRun = false, spawnGate = spawnGateBounded, poolRoot = POOL_ROOT,
  inFlight = null, awaitSettle = true, maxInFlight = resolveMaxInFlight(process.env), onSettled = null,
  launchGate = null, killJobGate = null, laneHeld = null,
} = {}) {
  const deferred = [];
  const superseded = [];
  const dispatched = [];
  const failures = [];
  // epic #3383 — read ONCE per run, never per lane. Both reads are cheap, but the marker/queue pair must be a
  // single consistent snapshot for the whole sweep rather than re-read mid-walk.
  const scopeEnabled = isQueueScopeEnabled();
  const scopeIds = scopeEnabled ? readScopedQueueIds() : [];
  const skippedOutOfScope = [];
  const supersedePolicy = resolveSupersedePolicy(process.env);
  if (scopeEnabled) {
    log(`⊂ queue-scoped: verify-dispatch will run the gate only for lanes on ${scopeIds.length ? scopeIds.join(', ') : '(nothing — the queue is empty)'}`);
  }

  // 1. The synchronous scan — decide WHICH lanes need a gate this sweep. Nothing here spawns anything, so this
  //    walk is exactly as serial as it always was; only the dispatch step below (2) goes concurrent.
  const pending = [];
  for (const pool of poolsToScan(poolRoot)) {
    const poolDir = join(poolRoot, pool);
    for (const lane of laneIndicesIn(poolDir)) {
      const dir = join(poolDir, `lane-${lane}`);
      const headSha = tryGit(['rev-parse', 'HEAD'], dir);
      const marker = markerFor(dir);
      if (!laneNeedsVerifyDispatch(marker, headSha)) continue;
      // Read the branch ONLY for a lane that already wants a gate run — the common "nothing pending" lane
      // never pays for the extra `git` call, and an unscoped run never pays for it at all.
      if (scopeEnabled) {
        const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
        if (!laneInQueueScope(branch, { enabled: true, ids: scopeIds })) {
          log(`  ⊂ skipping ${pool}/lane-${lane} (${branch || 'no branch'}) — not in this checkout's queue scope`);
          skippedOutOfScope.push({ pool, lane, branch });
          continue;
        }
      }

      const entry = inFlight?.get(dir);
      if (entry) {
        if (!dryRun && laneNeedsVerifyDispatch(marker, headSha) && marker.runId !== entry.runId
          && marker.startedAt !== entry.requestStartedAt && sameVerifyRequest(entry, marker)
          && entry.keptFor !== marker.startedAt) {
          entry.keptFor = marker.startedAt;
          log(`  ↺ ${pool}/lane-${lane}: identical re-request for in-flight run ${String(entry.runId).slice(0, 8)} — kept running (it answers this request)`);
        }
        if (!dryRun && process.env.VERIFY_DISPATCH_KILL_SUPERSEDED !== '0'
          && inFlightSuperseded(entry, marker, headSha, supersedePolicy)) {
          let killed = !entry.jobId;
          try {
            if (entry.jobId) killed = killJobGate?.(entry) === true;
            else if (entry.pid > 1) process.kill(-entry.pid, 'SIGKILL');
          } catch {}
          log(`  ✂ ${pool}/lane-${lane}: in-flight run ${String(entry.runId).slice(0, 8)} superseded by a newer request — ${killed
            ? 'killed' : `gate job ${entry.jobId} not signalled (its gate is not proven alive right now)`}`);
          superseded.push({ pool, lane, runId: entry.runId });
        }
        continue;
      }
      if (inFlight && pending.length >= maxInFlight - inFlight.size) {
        deferred.push({ pool, lane, sha: headSha, reason: 'max-in-flight' });
        continue;
      }
      if (dryRun) {
        log(`  would dispatch verify for ${pool}/lane-${lane} @ ${String(headSha).slice(0, 8)} (suites: ${marker.suites || 'default'})`);
        dispatched.push({ pool, lane, sha: headSha });
        continue;
      }

      pending.push({ pool, lane, dir, headSha, suites: marker.suites, marker });
    }
  }

  if (pending.length === 0) return { dryRun, dispatched, failures, skippedOutOfScope, deferred, superseded };

  // 2. The concurrent dispatch — fire every pending lane's gate without awaiting between them (#4360). No new
  //    admission logic lives here: each spawned `verify-lane.mjs` child queues on `heavy-admission.mjs`'s OWN
  //    capacity semaphore via its own `acquireSlotBlocking` call (the sole chokepoint — see the comment at that
  //    call site), so offering several candidates at once here is sufficient to bound real concurrent gate
  //    execution at the cap.
  const settlements = pending.map(({ pool, lane, dir, headSha, suites, marker }) => {
    // `runId` rides into the marker via the child's own start stamp (`--run-id`), so a queue-phase kill — before
    // `onGateStarted` could capture a `startedAt` — can still tell this run's marker from a newer request's.
    // #4135 (PR 4764 round 7) — the job store's lane claims have the last word, read right before the start: a lane
    // whose previous gate is not CONFIRMED gone gets no new gate, in-process or job (a check that fails is a hold too).
    if (laneHeld) {
      let held;
      try { held = laneHeld(dir); } catch (error) { held = `its hold check failed (${String(error?.message || error).split('\n')[0]})`; }
      if (held) {
        deferred.push({ pool, lane, sha: headSha, reason: 'lane-held', why: held });
        return Promise.resolve();
      }
    }
    const runId = randomUUID();
    const entry = { pool, lane, dir, runId, pid: null, sha: headSha, suites: marker.suites, treeHash: marker.treeHash ?? null,
      requestStartedAt: marker.startedAt ?? null, startedMs: Date.now(), logPath: null };
    // #4135 — job mode: the gate runs as a DETACHED DURABLE JOB (we:scripts/conveyor/verify-gate-job.mjs) whose own
    // supervisor process owns the ceilings, the kill and the settlement, so this sweep only queues it and returns.
    // The registry entry is the job's; a daemon restart rebuilds it from the job store instead of killing the gate.
    if (launchGate) {
      inFlight?.set(dir, entry);
      try {
        const job = launchGate({ pool, lane, dir, headSha, marker, runId });
        Object.assign(entry, { jobId: job?.id ?? null });
        dispatched.push({ pool, lane, sha: headSha, launched: true, jobId: job?.id ?? null });
        log(`  queued verify job ${job?.id ?? '?'} for ${pool}/lane-${lane} @ ${String(headSha).slice(0, 8)} (suites: ${suites || 'default'})`);
      } catch (error) {
        if (inFlight?.get(dir) === entry) inFlight.delete(dir);
        log(`  ⚠ ${pool}/lane-${lane}: could not queue a verify job (non-fatal): ${String(error?.message || error).split('\n')[0]}`);
        recordFailure({ pool, lane, sha: headSha });
      }
      return Promise.resolve();
    }
    inFlight?.set(dir, entry);
    if (!awaitSettle) dispatched.push({ pool, lane, sha: headSha, launched: true });
    log(`  dispatching verify for ${pool}/lane-${lane} @ ${String(headSha).slice(0, 8)} (suites: ${suites || 'default'})…`);
    const gate = runLaneGate({ pool, lane, dir, headSha, marker, runId, spawnGate, log,
      onSpawn: (pid, path) => { entry.pid = pid; entry.logPath = path; } });
    return gate.then(
      value => settle({ status: 'fulfilled', value }, { pool, lane, dir, headSha }),
      reason => settle({ status: 'rejected', reason }, { pool, lane, dir, headSha }),
    ).catch((error) => {
      // Settlement (including marker reads/logging) must never leave an unhandled rejection.
      try { log(`  ⚠ ${pool}/lane-${lane}: settlement failed (non-fatal): ${error.message}`); } catch {}
    }).finally(() => {
      if (inFlight?.get(dir) === entry) inFlight.delete(dir);
    });
  });

  function settle(result, { pool, lane, dir, headSha }) {
    if (result.status === 'fulfilled') {
      if (awaitSettle) dispatched.push({ pool, lane, sha: headSha });
      return;
    }
    // A red gate is a NORMAL, expected exit (verify-lane exits 2 on red) — it already recorded the red
    // marker correctly; this is not a dispatch failure. Only a THROW verify-lane itself did not turn into
    // a marker write (a spawn error, an unexpected non-{0,2} exit) counts as one, and is logged, never
    // fatal to the rest of this pass — one bad lane must not block dispatching the others.
    const e = result.reason;
    const status = Number.isFinite(e && e.status) ? e.status : null;
    // Trust `e.timedOutPhase` directly — it is `spawnGateBounded`'s OWN authoritative record of whether
    // ONE OF OUR TWO TIMERS actually fired, set only inside its own `onTimeout` handler. A prior version
    // of this check re-derived "timed out" from the exit shape alone (`status === null && signal present`)
    // — but that shape is NOT unique to our own kill: an external actor (an operator's `kill -9`, an OS
    // OOM-kill, a host restart) killing the spawned `verify-lane.mjs` process produces the exact same
    // `status:null, signal:<sig>` pair, and the re-derived check would then misattribute that external
    // kill as "exceeded the queue/gate ceiling" — misleading during exactly the incident investigation
    // this ceiling exists to support (found in review, epic #3383). Functionally harmless either way (the
    // lane lands in `failures` and gets retried next tick regardless), but the LABEL must be accurate.
    const timedOut = !!(e && e.timedOutPhase);
    if (timedOut) {
      const phase = e.timedOutPhase || 'gate';
      const ceilingMs = phase === 'queue' ? QUEUE_PHASE_CEILING_MS : VERIFY_DISPATCH_TIMEOUT_MS;
      log(`  ⚠ ${pool}/lane-${lane}: verify-lane exceeded the ${ceilingMs}ms ${phase}-phase ceiling — killed (tree included). Recorded infrastructure failure for the still-owned request; inspect the cause before an explicit retry.`);
      recordFailure({ pool, lane, sha: headSha, timedOut: true, timedOutPhase: phase, infrastructure: markerFor(dir)?.infrastructure });
    } else if (status === 2) {
      if (awaitSettle) dispatched.push({ pool, lane, sha: headSha, red: true });
    } else {
      log(`  ⚠ ${pool}/lane-${lane}: verify-lane dispatch failed (non-fatal): ${String(e?.message || e).split('\n')[0]}`);
      recordFailure({ pool, lane, sha: headSha, infrastructure: markerFor(dir)?.infrastructure });
    }
  }

  function recordFailure(failure) {
    failures.push(failure);
    onSettled?.(failure); // a throw is contained by the settlement chain's `.catch`; `.finally` still releases the lane
  }

  if (awaitSettle) await Promise.allSettled(settlements);
  return { dryRun, dispatched, failures, skippedOutOfScope, deferred, superseded };
}

async function main(argv) {
  const flags = parseFlags(argv);
  const result = await runVerifyDispatch({ dryRun: !!flags['dry-run'] });

  if (flags.json) {
    writeAllSync(1, JSON.stringify(result, null, 2) + '\n');
  } else if (result.dispatched.length === 0 && result.failures.length === 0) {
    log('verify-dispatch: nothing pending.');
  }
  process.exit(result.failures.length > 0 ? 1 : 0);
}

// Run the IO shell only when invoked directly — never on import (keeps the pure core side-effect-free).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`✗ verify-dispatch error: ${String((e && e.stack) || e)}\n`);
    process.exit(1);
  });
}
