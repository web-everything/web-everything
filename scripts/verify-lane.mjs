#!/usr/bin/env node
/**
 * verify-lane.mjs — run a lane's required suites SYNCHRONOUSLY and record a green/red verification marker
 * keyed to the lane's HEAD commit (#2833, subagent-stall mitigation).
 *
 * WHY. A build subagent's delivery arc is: run the suites, then `pr-land` / `lane-pool release` to finish.
 * Twice one night a subagent BACKGROUNDED its long test run and then yielded/terminated before it finished —
 * leaving the lane mid-flight: producing nothing, never erroring, so nothing reclaimed it. The root cause was
 * that the verification was BACKGROUNDABLE and yielding mid-run LOOKED complete.
 *
 * This is the sanctioned "run your checks" step for the build flow, and it removes that footgun two ways:
 *   1. It runs the suites in the FOREGROUND (streaming stdout/stderr), waiting until they exit — "background then
 *      yield" is no longer the path of least resistance, because the tool itself is a blocking call.
 *   2. It writes a lifecycle MARKER (`.git/.lane-verify`, keyed to HEAD): `running` at start, rewritten to
 *      `green`/`red` at finish. If the process is killed mid-run, the marker is stranded at `running` — so the
 *      delivery gate (`pr-land`'s finish-guard) can SEE the verification never completed and refuse to land.
 *
 * The pure decision half (marker shape + the gate decision `pr-land` calls) lives in `scripts/lib/lane-verify.mjs`.
 *
 * THE DEFAULT GATE IS DIFF-DRIVEN (#3372). Rather than an unconditional `npm run test:unit`, the default gate
 * decides off the lane's actual `git diff` against `origin/main` via `scripts/readiness/test-selection.mjs`
 * (#2681), using its LOCAL policy (xpnhz4o, `decideLocalSelection`): the working-tree diff runs only
 * `npx vitest related <changed files + tests naming them>` (including shared helpers). A config/setup/dependency
 * change, a deleted source file, or an empty/unresolvable diff now requires an explicit affected-test gate;
 * the gate prints which of the two it chose, and why, before it starts. CI still runs the full suite.
 * See `scripts/lib/verify-lane-gate.mjs` for the decision core and why defaulting the shrink at THIS call site
 * does not conflict with #2681's own "not defaulted [on the CI merge gate]" DoD.
 *
 * Usage:
 *   node scripts/verify-lane.mjs                      # run the default gate (diff-driven selection + check:standards; #3372) foreground, record green/red for HEAD
 *   node scripts/verify-lane.mjs --gate="npm run test:unit"   # override the suite command (skips diff-driven selection entirely)
 *   node scripts/verify-lane.mjs --repo=~/workspace/.lanes/web-everything/lane-3   # verify a specific lane clone
 *   node scripts/verify-lane.mjs run                  # xpnhz4o — run the SAME default gate foreground, but record NO marker (the fix/ci-heal gate)
 *   node scripts/verify-lane.mjs --json              # machine-readable {sha, status, exitCode} on stdout
 *   node scripts/verify-lane.mjs check               # READ-ONLY: print the current marker's gate verdict for HEAD, run nothing
 *   node scripts/verify-lane.mjs check --require-verified   # exit non-zero unless HEAD has a fresh GREEN marker (the gate pr-land applies)
 *   node scripts/verify-lane.mjs check --wait=<ms>   # #4358 — BLOCK internally (polling the marker, not your turn loop),
 *     but ONLY while the marker is `running` — the one status a background process can still move off of. Returns the
 *     instant it settles green/red, and returns everything else (`absent`/`corrupt`/`break-glass`/`head-moved`)
 *     IMMEDIATELY too — waiting longer can never change any of those. A bounded "timeout" is returned only if it is
 *     still `running` when <ms> elapses (clamped to the total verify budget — see MAX_SAFE_WAIT_MS /
 *     waitForVerifySettle in lib/lane-verify.mjs; a dispatched agent keeps each call under its Bash `timeout` by
 *     using `--wait=540000` and re-running on `timeout`). Replaces the old "request, then `check` again
 *     next turn, repeat" loop with ONE blocking call per wait: same sanctioned `check` subcommand
 *     (`we:scripts/guard-bash.mjs`'s allowlist matches on the subcommand word, not the flags after it, so this needed
 *     no guard change), just a flag that does the polling for you instead of handing it back to the caller's own turn
 *     loop.
 *   node scripts/verify-lane.mjs reset                # clear a stale marker so `verify` can start (x4jcqm4) — refuses if a FOREIGN lease is live (own live lease is OK, #3378)
 *   node scripts/verify-lane.mjs request              # #3105 — stamp the `running` marker and return immediately; does NOT run the gate.
 *     Refuses with exit 3 and no marker written when no verify daemon is alive.
 *     The sanctioned call for an interactive agent session: the actual suite run is picked up and executed by
 *     `scripts/conveyor/verify-dispatch.mjs` (via the verify daemon, unbound by the agent tool's foreground
 *     window) on its next tick, which runs the SAME `verify` mode below to completion. An agent that called
 *     `request` then polls `check` across its own turns — each `check` call is a fast marker read, never a
 *     suite run, so no single call can ever exceed the foreground window, no matter how long the gate itself
 *     takes. `request` reuses the exact START-write guard `verify` already applies (a foreign terminal marker is
 *     archived, never clobbered) — it is that guard's own first half, factored out, not a new decision.
 *
 * Exit codes: 0 = green (marker recorded green) / `check` verdict ok / `reset` cleared or was a no-op / `request`
 * accepted; 2 = red (suites failed — marker recorded red) / `check` verdict not-ok; 3 = usage / git error (no
 * marker written) / `request` refused because no verify daemon is alive / `reset` refused because a FOREIGN lease is live (own live lease no longer refuses, #3378).
 */
