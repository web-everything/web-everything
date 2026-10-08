#!/usr/bin/env node
/**
 * @file scripts/conveyor/build-dispatch-orphan-adopt.mjs
 * @description build-orphan-adopt (#4131/#4382 fix) — ADOPTS a build-dispatch claim whose owning detached
 * delivery wrapper died before it could settle its own run-store effect or release/hold its claim.
 *
 * THE GAP THIS CLOSES. A `build` dispatch's actual work — the agent turn, the gate, the converge round, the
 * PR open — runs in `deliver-item-run.mjs`, spawned DETACHED (`setsid` + `.unref()`,
 * `scripts/operations/detached-dispatch.mjs#defaultSpawnDetached`) precisely so it survives the dispatching
 * daemon restarting (`skills-src/conveyor/build-dispatch-daemon.mjs`'s own self-rebuilding clone —
 * `scripts/lib/daemon-rebuild.mjs`, which `git reset --hard`s that clone's tree every time an imported file
 * moves, gated by a lock the daemon's SYNCHRONOUS tick holds only for the few milliseconds it takes to spawn
 * that detached child, never for the up-to-an-hour the child itself then runs). The build-dispatch CLAIM
 * (`build-dispatch-claim.mjs`) is a SEPARATE lock, owned by the DAEMON's own pid (never the wrapper's — "PID
 * liveness is never used" for it, by explicit design: a daemon restart is expected, and the build it started
 * is still running).
 *
 * That design is correct as long as the detached wrapper itself stays alive. When it does not — a hard kill
 * (an operator's `pkill` that reaches a `setsid`'d descendant by matching its own argv/cwd, a machine
 * restart, a crash outside its own `try`/`catch`) — NOTHING today ever notices. `wake.mjs`'s liveness-only
 * observer answers only `unresolved` for a dead `pid:` handle (it never reads the wrapper's own known
 * outcome); only the wrapper's OWN exit path (`deliver-item-settle.mjs`, called from inside
 * `deliver-item-wrapper.mjs#deliverItem`'s own `finally`/`catch`) ever settles the run-store effect or
 * releases/holds the claim. `build-dispatch-daemon.mjs#doneWhy` retires a claim on exactly three signals — a
 * PR delivering the item, the item leaving the tick core's cleared queue, or a run-store row SETTLED to a
 * non-PR outcome — and a wrapper that died before any of those three became true leaves the claim
 * PERMANENTLY "in flight", occupying a builder slot, with the agent's own finished work (a real commit,
 * already in the lane) simply abandoned.
 *
 * FOUR REAL SHAPES, all confirmed live (2026-09-29):
 *   - a detached wrapper killed mid-flight, leaving a real `in-flight` run-store row with a `pid:` handle the
 *     kernel now confirms dead;
 *   - the wrapper reached its LAST step and settled `applied` as `{outcome: 'pr-opened', pr: null}` — the PR
 *     number came back empty (a separate, real bug in `openPr()`/`extractSubmitResult`, not fixed here), and
 *     `doneWhy` deliberately never revisits a `pr-opened` settle, so with no real PR ever opening nothing
 *     retires the claim (#4131's own exact shape);
 *   - killed so early the dispatch never even reached `in-flight` — NO run-store row exists at all, and only
 *     the claim's own dead OWNER pid (the dispatching daemon's pid at claim time) says anything (#4382's own
 *     exact shape);
 *   - a claim aged out of the ORDINARY (TTL-filtered) claim read while the daemon was down for hours on an
 *     unrelated bug — invisible to both retirement and adoption until this pass reads past its TTL too.
 *
 * THE FIX CHOSEN (of the two the card offered): DAEMON-SIDE ADOPTION, not hardening the detached spawn
 * against every possible kill vector. Every tick, for each build claim whose dispatch is confirmed DEAD:
 *   - RESUME — the prior attempt's own delivery report says `done`, names THIS item, was written at or after
 *     this dispatch started, and the lane is STILL, CURRENTLY leased under the exact matching session with a
 *     commit ahead of its base whose changed files are all ones the report claims: spawn ONE fresh, detached
 *     `deliver-item-run.mjs --resume` process, reusing the SAME lane and session slug, which
 *     `deliver-item-wrapper.mjs#runAgentToCompletion`'s own `resume` branch reads straight through to
 *     gate → converge → PR — never a rebuild, never a second agent turn. A resume marker, BOUND to the exact
 *     run-store row it resumes, records the attempt's own pid so a later tick neither races a second resume
 *     while the first is genuinely still running nor mistakes an older attempt's leftover marker for this
 *     one; a resume that keeps dying without settling anything is capped (`MAX_RESUME_ATTEMPTS`) and released
 *     WITH a hold instead of respawned forever.
 *   - RELEASE — nothing resumable: release the claim outright, with NO hold, so the very next tick can offer
 *     the item for a completely fresh dispatch — a hold is for a known, recurring failure reason; "the prior
 *     attempt's own evidence is gone or belongs to someone else now" is not one.
 *   - LEAVE — the dispatch (or its resume) is confirmed alive, kill-switch/landing-freeze holds a resumable
 *     claim for a later tick, or there is simply no evidence at all yet to judge by (too early — the ordinary
 *     claim/hold machinery already covers that case).
 *
 * OUT OF SCOPE, STATED RATHER THAN GUESSED AT (mirrors this codebase's own convention, e.g.
 * `build-dispatch-claim.mjs#releaseBuildDispatchClaim`'s own docblock): re-attaching to a delivery agent
 * whose WRAPPER died but whose own CLI process (the `claude`/`codex` child `provider.spawn` started) is
 * somehow still running. Nothing today durably records the inner agent's own pid or CLI session id separately
 * from the wrapper's `pid:` handle, so this module cannot tell that case apart from "the agent never finished"
 * — it classifies as RELEASE. The residual risk (a still-running orphaned agent later committing into a lane
 * a fresh dispatch has since reclaimed) is bounded by the EXISTING `guard-lane.mjs` foreign-session Edit/Write
 * refusal, not solved here.
 *
 * PURE CORE / IO SHELL, the same split as `build-dispatch-daemon.mjs`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readGit } from '../lib/proc-read.mjs';
import { readBuildDelivery } from './build-delivery-evidence.mjs';
import { makeAwaitingVerifyResolver } from './await-verify.mjs';
import { normNum } from './queue-store.mjs';
import { DISPATCH_EFFECT } from '../operations/dispatch-lane.mjs';
// Through the REGISTRY, never `dispatch-providers/build.mjs` directly: `detached-dispatch.mjs` imports the
// registry, which imports `build.mjs` — entering that cycle at `build.mjs` (or at `detached-dispatch.mjs` first)
// leaves the registry reading `DELIVER_ITEM_RUN_SCRIPT` in its TDZ at load. The registry is the cycle's own
// entry point; the run script is read from it at CALL time.
import { dispatchProviderEntry } from '../operations/dispatch-provider-registry.mjs';
import { createFileRunStore } from '../operations/run-store.mjs';
import { resolveInFlight } from '../operations/effect-executor.mjs';
import { resolveLanePath, laneHasCommitAhead, run } from '../operations/minimal-context-provider.mjs';
import { tryReadDeliveryReport, resolveDeliveryReportsDir } from '../operations/delivery-report-store.mjs';
import {
  REPO_ROOT, defaultIsPidAlive, defaultSpawnDetached, deliveryDispatchLogPath, detachedHandlePid,
} from '../operations/detached-dispatch.mjs';
import {
  listBuildDispatchClaims, releaseBuildDispatchClaim, placeBuildDispatchHold,
  markBuildDispatchResume, readBuildDispatchResume, releaseBuildDispatchResume,
} from './build-dispatch-claim.mjs';

// ── PURE CORE ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The newest `build` dispatch effect for `num`, across every run-store record `runs` holds — ANY status, not
 * only `in-flight`. "Newest by `startedAt`" mirrors `build-dispatch-daemon.mjs#doneWhy`'s own "newest attempt
 * per item wins" rule.
 *
 * WHY NOT `in-flight`-ONLY (the first cut of this module, live incident 2026-09-29): #4131's own run-store row
 * was `applied`, settled by the wrapper's own exit path as `{outcome: 'pr-opened', pr: null}` — the wrapper
 * genuinely reached its last step and BELIEVED it opened a PR, but the PR number came back empty (a separate,
 * real bug in `openPr()`/`extractSubmitResult`, not fixed here). `build-dispatch-daemon.mjs#doneWhy`
 * deliberately never retires a claim on a `pr-opened` settle alone — "an open PR can still be closed/superseded
 * before it merges; the PR-observed path already owns that" — so when no PR actually exists under that number,
 * NOTHING ever retires the claim: not `doneWhy` (defers to a PR that isn't there), and not the OLD version of
 * this module either (it only ever looked at `in-flight` rows, and this one had already settled). Returning
 * every status here, and letting {@link classifyClaimLiveness} read `result.outcome`/`result.pr` for a settled
 * row, is what closes that gap.
 * @param {Array<{id: string, record: {effects?: Array<object>}}>} runs
 * @param {string|number} num
 * @returns {{runId: string, entry: object}|null}
 */
export function findLatestBuildRow(runs, num) {
  const n = normNum(num);
  let best = null;
  for (const run of runs) {
    for (const e of run?.record?.effects || []) {
      if (e?.type !== DISPATCH_EFFECT || e?.payload?.launchKind !== 'build') continue;
      if (normNum(e?.payload?.num) !== n) continue;
      const startedAt = typeof e.startedAt === 'string' ? e.startedAt : '';
      if (!best || startedAt > best.startedAt) best = { runId: run.id, entry: e, startedAt };
    }
  }
  return best ? { runId: best.runId, entry: best.entry } : null;
}

/** Back-compat alias — the pre-2026-09-29 name, kept for any caller (this file's own orchestrator included)
 *  that still spells it this way; it is the SAME any-status lookup, never the old in-flight-only one. */
export const findLatestInFlightBuildRow = findLatestBuildRow;

/** How many resumes one dispatch row gets before the pass stops respawning and releases with a hold instead
 *  (PR #2921 review). A resume that keeps dying without settling anything is a recurring failure, not bad luck —
 *  exactly what a hold is for. */
export const MAX_RESUME_ATTEMPTS = 3;

/** How long a PENDING resume marker (written just before the spawn, no pid yet) reads as "a resume is being
 *  started". Far longer than a spawn takes. Past it, a pending marker is UNCONFIRMED — the daemon may have died
 *  after spawning but before recording the pid, so a resume may be running that nothing can probe. It is left
 *  alone until the marker's own TTL lapses, never respawned: a second resume racing a live one on the same lane
 *  is worse than a claim held a little longer. (A spawn that THREW is known not to be running and is recorded
 *  as `spawnFailed`, which reads dead at once.) */