import { RUNNER_LOCK_ROOT, runnerLeaseStatus, probeRunnerLeaseLiveness } from '../skills-src/conveyor/runner-lock.mjs';
import { VERIFY_DAEMON_LEASE_KEY } from '../skills-src/conveyor/verify-daemon.mjs';
import { readLockEntry } from './readiness/file-locks.mjs';
import { spawn } from 'node:child_process';
import { createFailureCollector } from './lib/verify-failures.mjs';
import { timeoutRetryFiles, describeTimeoutRetry, MAX_TIMEOUT_LOG_BYTES } from './lib/gate-timeout-retry.mjs';
import { writeFileSync, renameSync, existsSync, readFileSync, readdirSync, unlinkSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { VERIFY_FILENAME, VERIFY_PREVIOUS_FILENAME, verifyServerVerdict, verifyStartBody, verifyFinishBody, verificationInfrastructureFailure, verifyGateDecision, readVerifyMarker, resolveVerifyOptions, waitForVerifySettle, resolveWaitCeilingMs } from './lib/lane-verify.mjs';
import { LEASE_FILENAME, isLeaseStale, isConfirmedOwnLease } from './lib/lane-lease.mjs';
import { defaultPoolRoot } from './lib/lane-pool-paths.mjs';
import { writeAllSync } from './lib/write-all-sync.mjs';
import { resolveDefaultGate, explicitGateRefusal, describeGate, laneRelevantChangeSinceForRecord, computeWorkingTreeHash, stableTreeHash, localChangedSet } from './lib/verify-lane-gate.mjs';
import { admissionLockRoot, resolveCap, resolveTimeoutMs, acquireSlotBlocking, releaseOwnedSlot, ADMISSION_HELD_ENV, classifyCommandKind } from './readiness/heavy-admission.mjs';

// ── tiny arg parsing (matches push-if-green.mjs / lane-pool.mjs) ─────────────────────────────────────
const flags = {};
const positionals = [];
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  } else positionals.push(a);
}

const expandHome = (p) => (p && p.startsWith('~') ? join(homedir(), p.slice(1)) : p);
const REPO = resolve(expandHome(flags.repo) || process.cwd());
const AS_JSON = !!flags.json;
// #2833 finding 5 — resolve the gate options through the SHARED resolver so `check` mode agrees with pr-land:
// `--require-verified` OR `WE_REQUIRE_VERIFIED=1`, and the `WE_LAND_UNVERIFIED=1` break-glass. Previously `check`
// read only `flags['require-verified']`, so the same env produced two different verdicts at the two call sites.
const { requireVerified: REQUIRE_VERIFIED, breakGlass: VERIFY_BREAK_GLASS } = resolveVerifyOptions({ flags, env: process.env });
const MODE = positionals[0] === 'check' ? 'check' : positionals[0] === 'reset' ? 'reset'
  : positionals[0] === 'request' ? 'request' : positionals[0] === 'run' ? 'run' : 'verify';

const git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (args) => { try { return git(args); } catch { return null; } };

// Resolve the marker inside the REAL git dir. `.git` is a DIRECTORY in a clone (the lane case) but a FILE in a
// worktree, and can be relocated via $GIT_DIR — so `git rev-parse --absolute-git-dir` is the only correct way to
// locate it (#2833 finding 4: a hardcoded `join(REPO, '.git', …)` throws ENOTDIR in a worktree). Falls back to
// the literal only if git can't answer, in which case the downstream git ops fail loudly anyway.
const GIT_DIR = tryGit(['rev-parse', '--absolute-git-dir']) || join(REPO, '.git');
const MARKER = join(GIT_DIR, VERIFY_FILENAME);

// #2833 finding 2 — the marker read is single-sourced in lane-verify.mjs (`readVerifyMarker`) so this writer and
// pr-land's finish-guard can never drift. It resolves `<gitDir>/.lane-verify`, folds a valid-JSON non-object to
// `{ corrupt: true }` (never `absent`, which would fail OPEN), and returns null only for a genuinely missing file.
const readMarker = () => readVerifyMarker(GIT_DIR);