export const RESUME_SPAWN_GRACE_MS = 5 * 60_000;

/** Does this resume marker belong to THIS dispatch row? A marker carries the `runId`/`rowKey` it resumed; one
 *  bound to any other row (an older attempt of the same item) — or bound to nothing at all — never answers the
 *  liveness question for `row`. PURE. */
export function resumeMarkerBindsRow(marker, row) {
  const meta = marker?.meta || {};
  if (!marker || !row || !meta.runId || !meta.rowKey) return false;
  return meta.runId === row.runId && meta.rowKey === row.entry?.key;
}

/**
 * Is this claim's own dispatch confirmed DEAD — by the kernel wherever a pid handle exists to ask, or by
 * inference where none does? PURE over injected `isPidAlive`.
 *
 * FIVE SHAPES, in priority order:
 *   1. No row at all (nothing was ever found in the run store for this claim) — the ONLY liveness signal left
 *      is the CLAIM's own recorded owner pid (`ownerPid`, the dispatching daemon's pid at claim time): dead →
 *      DEAD (#4382's own exact shape — nobody is watching this claim at all); alive → `no-record` (the claim
 *      may simply have been taken a moment ago, its own bookkeeping not yet written).
 *   2. A resume marker BOUND to this row (a prior adoption already under way — see {@link resumeMarkerBindsRow})
 *      takes precedence over the row's own handle: once a resume has been spawned, its own pid is the one
 *      liveness question that matters — the original row's dead pid is expected and no longer news. A bound
 *      marker with no pid yet is PENDING: `alive` inside {@link RESUME_SPAWN_GRACE_MS}, `unconfirmed` after it
 *      (left alone, never respawned); one recorded `spawnFailed` is `dead` at once. A marker bound to a
 *      DIFFERENT row is stale and ignored entirely (the caller clears it) — this function never even sees it.
 *   3. A row whose status is a SETTLED terminal (`applied`/`failed`) with a NON-`pr-opened` outcome — this is
 *      `doneWhy`'s own job (a PR/queue/settle signal it already reads); reported `'settled-elsewhere'` so the
 *      caller leaves it alone rather than fighting over the same claim.
 *   4. A row settled `applied` with `outcome === 'pr-opened'` but NO confirmed real PR (`result.pr` falsy) —
 *      the exact #4131 shape (see {@link findLatestBuildRow}'s own docblock): treated as DEAD, since nothing
 *      is actually delivered and nothing else will ever revisit it.
 *   5. Anything else: a `pid:` handle (an `in-flight` row, most commonly) — the kernel decides — or NO handle
 *      at all (a row stuck `declared`/`pending`, killed before ever going `in-flight`), which falls back to the
 *      claim's own owner pid exactly like shape 1.
 *
 * @param {{row: {runId:string, entry:object}|null, resumeMarker: {meta?:object}|null, ownerPid?: number|null,
 *   isPidAlive?: Function, nowMs?: number}} o
 * @returns {{status: 'alive'|'dead'|'unconfirmed'|'no-record'|'settled-elsewhere',
 *   row: {runId:string, entry:object}|null, marker: object|null}}
 */
export function classifyClaimLiveness({
  row: foundRow, resumeMarker, ownerPid = null, isPidAlive = defaultIsPidAlive, nowMs = Date.now(), claimedAt = null,
  sessionLive = null,
}) {
  // A run row that STARTED BEFORE this claim was taken is an older attempt's leftover, never this claim's own
  // dispatch (same rule as `build-dispatch-daemon.mjs#doneWhy`'s claimedAt guard). Live incident 2026-10-06:
  // #4688's claim (18:59Z, daemon pid dead before its dispatch wrote any run row) was classified from the
  // 18:10Z attempt's settled row -> `settled-elsewhere` -> left for the full 240-min TTL, pinning the Claude
  // build slot (cap 1) so every Claude build held `cap` for hours. A predating row reads as NO row: the
  // claim's own owner pid decides.
  const stale = !!foundRow && typeof claimedAt === 'string' && claimedAt !== ''
    && typeof foundRow.entry?.startedAt === 'string' && foundRow.entry.startedAt !== '' && foundRow.entry.startedAt < claimedAt;
  const row = stale ? null : foundRow;
  const byOwnerPid = () => (Number.isInteger(ownerPid) && ownerPid > 0
    ? { status: isPidAlive(ownerPid) ? 'no-record' : 'dead', row, marker: null }
    : { status: 'no-record', row, marker: null });

  if (!row) return byOwnerPid();

  if (resumeMarkerBindsRow(resumeMarker, row)) {
    const marker = resumeMarker;
    const pid = Number(marker.meta?.pid);
    if (Number.isInteger(pid) && pid > 0) return { status: isPidAlive(pid) ? 'alive' : 'dead', row, marker };
    if (marker.meta?.spawnFailed) return { status: 'dead', row, marker };
    const at = Date.parse(marker.meta?.resumedAt || '');
    const pending = Number.isFinite(at) && nowMs - at < RESUME_SPAWN_GRACE_MS;
    return { status: pending ? 'alive' : 'unconfirmed', row, marker };
  }

  const entry = row.entry;
  if (entry && (entry.status === 'applied' || entry.status === 'failed')) {
    const outcome = entry.result?.outcome ?? null;
    if (outcome !== 'pr-opened') return { status: 'settled-elsewhere', row, marker: null };
    if (entry.result?.pr) return { status: 'settled-elsewhere', row, marker: null }; // a REAL pr — doneWhy's own PR-observed path owns it.
    return { status: 'dead', row, marker: null }; // pr-opened, but no confirmed pr — nothing was actually delivered.
  }

  const pid = detachedHandlePid(entry?.handle);
  if (pid == null) {
    // xykwe0h — a `claude --bg` build's handle is a SESSION id, never a pid, and the claim's owner pid is the
    // short-lived dispatching process: reading either as "dead" released every Claude build. The session's own
    // job record (still working, or paused awaiting a verify verdict) is the evidence that counts.
    if (sessionLive?.alive) return { status: 'alive', row, marker: null, reason: sessionLive.reason ?? 'session-live' };
    return byOwnerPid(); // no handle to probe — same fallback as "no row at all".
  }
  return { status: isPidAlive(pid) ? 'alive' : 'dead', row, marker: null };
}

/** Decide what to do with a DEAD claim. PURE. Never called for a `liveness.status !== 'dead'` claim — the
 *  caller leaves those alone before this is reached.
 *  - not resumable → `release` (no hold — the evidence is simply gone);
 *  - resumable but `attempts` already spent → `exhausted` (release + HOLD — the resume itself keeps dying);
 *  - resumable while `allowResume` is false (kill switch / landing freeze) → `leave` for a later tick;
 *  - otherwise → `resume`. */
export function decideOrphanAction({ resumable, attempts = 0, maxAttempts = MAX_RESUME_ATTEMPTS, allowResume = true, frozenReason = '' }) {
  if (!resumable) return { action: 'release', reason: 'dead wrapper — nothing resumable (no report, no lane, or no surviving commit)' };
  if (attempts >= maxAttempts) return { action: 'exhausted', reason: `dead wrapper — ${attempts} resume attempt(s) already died; releasing with a hold` };
  if (!allowResume) return { action: 'leave', reason: `resumable, but resume frozen${frozenReason ? ` (${frozenReason})` : ''}` };
  return { action: 'resume', reason: 'dead wrapper — resumable done report + lane commit found' };
}

// ── IO SHELL ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Every `dispatch-lane-*` run-store record readable right now, `{id, record}`. Unreadable/missing runs are
 *  skipped, never thrown — the same defensive posture `build-dispatch-daemon.mjs`'s own `cliListRunStoreInFlight`/
 *  `cliListSettledBuilds` already use. */
function listAllRuns(store) {
  let ids = [];
  try { ids = store.list().filter((id) => id.startsWith('dispatch-lane')); } catch { return []; }
  const out = [];
  for (const id of ids) {
    try { out.push({ id, record: store.read(id) }); } catch { /* skip unreadable */ }
  }
  return out;
}

/** The `session` currently leasing lane `lane`, or `null` — reads the SAME `lane-pool.mjs status --json`
 *  every other lane-aware caller in this codebase shells (`resolveLanePath`'s own sibling read). Never throws:
 *  an unreadable status is `null` (no evidence of a current lease), the fail-closed direction for
 *  {@link checkResumable}'s own safety check below. */
export function defaultCurrentLaneSession(lane, { run: runFn = run } = {}) {
  try {
    const out = runFn('node', ['scripts/lane-pool.mjs', 'status', '--json', `--lane=${lane}`, '--leased-only']);
    const parsed = JSON.parse(out);
    const rows = Array.isArray(parsed.lanes) ? parsed.lanes : [];
    const found = rows.find((r) => Number(r.lane) === Number(lane));
    return found?.lease?.session ?? null;
  } catch {
    return null;
  }
}

/** Every file the lane's commits add or modify against `base` (merge-base diff), or `null` when git cannot tell.
 *  Deletions are left out (`--diff-filter=d`) — an agent rarely lists a file it removed — and paths are never
 *  quoted (`core.quotePath=false`), so they compare as plain text. */