function writeMarker(record) {
  // Atomic: write a temp sibling in the same git dir, then rename over the marker — so a concurrent reader
  // (pr-land's finish-guard) never observes a half-written file (#2833 finding 5). renameSync is atomic within a
  // filesystem, and the temp lives beside the marker so it always is.
  const tmp = `${MARKER}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n');
  renameSync(tmp, MARKER);
}

function emit(result, exitCode) {
  if (AS_JSON) writeAllSync(1, JSON.stringify(result) + '\n');
  else process.stderr.write(`verify-lane [lane @ ${result.sha ? result.sha.slice(0, 8) : '?'}] ${result.status}: ${result.detail}\n`);
  process.exit(exitCode);
}

const headSha = tryGit(['rev-parse', 'HEAD']);
if (!headSha) emit({ sha: null, status: 'error', reason: 'no-head', detail: `could not resolve HEAD in ${REPO} — is this a git checkout?` }, 3);

// ── `check` — READ-ONLY: report the finish-guard verdict for HEAD, run nothing. This is exactly the gate
//    pr-land applies, exposed so a delivery step can pre-flight it (and so it is directly testable end-to-end).
if (MODE === 'check') {
  // #4358 — `--wait=<ms>` is a FLAG on this existing subcommand, not a new one (see the usage banner above for
  // why that shape specifically matters to the guard). Bare `check` (no `--wait`) below is completely
  // unchanged: one fast, non-blocking marker read, exactly as every other caller (humans, other scripts) already
  // relies on.
  if (flags.wait !== undefined) {
    // #4358 — a BARE `--wait` (no `=<ms>`) parses to the boolean `true` (see the tiny arg parser above), and
    // `Number(true) === 1` would otherwise sail past the finite/positive check as a silent ~1ms wait. Only a
    // STRING value is a legitimate ask; anything else is `NaN` here, which that check already refuses.
    const requestedMs = typeof flags.wait === 'string' ? Number(flags.wait) : NaN;
    if (!Number.isFinite(requestedMs) || requestedMs <= 0) {
      emit({ sha: headSha, status: 'error', reason: 'bad-wait', ok: false, detail: `--wait must be given as --wait=<ms> (a positive number of milliseconds), got ${JSON.stringify(flags.wait)}.` }, 3);
    }
    const ceilingMs = resolveWaitCeilingMs(requestedMs);
    if (ceilingMs < requestedMs) {
      process.stderr.write(`⚠ --wait=${requestedMs}ms clamped to ${ceilingMs}ms — a single blocking wait must stay inside the queue-plus-execution budget.\n`);
    }
    const result = await waitForVerifySettle({
      readRecord: readMarker,
      readHead: () => tryGit(['rev-parse', 'HEAD']),
      headSha,
      breakGlass: VERIFY_BREAK_GLASS,
      requireVerified: REQUIRE_VERIFIED,
      ceilingMs,
      // #4296 (converge round 2, standards-conformance juror) — `base` is explicit here, never the wrapper's own
      // default: this file's default gate (`resolveDefaultGate`, above) already hardcodes `origin/main` as the
      // ONLY base a WE lane clone verifies against (there is no `--base=` flag on this CLI), so naming it here
      // too keeps the two in visible agreement instead of one relying on a default the other never mentions.
      resolveLaneRelevantChangeSince: (record) => laneRelevantChangeSinceForRecord({ record, headSha, base: 'origin/main', runGit: git }),
    });
    emit(result, result.ok ? 0 : 2);
  }
  const bareCheckRecord = readMarker();
  const v = verifyGateDecision({
    record: bareCheckRecord, headSha, breakGlass: VERIFY_BREAK_GLASS, requireVerified: REQUIRE_VERIFIED,
    laneRelevantChangeSince: laneRelevantChangeSinceForRecord({ record: bareCheckRecord, headSha, base: 'origin/main', runGit: git }),
  });
  emit({ sha: headSha, ...v }, v.ok ? 0 : 2);
}

// #3378 review (rounds 2-4) — `isConfirmedOwnLease` itself now refuses an `ownerSession` match that is either
// shadowed by a DECLARED occupant (`workerSession`, the dispatcher/worker split) or CONTESTED (a sibling lane
// sharing the same `ownerSession`, the workflowLane/conveyor-dispatch topology) — see its doc in
// `lib/lane-lease.mjs`. Telling "contested" apart from "uncontested" needs every OTHER lane's live lease, so
// `reset` scans the pool the same way `lane-pool.mjs#liveLeasesInPoolExcept` does for the structurally
// identical `release` decision: every pool under the workspace root, not just this lane's own pool (a
// session's siblings routinely hold lanes elsewhere). Best-effort — any unreadable dir just yields a shorter
// list, which can only make a lease read as UNCONTESTED (never a spurious refusal).
function tryReaddir(dir) {
  try { return readdirSync(dir); } catch { return []; }
}
function readLeaseFile(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
function siblingLeasesExcept(thisLeaseFile) {
  const poolRoot = defaultPoolRoot(REPO);
  const out = [];
  for (const poolName of tryReaddir(poolRoot)) {
    const poolDir = join(poolRoot, poolName);
    for (const laneName of tryReaddir(poolDir)) {
      if (!/^lane-\d+$/.test(laneName)) continue;
      const file = join(poolDir, laneName, '.git', LEASE_FILENAME);
      if (file === thisLeaseFile) continue;
      const sib = readLeaseFile(file);
      if (sib && !isLeaseStale(sib, Date.now())) out.push(sib);
    }
  }
  return out;
}

// ── `reset` (x4jcqm4) — clear a marker that is stale, not overlapping ─────────────────────────────────
// The START-write guard above (finding 4) is correct when a marker's terminal record belongs to a run that is
// STILL RELEVANT — but it cannot tell that apart from a marker that is simply old: a finished run, in a lane
// nothing currently holds. Two nights running that indistinguishability forced a manual `rm` of this file to
// unblock an unrelated change. `reset` is the sanctioned recovery: it clears the marker when this lane's own
// `.lane-lease` marker is absent, has outlived its TTL (`isLeaseStale`, `scripts/lib/lane-lease.mjs` — the
// same staleness test `lane-pool.mjs acquire` already uses to decide a lane is reclaimable), OR is CONFIRMED
// to be the caller's own live lease (`isConfirmedOwnLease`, #3378) — the same session that is about to run
// `verify` again has no one else's work to protect itself from, once a declared occupant (if any) is checked
// and the ownerSession match (if that's all there is) is confirmed uncontested. A live lease with no confirmed
// owner match (foreign, shadowed by a different declared occupant, contested by a sibling, or ambiguous
// because either side lacks an identity signal) still refuses: someone else may be relying on the current
// marker, matching the START-write guard's own protective posture rather than working around it.
if (MODE === 'reset') {
  if (!existsSync(MARKER)) emit({ sha: headSha, status: 'noop', reason: 'no-marker', detail: `no marker at ${MARKER} — nothing to reset.` }, 0);
  const record = readMarker();
  const leaseFile = join(GIT_DIR, LEASE_FILENAME);
  let lease = null;
  if (existsSync(leaseFile)) {
    try { lease = JSON.parse(readFileSync(leaseFile, 'utf8')); } catch { lease = null; }
  }
  const mySessionId = process.env.CLAUDE_CODE_SESSION_ID || null;
  const siblingLeases = lease ? siblingLeasesExcept(leaseFile) : [];
  if (lease && !isLeaseStale(lease, Date.now()) && !isConfirmedOwnLease({ lease, mySessionId, siblingLeases })) {
    emit(
      {
        sha: headSha, status: 'refused', reason: 'active-lease', exitCode: null,
        detail: `refusing to reset: ${leaseFile} holds a live lease (${lease.session || 'unknown'}, acquired ${lease.acquiredAt}) — this lane may be in active use; release it or let the lease expire first.`,
      },
      3,
    );
  }
  unlinkSync(MARKER);
  const desc = record && !record.corrupt ? `${record.status || 'stranded'} marker for ${String(record.sha || '?').slice(0, 8)}` : 'a corrupt marker';
  emit({ sha: headSha, status: 'reset', reason: 'cleared', detail: `cleared ${desc} — ${MARKER} removed.` }, 0);
}

// ── `verify` — run the suites SYNCHRONOUSLY and record the outcome ───────────────────────────────────
// #3372 — the DEFAULT gate is diff-driven (scripts/lib/verify-lane-gate.mjs): an explicit `--gate=` always wins
// (unchanged); otherwise resolve off the lane's actual diff against origin/main. Computed here (not above, with
// the other flags) so `check`/`reset` — which never reach this section — never pay for the git diff it needs.
// #3919 — inject the TARGET checkout's npm script names so a sibling repo (plateau-app has no `test:unit` /
// `check:standards`) gets a gate it can actually run. Unreadable package.json ⇒ undefined ⇒ WE-shaped (unchanged).
function readCheckoutScripts() {
  try { return Object.keys(JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).scripts || {}); } catch { return undefined; }
}
let GATE;
let resolvedGate;
if (typeof flags.gate === 'string') {
  GATE = flags.gate;
  // A `request` (the only path a dispatched agent has) whose DEFAULT selection is blocked is the high-risk case —
  // config/dependency/unknown/oversized diffs used to force the full suite. The agent-supplied gate must then be an
  // affected-test shape, never an arbitrary command that would record a green for the surfaces that most need one.
  // The dispatcher's own child (`--run-id`) re-checks at run time: the tree may have moved since `request`, and a gate
  // accepted for a docs-only diff must not run, and record a green, once the diff reaches a config/dependency file.
  const dispatchedChild = MODE === 'verify' && typeof flags['run-id'] === 'string';
  if (MODE === 'request' || dispatchedChild) {
    // Only a KNOWN diff whose selection is blocked counts; an unresolvable diff (no `origin/main`) is unchanged.
    let defaultBlocked = false;
    try {
      const { decision } = resolveDefaultGate({ runGit: git, env: process.env, scripts: readCheckoutScripts(), fileExists: (p) => existsSync(join(REPO, p)) });
      defaultBlocked = decision.mode === 'blocked' && Array.isArray(decision.changedFiles) && decision.changedFiles.length > 0;
    } catch { /* cannot tell ⇒ unchanged behaviour */ }
    const refusal = defaultBlocked ? explicitGateRefusal(GATE) : null;
    if (refusal) {
      // A dispatched child must leave a TERMINAL record (red, exit 3) — leaving the `running` request as it was would
      // make the dispatcher re-spawn this same refusal on every sweep. A plain `request` records nothing.
      if (dispatchedChild) {
        writeMarker(verifyFinishBody(verifyStartBody({ sha: headSha, suites: GATE, startedAt: new Date().toISOString(), treeHash: null }),
          { finishedAt: new Date().toISOString(), exitCode: 3, sha: headSha, suites: GATE, treeHash: null }));
      }
      emit({ sha: headSha, status: 'gate-refused', reason: 'explicit-gate-not-affected-test', ok: false, detail: `${refusal}. The default selection is blocked for this diff, so supply an affected-test gate such as \`--gate="npx vitest related <files> --run"\`; ${dispatchedChild ? 'recorded a red marker so it is not re-dispatched' : 'no marker was recorded'}.` }, 3);
    }
  }
} else {
  const resolved = resolveDefaultGate({ runGit: git, env: process.env, scripts: readCheckoutScripts(), fileExists: (p) => existsSync(join(REPO, p)) });
  if (resolved.decision.mode === 'blocked') emit({ sha: headSha, status: 'selection-required', reason: 'local-selection-bound', ok: false, detail: describeGate(resolved) }, 3);
  GATE = resolved.command;
  resolvedGate = resolved;
  // xpnhz4o — always SAY whether this is a selected run or a full-suite fallback, and why (stderr, so `--json`
  // stdout stays one parseable document).
  process.stderr.write(describeGate(resolved) + '\n');
}

// The dispatcher passes the requested default command back via --gate. Recognize that exact command,
// without interpreting arbitrary shell overrides or accidentally skipping their remaining steps.
if (!resolvedGate && typeof flags.gate === 'string') {
  try {
    const resolved = resolveDefaultGate({ runGit: git, env: process.env, scripts: readCheckoutScripts(), fileExists: (p) => existsSync(join(REPO, p)) });
    if (resolved.command === GATE) resolvedGate = resolved;
  } catch { /* Unknown selection cannot authorize a retry. */ }
}

// 1. Stamp the `running` marker BEFORE the suites start, so a kill mid-run leaves a stranded (detectably
//    unfinished) marker rather than nothing.
//    #2833 finding 4 protected a TERMINAL (`green`/`red`) record for a DIFFERENT sha from being destroyed by the
//    start write. #3751 / #3383 keep that protection by ARCHIVING the record to `.lane-verify.previous` instead of
//    refusing: refusing (including the #3538 merged-is-spent carve-out) made every second verify in a lane after a
//    new commit, an amend or a rebase come back `superseded` until a hand `reset` (hit five times on 2026-09-23/24,
//    and it broke `poc-land.mjs`'s own rebase-then-re-verify path outright). A record for a sha that is not HEAD
//    can never bless a landing of this clone's HEAD, so archiving loses nothing — merged or not; the FINISH-write
//    compare-and-set below still refuses to stamp a result over a record for another sha (finding 1, the
//    false-green guard).
// xpnhz4o — `run` mode never touches the marker: it is the plain "run my selected gate now" call (the fix /
// ci-heal `gateFor` form and the canary's gate; a dispatched fix/ci-heal agent uses `request`/`check` instead, #4369), whose caller never lands through pr-land's finish-guard, so recording (or
// archiving) a marker would only couple it to whatever a previous occupant of this clone left behind.
const preStart = MODE === 'run' ? null : readMarker();
if (preStart && !preStart.corrupt && (['green', 'red', 'infrastructure-failure'].includes(preStart.status)) && preStart.sha && preStart.sha !== headSha) {
  writeFileSync(join(GIT_DIR, VERIFY_PREVIOUS_FILENAME), `${JSON.stringify(preStart, null, 2)}\n`);
}

// #4473 — CACHE-HIT FAST PATH, checked before the unconditional start-write below ever runs. A worker iterating
// with UNCOMMITTED edits never moves `headSha`, so a prior `request`/`verify` for THIS exact head can already
// have a terminal record sitting on disk when this call is made — and until now, `request`/bare `verify`
// discarded it unconditionally on every call, forcing `verify-dispatch.mjs` to re-run the FULL gate even when
// nothing the gate looks at had changed (the measured "same lane+sha verified repeatedly" waste this item exists
// to cut). `headSha` alone is NOT a safe skip condition — the working tree can change with HEAD held still — so
// this only fires when the CONTENT hash also matches (`computeWorkingTreeHash`, same shell `runGit` the gate
// decision above already used). `null` (git couldn't answer) never matches — fail closed, same posture as every
// other "unknown" cell this file already honors (#4296's own `laneRelevantChangeSince`).
//
// GREEN ONLY — a RED record is deliberately NEVER cache-hit. Reds are frequently non-code (host contention, a
// flaky test — this very item's own card logged three such reds), and before this change a bare re-`request`/
// `verify` on an unchanged tree always re-ran the gate, which is exactly how a worker clears a flaky red: touch
// nothing, ask again. Caching a red would make that red STICKY (stuck exit 2 until a file is touched or `reset`
// is run) — worse than the "wasted re-run" this item is fixing. So `request`/`verify` on a red marker always
// fall through to the ordinary start-write below and actually re-run, same as before this diff landed.
//
// SAME GATE ONLY — the key also requires `preStart.suites === GATE`: a green recorded under a narrower or
// weaker `--gate=` override (e.g. `--gate=true`) must never satisfy a LATER request for a different/stronger
// gate on the same unchanged tree — that would silently skip the real verification the caller actually asked
// for. Only a green produced by the SAME gate command can answer a cache hit.
const treeHashNow = () => computeWorkingTreeHash({ runGit: git, fileMode: (f) => lstatSync(join(REPO, f)).mode });
const currentTreeHash = MODE === 'run' ? null : treeHashNow();
const cacheHit = MODE !== 'run' && preStart && !preStart.corrupt
  && preStart.status === 'green'
  && preStart.sha === headSha
  && currentTreeHash != null && preStart.treeHash === currentTreeHash
  && preStart.suites === GATE;

if (cacheHit) {
  const cachedDetail = `green for ${headSha.slice(0, 8)} — working tree unchanged since that verification (content hash + gate match); no new run needed.${describeTimeoutRetry(preStart.retriedTimeouts)}`;
  const cachedRetry = preStart.retriedTimeouts?.length ? { retriedTimeouts: preStart.retriedTimeouts } : {};
  if (MODE === 'request') {
    // Leave the marker exactly as it is: never overwrite a still-accurate terminal record with a fresh
    // `running` one — that overwrite is the ONLY thing that made `verify-dispatch.mjs` see `running` and
    // re-dispatch. A caller polling `check`/`check --wait=` next reads the SAME terminal record this emits.
    emit({ sha: headSha, status: 'cached', reason: 'cached', exitCode: preStart.exitCode ?? null, ...cachedRetry, detail: `verification already ${cachedDetail}` }, 0);
  }
  // Bare `verify`: report the cached terminal result directly — never touch the marker, never exec the gate.
  emit({ sha: headSha, status: 'green', reason: 'cached', exitCode: preStart.exitCode ?? null, ...cachedRetry, detail: cachedDetail }, 0);
}

// #4161 — cached results need no server; only new requests require the daemon's live lease.
if (MODE === 'request') {
  const lockRoot = process.env.CONVEYOR_RUNNER_LOCK_ROOT || RUNNER_LOCK_ROOT;
  const leaseStatus = runnerLeaseStatus(lockRoot, { key: VERIFY_DAEMON_LEASE_KEY });
  const pidLiveness = probeRunnerLeaseLiveness(readLockEntry(lockRoot, VERIFY_DAEMON_LEASE_KEY));
  const verdict = verifyServerVerdict({ leaseStatus, pidLiveness });
  if (!verdict.alive) {
    emit({
      sha: headSha, status: 'no-server', reason: 'verify-daemon-not-alive', ok: false,
      detail: `No verify daemon is alive (${verdict.reason}; lease ${VERIFY_DAEMON_LEASE_KEY}; last heartbeat: ${leaseStatus.heartbeatAt || 'none'}); no marker was written. Start it with launchctl kickstart -k gui/$(id -u)/com.we.verify-daemon, or run node skills-src/conveyor/verify-daemon.mjs (we:skills-src/conveyor/verify-daemon.mjs), then re-run request.`,
    }, 3);
  }
}

if (MODE !== 'run') writeMarker(verifyStartBody({ sha: headSha, suites: GATE, startedAt: new Date().toISOString(), treeHash: currentTreeHash, runId: typeof flags['run-id'] === 'string' ? flags['run-id'] : undefined }));

// #3105 — `request` stops HERE: the marker is stamped, nothing has run yet, and this call already returns
// (`emit` calls `process.exit`). The actual suite run is picked up by `scripts/conveyor/verify-dispatch.mjs`
// (via the verify daemon) on its next tick, which re-invokes THIS file's default `verify` mode — the exact
// code below, unchanged — to completion. This is the only way an interactive agent session may ever bring this
// gate's `running` marker into being: no new marker status, no new gate-decision branch — a `request`-stamped
// marker is indistinguishable from (and handled identically to) an ordinary in-flight `running` one by every
// existing reader (`check`, `pr-land`'s finish-guard, a stranded/abandoned re-run). Checked BEFORE admission
// (below): a request never actually runs the gate itself, so it has no business queuing on the capacity
// semaphore — that cost belongs to whichever `verify-dispatch.mjs` tick actually executes it.
if (MODE === 'request') {
  emit({ sha: headSha, status: 'requested', reason: 'requested', exitCode: null, detail: `verification requested for ${headSha.slice(0, 8)} (suites: ${GATE}) — poll \`node scripts/verify-lane.mjs check\` for the result.` }, 0);
}

// 2. Admission: queue on the #3461 heavy-command capacity semaphore BEFORE running the gate — `check:standards`
//    and `test:unit` (this GATE) are named members of the closed heavy-command set, so this is the invocation-time
//    (never lane-acquire-time) chokepoint the semaphore gates. Fails OPEN on a queuing timeout (proceeds unslotted
//    with a stderr warning) — the residual-risk tradeoff `heavy-admission.mjs`'s own header names.
//
// #4360 — THIS `acquireSlotBlocking` CALL IS THE SOLE ADMISSION CHOKEPOINT FOR THE WHOLE DISPATCH PATH,
// including `scripts/conveyor/verify-dispatch.mjs`'s daemon-side dispatch of several lanes' gates at once. The
// daemon spawns this file as a plain child and lets EACH child queue on this SAME semaphore — it must NEVER
// also acquire a slot itself before spawning, since that would either double-acquire (two slots consumed per
// lane) or stall a child behind a slot its own parent is holding. If a future change ever needs the daemon to
// reason about admission before spawning, that reasoning belongs here, not as a second chokepoint upstream.
const ADMISSION_LOCK_ROOT = admissionLockRoot(REPO, process.env);
const ADMISSION_CAP = resolveCap(process.env);
const ADMISSION_TIMEOUT_MS = resolveTimeoutMs(process.env);
const laneMatch = /lane-(\d+)/.exec(REPO);
const admission = await acquireSlotBlocking({
  lockRoot: ADMISSION_LOCK_ROOT, cap: ADMISSION_CAP, owner: REPO, timeoutMs: ADMISSION_TIMEOUT_MS,
  lane: laneMatch ? laneMatch[1] : null,
  // Card xkyw1x4 — the gate's kind (a diff-driven `selected` run vs a FULL suite) picks its queue lane: a short
  // selected check rides the fast lane and never waits behind a full-suite waiter.
  kind: classifyCommandKind(GATE),
});
if (admission.timedOut) {
  process.stderr.write(`⚠ heavy-command admission: timed out after ${admission.waitedMs}ms waiting for capacity (cap=${ADMISSION_CAP}) — proceeding unslotted.\n`);
} else if (admission.waitedMs > 0) {
  process.stderr.write(`heavy-command admission: acquired slot-${admission.slot} after waiting ${admission.waitedMs}ms (cap=${ADMISSION_CAP}).\n`);
}

// 3. Run the gate in the FOREGROUND, waiting until it exits (forwarded stdio — the agent sees the output live).
// #3383 (Skeptic review, 2026-09-14) — an UNCONDITIONAL marker, unlike the two admission log lines above
// (which only print when there is something to report: a real wait, or a fail-open). This one always fires,
// the instant before the gate itself starts, so a caller watching this process's stderr in real time
// (`verify-dispatch.mjs`'s wall-clock ceiling) has ONE reliable signal for "queuing is over, real gate work
// begins now" — including the common no-contention case (`admission.waitedMs === 0`), where neither line above
// prints anything and a caller would otherwise have no way to tell "just started" from "already deep in the
// gate". Never remove or reword this line without updating `verify-dispatch.mjs`'s own `GATE_STARTED_MARKER`.
// PR #2982 round-2 review — re-sample the tree hash after the admission wait (and again after the gate, below):
// a worker editing while this run queued or ran means the gate did not see the start-of-run tree.
const preGateTreeHash = MODE === 'run' ? null : treeHashNow();
process.stderr.write(`⏱ gate execution starting (suites: ${GATE})\n`);
let exitCode = 0;
let signal = null;
let failureDetails;
let retriedTimeouts = [];
async function runGate(command, args) {
  const collector = createFailureCollector({ cwd: REPO });
  const output = { stdout: '', stderr: '' };
  let bytes = 0;
  // xaipsbs — the gate's own `npm run test:unit` / `check:standards` are wrapped in `heavy-admission.mjs run`;
  // this flag makes those nested wrappers pass through instead of asking for a second slot for the same work.
  const result = await new Promise((resolveGate, reject) => {
    const child = spawn(command, args ?? [], { shell: !args, cwd: REPO, stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env, [ADMISSION_HELD_ENV]: '1' } });
    for (const [name, fd] of [['stdout', 1], ['stderr', 2]]) {
      child[name].setEncoding('utf8');
      child[name].on('data', chunk => {
        collector.push(chunk, name);
        bytes += Buffer.byteLength(chunk);
        if (bytes <= MAX_TIMEOUT_LOG_BYTES) output[name] += chunk;
        // Flush each chunk before the terminal JSON; no pending writable queue can overtake it.
        writeAllSync(fd, chunk);
      });
    }
    child.on('error', reject);
    child.on('close', (code, closeSignal) => resolveGate({ exitCode: Number.isFinite(code) ? code : 2, signal: closeSignal || null }));
  });
  return { ...result, failureDetails: collector.finish(), output: bytes <= MAX_TIMEOUT_LOG_BYTES ? output : null };
}
try {
  const retryableGate = resolvedGate?.testCommand?.startsWith('npx vitest related ');
  let result = await runGate(retryableGate ? resolvedGate.testCommand : GATE);
  if (retryableGate && admission.ok && result.exitCode !== 0 && !verificationInfrastructureFailure(result) && result.output) {
    // Edits during admission or test execution must also count as the change's own files.
    const changedNow = localChangedSet({ runGit: git });
    retriedTimeouts = timeoutRetryFiles({ ...result.output, failureDetails: result.failureDetails,
      changedFiles: changedNow ? [...resolvedGate.decision.changedFiles, ...changedNow.changedFiles] : null, cwd: REPO });
    if (retriedTimeouts.length) {
      process.stderr.write(describeTimeoutRetry(retriedTimeouts).trim() + '\n');
      // Exact file filters, one worker, no related traversal, no passWithNoTests, and no second attempt.
      result = await runGate('npx', ['vitest', 'run', '--maxWorkers=1', '--minWorkers=1', '--no-file-parallelism',
        ...retriedTimeouts.map(file => `./${file}`)]);
    }
  }
  // #3887 — the repo-scanning tests `vitest related` cannot select, scoped to the changed files (each command carries
  // its own VERIFY_SCAN_FILES). Before check:standards, so a scanner failure is reported with the tests.
  if (retryableGate && result.exitCode === 0) {
    for (const scanCommand of resolvedGate.scanCommands ?? []) {
      process.stderr.write(`⏱ repo-scanning tests (scoped to changed files): ${scanCommand.replace(/^VERIFY_SCAN_FILES='[^']*'/, 'VERIFY_SCAN_FILES=<changed files>')}\n`);
      result = await runGate(scanCommand);
      if (result.exitCode !== 0) break;
    }
  }
  if (retryableGate && result.exitCode === 0 && resolvedGate.standardsCommand) {
    result = await runGate(resolvedGate.standardsCommand);
  }
  ({ exitCode, signal, failureDetails } = result);
} catch (e) {
  signal = e?.signal || null;
  exitCode = Number.isFinite(e && e.status) ? e.status : 2;
} finally {
  if (admission.ok) releaseOwnedSlot({ lockRoot: ADMISSION_LOCK_ROOT, cap: ADMISSION_CAP, owner: REPO });
}

const diagnostic = { ...(exitCode === 0 ? {} : { failureDetails }),
  ...(retriedTimeouts.length ? { retriedTimeouts } : {}) };
const retryDetail = describeTimeoutRetry(retriedTimeouts);

const infrastructure = verificationInfrastructureFailure({ exitCode, signal });
if (MODE === 'run' && infrastructure) emit({ sha: headSha, status: 'infrastructure-failure', reason: infrastructure.reason, exitCode, infrastructure, detail: infrastructure.detail }, 3);
if (MODE === 'run') {
  emit({ sha: headSha, status: exitCode === 0 ? 'green' : 'red', reason: 'run', exitCode, ...diagnostic, detail: exitCode === 0 ? 'gate passed (run mode — no marker recorded).' + retryDetail : `gate FAILED (exit ${exitCode}) — run mode, no marker recorded.${retryDetail}` }, exitCode === 0 ? 0 : 2);
}

// 4. Rewrite the marker to its terminal green/red form — for the sha THIS run actually verified.
//    #2833 finding 1: two overlapping verify-lane runs share one clone's marker. The finish write must
//    (a) stamp OUR sha (`headSha`, captured at start) — NOT re-read the on-disk marker's sha, or a slow run
//        finishing at X copies a newer run's sha Y onto its green and publishes a false green for Y; and
//    (b) refuse to overwrite a marker whose sha is not ours — an older/overlapping run must never clobber a
//        newer run's record (compare-and-set on the sha). A slow GREEN run at X must NOT stamp green over a
//        RED record for Y.
const onDisk = readMarker();
if (onDisk && !onDisk.corrupt && onDisk.sha && onDisk.sha !== headSha) {
  emit(
    {
      sha: headSha, status: 'superseded', reason: 'superseded', exitCode,
      detail: `suites finished (exit ${exitCode}) for ${headSha.slice(0, 8)}, but the on-disk marker now belongs to ${String(onDisk.sha).slice(0, 8)} (an overlapping verify-lane run) — refusing to overwrite it; no marker written for this run.`,
    },
    3,
  );
}
// Reuse the on-disk start body's audit fields only when it is OUR run's marker; otherwise synthesize a fresh one.
const startBody = onDisk && !onDisk.corrupt && onDisk.sha === headSha
  ? onDisk
  : verifyStartBody({ sha: headSha, suites: GATE, startedAt: null });