export function defaultListLaneChangedFiles({ lane, base = 'origin/main' }) {
  try {
    const out = readGit(['-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=d', `${base}...HEAD`], {
      cwd: lane, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

/** A `filesTouched` entry as a plain repo-relative path: drops a leading `./` and a `we:`-style locus prefix. */
function plainPath(p) {
  return String(p).trim().replace(/^[a-z][a-z0-9-]*:/i, '').replace(/^\.\//, '');
}

/** Paths the WRAPPER itself commits into the lane, never the agent: the item's own backlog card (`claimItem`
 *  sets `status: active` on it inside the lane, and the build commit picks that edit up). */
function isWrapperOwnedPath(path, num) {
  return num != null && new RegExp(`^backlog/${String(normNum(num)).replace(/[^a-z0-9]/gi, '')}-[^/]*\\.md$`, 'i').test(path);
}

/** Does `scope` name any repo other than `we`? Such a build works in ITS OWN repo's lane, not `payload.lane`. */
function scopeLeavesWe(scope) {
  const entries = Array.isArray(scope) ? scope : String(scope ?? '').split(',');
  return entries.some((s) => {
    const m = /^([a-z][a-z0-9-]*):/i.exec(String(s).trim());
    return m && m[1].toLowerCase() !== 'we';
  });
}

/**
 * Is `{lane, sessionSlug}`'s prior attempt resumable? Every check is required — see this file's own header
 * for why a report or a commit alone is not enough evidence.
 *
 *   0. (build-orphan-adopt safety fix, live 2026-09-29) The lane is STILL, CURRENTLY leased under this exact
 *      session. A lane number is a SHARED, reused resource (`lane-pool.mjs`'s own pool) — once a lease moves
 *      on (released, or handed to a completely different dispatch), whatever git state sits in that lane
 *      belongs to WHOEVER holds it now, never to the attempt this claim remembers. Live incident: #4131's own
 *      lane (8) was recycled twice (once for a later item's build, once for unrelated investigation work) in
 *      the hours between its wrapper settling and this fix landing — trusting "lane 8 has a commit ahead of
 *      main" without this check would have resumed from a COMPLETELY UNRELATED occupant's in-progress work.
 *      Checked FIRST (after the cheap scope check), before any other git read, so a moved-on lease never even
 *      reaches one.
 *   1. `scope` never leaves `we` — such a build works in its own repo's own lane, which this row does not
 *      record (released, rebuilt fresh, rather than guessed at).
 *   2. A `done` delivery report exists for `sessionSlug`, naming THIS item, written at or after this dispatch
 *      row started (never an older attempt's leftover) (PR #2921 review).
 *   3. The lane still holds a commit ahead of its delivery base (`origin/main`, never the local `main` — a
 *      pool lane's own working branch IS its local `main`).
 *   4. Every file the lane's commits (against that same base) touch is one the report's own `filesTouched`
 *      names — the item's own backlog card excepted (the wrapper, not the agent, edits it). A foreign file
 *      means a lane reused by someone else (or a report that under-lists its own work); either way, "not
 *      resumable" is the safe side (PR #2921 review).
 * @returns {{resumable: boolean, reason: string, lanePath?: string}}
 */
export function checkResumable({
  lane, sessionSlug, num = null, rowStartedAt = null, scope = null, base = 'origin/main', resolveLane = resolveLanePath,
  readReport = tryReadDeliveryReport, resolveReportsDir = resolveDeliveryReportsDir,
  isLaneCommitAhead = laneHasCommitAhead, listLaneChangedFiles = defaultListLaneChangedFiles,
  currentLaneSession = defaultCurrentLaneSession,
} = {}) {
  if (!lane || !sessionSlug) return { resumable: false, reason: 'no-lane-or-session' };
  if (scopeLeavesWe(scope)) return { resumable: false, reason: 'non-we-locus' };
  let leaseSession;
  try { leaseSession = currentLaneSession(lane); } catch { leaseSession = null; }
  if (leaseSession !== sessionSlug) return { resumable: false, reason: 'lane-lease-moved-on' };
  let lanePath;
  try { lanePath = resolveLane(lane); } catch { lanePath = null; }
  if (!lanePath) return { resumable: false, reason: 'lane-path-unresolved' };
  const report = readReport(sessionSlug, resolveReportsDir(lanePath));
  if (!report || report.status !== 'done') return { resumable: false, reason: 'no-done-report', lanePath };
  if (num != null && normNum(report.item) !== normNum(num)) return { resumable: false, reason: 'report-item-mismatch', lanePath };
  if (typeof rowStartedAt === 'string' && rowStartedAt !== ''
    && !(typeof report.updatedAt === 'string' && report.updatedAt >= rowStartedAt)) {
    return { resumable: false, reason: 'report-predates-dispatch', lanePath };
  }
  if (!isLaneCommitAhead({ lane: lanePath, base })) return { resumable: false, reason: 'no-commit-ahead', lanePath };
  const changed = listLaneChangedFiles({ lane: lanePath, base });
  if (!Array.isArray(changed)) return { resumable: false, reason: 'lane-diff-unreadable', lanePath };
  const claimed = new Set((report.filesTouched || []).map(plainPath));
  if (claimed.size === 0) return { resumable: false, reason: 'report-lists-no-files', lanePath };
  const foreign = changed.map(plainPath).filter((f) => !claimed.has(f) && !isWrapperOwnedPath(f, num));
  if (foreign.length > 0) return { resumable: false, reason: 'lane-commits-not-this-item', lanePath };
  return { resumable: true, lanePath };
}

/** Job states of a `claude --bg` session that mean it is running. ONLY these ever read as alive (and only while fresh). */
const ACTIVE_JOB_STATES = new Set(['working', 'running', 'idle', 'blocked']); // `blocked`: a live session (session-reaper.mjs documents it)
/** Job states that mean it is finished. A state in neither set is UNKNOWN, never alive. */
const TERMINAL_JOB_STATES = new Set(['done', 'stopped', 'failed', 'error', 'cancelled', 'killed']);
/**
 * An active job record untouched for this long belongs to a session that crashed or died with the host (its
 * `state.json` still says `working`). Longer than lane-whois's 10-minute worker window on purpose: a foreground
 * gate command legitimately runs up to 10 minutes without a record update, and mistaking that for death is the
 * very relaunch bug this module exists to stop. A session parked on an await-verify record is judged by that
 * record instead, not by this clock.
 */
export const SESSION_ACTIVE_WINDOW_MS = 30 * 60_000;
/** An `updatedAt` further in the future than this is not a clock wobble but a bad record. */
const SESSION_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Is the `claude --bg` session behind `handle` still alive, or paused awaiting its verify verdict? Reads the
 * harness's own job record (`~/.claude/jobs/<id>/state.json`, matched by the handle's id prefix).
 *   - an explicitly active state (`working`/`running`/`idle`) whose record updated within
 *     {@link SESSION_ACTIVE_WINDOW_MS} is alive;
 *   - a terminal state, or an active one gone stale, is alive ONLY while a live await-verify record parks that
 *     session (it ended its turn on purpose to wait for a verdict), else it is not alive;
 *   - a missing/empty/unrecognized state, or an active state with no readable `updatedAt`, is UNKNOWN (null):
 *     never proof of life. The caller then falls back to the claim's owner pid.
 * Never throws.
 * @returns {{alive: boolean, reason?: string}|null}
 */
export function defaultSessionLiveness({ handle, num = null, jobsDir = join(homedir(), '.claude', 'jobs'), readdir = readdirSync, readFile = readFileSync, awaitingFor = makeAwaitingVerifyResolver(), now = Date.now } = {}) {
  try {
    const id = String(handle ?? '');
    if (!/^[0-9a-f]{6,}/i.test(id)) return null;
    const dir = readdir(jobsDir).find((d) => d.startsWith(id));
    if (!dir) return null;
    const state = JSON.parse(String(readFile(join(jobsDir, dir, 'state.json'), 'utf8')));
    const name = String(state?.state ?? '').trim().toLowerCase();
    const active = ACTIVE_JOB_STATES.has(name);
    if (!active && !TERMINAL_JOB_STATES.has(name)) return null;
    let stale = false;
    if (active) {
      // Only a full ISO timestamp counts (Date.parse alone reads "0" as the year 2000), and one in the future is
      // clock skew or a corrupt record, never proof of life: both are UNKNOWN.
      const raw = String(state?.updatedAt ?? '');
      const updated = /^\d{4}-\d{2}-\d{2}T/.test(raw) ? Date.parse(raw) : NaN;
      const age = now() - updated;
      if (!Number.isFinite(age) || age < -SESSION_CLOCK_SKEW_MS) return null;
      if (age <= SESSION_ACTIVE_WINDOW_MS) return { alive: true, reason: `session-${name}` };
      stale = true;
    }
    const awaiting = awaitingFor({ sessionId: state?.sessionId ?? null, name: state?.name ?? (num != null ? `conveyor-${num}` : null), cwd: state?.cwd });
    if (awaiting?.awaiting === true) return { alive: true, reason: 'awaiting-verify' };
    return { alive: false, reason: stale ? 'session-stale' : 'session-ended' };
  } catch { return null; }
}

/** Settle a run-store row with the build's REAL outcome (a PR, a merge, a resolved card), never `orphan-released`.
 *  Only touches a row still `in-flight`; best-effort, like {@link settleOrphanRow}. */
export function settleDeliveredRow({ runId, key, delivery }, store = createFileRunStore()) {
  if (!runId || !key || !delivery?.outcome) return;
  try {
    const run = store.read(runId);
    if (!run) return;
    const entry = (run.effects || []).find((e) => e.key === key);
    if (!entry || entry.status !== 'in-flight') return;
    const outcome = delivery.outcome === 'pr-open' ? 'pr-opened' : delivery.outcome;
    store.write(resolveInFlight(run, key, { status: 'applied', result: { outcome, pr: delivery.pr ?? null } }));
  } catch { /* best-effort — never mask the release this settles alongside */ }
}

/** Best-effort: mark a stale, dead-wrapper run-store row settled (`failed`, with `outcome`) so it is never read
 *  as "still in flight" again. Never touched on the RESUME path — the resumed wrapper settles the row itself
 *  (it is handed `--run-id`/`--effect-key`). A no-op when `row` gave no `runId`/`key` at all (the #4382 shape —
 *  nothing was ever found to settle). */
export function settleOrphanRow({ runId, key, outcome = 'orphan-released' }, store = createFileRunStore()) {
  if (!runId || !key) return;
  try {
    const run = store.read(runId);
    if (!run) return;
    const entry = (run.effects || []).find((e) => e.key === key);
    if (!entry || entry.status !== 'in-flight') return;
    const next = resolveInFlight(run, key, {
      status: 'failed',
      result: { outcome },
      error: `build-dispatch-orphan-adopt: dispatch retired (${outcome})`,
    });
    store.write(next);
  } catch { /* best-effort — never mask the release this settles alongside */ }
}

/** Spawn ONE fresh, detached resume process for `num` — the SAME shape
 *  `dispatch-providers/build.mjs#deliverItemDetachedProvider` uses for a fresh dispatch, plus `--resume` and
 *  minus a fresh attempt tag (a resume is not a new attempt at building; it continues the one that already
 *  finished). `runId`/`effectKey` name the ORIGINAL dispatch row, so the resumed wrapper settles that row on
 *  exit instead of leaving it in-flight forever (PR #2921 review). Returns the spawned pid. */
export function spawnResumeDelivery({ num, lane, scope, sessionSlug, runId = null, effectKey = null }, { spawnDetached = defaultSpawnDetached, logPathFor = deliveryDispatchLogPath } = {}) {
  const argv = [
    String(dispatchProviderEntry('build').runScript),
    `--num=${num}`, `--lane=${lane}`, `--session=${sessionSlug}`, `--scope=${String(scope ?? '')}`, '--resume',
    ...(runId && effectKey ? [`--run-id=${runId}`, `--effect-key=${effectKey}`] : []),
  ];
  const child = spawnDetached(argv, { cwd: REPO_ROOT, logPath: logPathFor(sessionSlug) });
  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`build-dispatch-orphan-adopt: resume spawn for #${num} reported no pid — whether it is running cannot be told from here`);
  }
  return pid;
}

/**
 * ONE PASS over every live `build` claim: adopt every one whose recorded dispatch is confirmed dead, leave
 * every other one untouched. Every effect is injected — see the parameter defaults for what each does; a live
 * daemon tick calls this with no arguments at all.
 *
 * HARDENING (PR #2921 review, plus this fix's own two live shapes):
 *   - `listClaims` reads PAST the claim's own TTL by default (`ignoreExpiry: true`) — a claim aging out of the
 *     ordinary read while the daemon was down for hours is not evidence anything resolved itself; this pass's
 *     own positive liveness evidence (a kernel pid probe, a settled outcome, the claim's own owner pid) is what
 *     decides, never a clock.
 *   - the claim's own OWNER pid (`ownerPid`, from `claim.pid`) is the liveness fallback whenever no run-store
 *     row (or no handle within one) exists to answer instead — closes the exact #4382 shape.
 *   - `allowResume: false` (the daemon passes it while its kill switch or a landing freeze is on) never spawns
 *     a resume — a resumable claim is left for a later tick. Releasing a dead, non-resumable claim is
 *     bookkeeping, not new work, so it still happens.
 *   - the run store is read ONCE per pass (`listRuns`), never once per claim.
 *   - one claim that throws is reported as `action: 'error'` and never stops the claims after it.
 *   - the resume marker is written PENDING before the spawn and completed with the pid after it, bound to the
 *     row it resumes, counting attempts — see {@link markBuildDispatchResume} and {@link decideOrphanAction}.
 *
 * @returns {Promise<Array<{num: string, action: 'leave'|'resume'|'release'|'settled'|'exhausted'|'error', reason: string, pid?: number}>>}
 */
export async function adoptOrphanedBuildClaims({
  allowResume = true,
  frozenReason = '',
  maxAttempts = MAX_RESUME_ATTEMPTS,
  now = () => Date.now(),
  // #4131 (live 2026-09-29) — see this function's own docblock: a claim's TTL is a dead-holder floor, not
  // evidence the underlying problem resolved itself.
  listClaims = () => listBuildDispatchClaims({ ignoreExpiry: true }),
  isPidAlive = defaultIsPidAlive,
  listRuns = () => listAllRuns(createFileRunStore()),
  findRow = (num, runs) => findLatestBuildRow(runs(), num),
  readResumeMarker = (num) => readBuildDispatchResume({ num }),
  resolveResumability = (o) => checkResumable(o),
  releaseClaim = ({ num }) => releaseBuildDispatchClaim({ num }),
  releaseResumeMarker = ({ num }) => releaseBuildDispatchResume({ num }),
  settleRow = (o) => settleOrphanRow(o),
  placeHold = ({ num, reason }) => placeBuildDispatchHold({ num, reason }),
  spawnResume = (o) => spawnResumeDelivery(o),
  markResume = (o) => markBuildDispatchResume(o),
  // xykwe0h — real-outcome evidence (a PR on the card's branch, or a resolved card) and session liveness.
  readDelivery = (num) => readBuildDelivery(num),
  settleDelivered = (o) => settleDeliveredRow(o),
  sessionLivenessFor = (o) => defaultSessionLiveness(o),
} = {}) {
  let runsCache = null;
  const runs = () => (runsCache ??= listRuns());
  const clearMarker = (num) => { try { releaseResumeMarker({ num }); } catch { /* best-effort — see build-dispatch-claim.mjs's own posture */ } };
  const results = [];
  for (const claim of listClaims()) {
    if (claim.meta?.kind !== 'build') continue;
    const num = normNum(claim.meta?.num);
    try {
      const foundRow = findRow(num, runs);
      const resumeMarker = readResumeMarker(num);
      const ownerPid = Number.isInteger(claim.pid) ? claim.pid : null;
      const handle = foundRow?.entry?.handle;
      const sessionLive = foundRow && detachedHandlePid(handle) == null && handle ? sessionLivenessFor({ handle: String(handle), num }) : null;
      const liveness = classifyClaimLiveness({ row: foundRow, resumeMarker, ownerPid, isPidAlive, nowMs: now(), claimedAt: claim.meta?.claimedAt ?? null, sessionLive });
      const row = liveness.row; // null when the found row predates this claim
      // A marker bound to some OLDER row (or to none at all) is stale — it must never answer for this claim
      // again.
      if (resumeMarker && !liveness.marker) clearMarker(num);
      if (liveness.status !== 'dead') { results.push({ num, action: 'leave', reason: liveness.reason ? `${liveness.status} (${liveness.reason})` : liveness.status }); continue; }
      // xykwe0h — a dead dispatch whose card was in fact DELIVERED (its session opened a PR, the PR merged, or the
      // card is resolved) settles as that real outcome. It is neither resumed nor called `orphan-released`.
      const delivery = readDelivery(num);
      if (delivery?.outcome) {
        releaseClaim({ num });
        clearMarker(num);
        settleDelivered({ runId: liveness.row?.runId, key: liveness.row?.entry?.key, delivery });
        results.push({ num, action: 'settled', reason: `${delivery.outcome}: ${delivery.reason}` });
        continue;
      }
      // `row` may be null here (no run-store trace was ever found — #4382's own shape: killed before it ever
      // reached `in-flight`) — there is nothing to resume FROM in that case (no lane, no sessionSlug), so
      // resumability resolves to `no-lane-or-session` and this always falls straight to RELEASE.
      const payload = row?.entry?.payload || {};
      const attempts = Number(liveness.marker?.meta?.attempts) || 0;
      const resumability = resolveResumability({
        num, lane: payload.lane, sessionSlug: payload.sessionSlug, scope: payload.scope ?? null,
        rowStartedAt: row?.entry?.startedAt ?? null,
      });
      const decision = decideOrphanAction({ resumable: resumability.resumable, attempts, maxAttempts, allowResume, frozenReason });
      if (decision.action === 'leave') {
        results.push({ num, action: 'leave', reason: decision.reason });
      } else if (decision.action === 'resume') {
        const binding = { runId: row.runId, rowKey: row.entry?.key, attempts: attempts + 1 };
        markResume({ num, pid: null, ...binding });
        let pid;
        try {
          pid = spawnResume({
            num, lane: payload.lane, scope: payload.scope, sessionSlug: payload.sessionSlug,
            runId: row.runId, effectKey: row.entry?.key,
          });
        } catch (e) {
          // Known NOT running — record it so the next pass counts this attempt dead at once, not after a TTL.
          try { markResume({ num, pid: null, ...binding, spawnFailed: true }); } catch { /* the pending marker still bounds it */ }
          throw e;
        }
        markResume({ num, pid, ...binding });
        results.push({ num, action: 'resume', reason: decision.reason, pid });
      } else {
        const exhausted = decision.action === 'exhausted';
        // Hold BEFORE release (the wrapper's own `settleTerminal` order): a crash between the two must never
        // leave the item unheld and free to re-dispatch into the same failure.
        if (exhausted) placeHold({ num, reason: `orphan-adopt: ${attempts} resume attempt(s) died without settling` });
        releaseClaim({ num });
        clearMarker(num);
        settleRow({ runId: row?.runId, key: row?.entry?.key, outcome: exhausted ? 'orphan-resume-exhausted' : 'orphan-released' });
        results.push({ num, action: decision.action, reason: exhausted ? decision.reason : `${decision.reason} (${resumability.reason})` });
      }
    } catch (e) {
      results.push({ num, action: 'error', reason: String(e?.message || e).split('\n')[0] });
    }
  }
  return results;
}