// PR #2982 review — every cache-key field is bound to what THIS run did, never re-read off the shared marker: an
// overlapping `request` (a worker edits, or asks for another `--gate=`, mid-gate) re-stamps the marker with a
// NEWER tree's hash or a different gate command, and inheriting either would record a green nobody verified.
// The tree hash is recorded only if the tree held still from start, through the admission wait, to gate exit.
const finished = verifyFinishBody(startBody, {
  finishedAt: new Date().toISOString(),
  ...diagnostic,
  exitCode, signal, infrastructure,
  sha: headSha,
  suites: GATE,
  treeHash: stableTreeHash(currentTreeHash, preGateTreeHash, treeHashNow()),
});
writeMarker(finished);
if (infrastructure) emit({ sha: headSha, status: finished.status, reason: infrastructure.reason, exitCode, infrastructure, detail: infrastructure.detail }, 3);

emit(
  { sha: headSha, status: finished.status, reason: finished.status, exitCode, ...diagnostic, detail: (finished.status === 'green' ? `suites passed — recorded green for ${headSha.slice(0, 8)} (delivery may proceed).` : `suites FAILED (exit ${exitCode}) — recorded red for ${headSha.slice(0, 8)}; the finish-guard will refuse to land until this is green.`) + retryDetail },
  finished.status === 'green' ? 0 : 2,
);
