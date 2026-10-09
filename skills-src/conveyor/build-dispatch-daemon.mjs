#!/usr/bin/env node
/**
 * @file skills-src/conveyor/build-dispatch-daemon.mjs
 * @description #3984 slice 1 — the standalone BUILD-DISPATCH DAEMON. Each tick it asks the tick core
 *   (we:scripts/conveyor/tick-core.mjs) which cleared, ready items it may launch (`decisions.spawnBuilds`), runs
 *   the operator's build policy over that answer (we:scripts/conveyor/build-dispatch-policy.mjs — cap, landing
 *   freeze, scope vs open PRs, hot-file, branch name), and dispatches each survivor MECHANICALLY through the
 *   existing `dispatch-lane` operation (`run.mjs dispatch-lane --num=N`, with `WE_BUILD_DISPATCH_MODE=mechanical`
 *   so a card's `deliveryAgent:` marker routes to Codex via deliver-item-run / the wrapper, and the #3906 routing
 *   table + #4034 critical-work gate decide everything else inside dispatch-lane — this file routes nothing).
 *
 * WHAT IT IS NOT. It runs NO other pass: no scope/decision prepare, fix/ci-heal spawns, no reconcile, no watchers — those have
 *   their own daemons (review, fix-dispatch, pass-daemons) or stay with runner.mjs.
 *   Exception: an abandoned red builder draft is recovered here through the existing PR repair dispatcher. It never edits runner.mjs.
 *
 * SAFETY:
 *   - ONE singleton lease under its own key ({@link BUILD_DISPATCH_DAEMON_LEASE_KEY}, #3877 keyed leases), with
 *     the independent heartbeat timer the verify daemon uses (#4130).
 *   - NO DOUBLE DISPATCH ACROSS RESTARTS: a durable per-item claim (we:scripts/conveyor/build-dispatch-claim.mjs,
 *     the build twin of PR #2789's fix-dispatch claim) is taken BEFORE dispatch-lane runs and is only retired by
 *     observed progress (a PR delivers the item, or the item left the cleared queue). A restarted daemon has a
 *     new pid, so it cannot take an old claim, and the claim's stored scope keeps the hot-file rule honest.
 *   - KILL SWITCH: `WE_BUILD_DAEMON_KILL=1`, or the file `<coordination root>/build-dispatch-daemon.kill`,
 *     skips live tick preparation and dispatch, logging one paused line per tick. With --self-sync, the
 *     shared clone still syncs every 30 minutes (WE_BUILD_DAEMON_PAUSED_SYNC_MS overrides the interval).
 *     WE_BUILD_DAEMON_PAUSED_PREP=1 restores full paused ticks; dry-run always reports the full plan.
 *   - LIVE IS OPT-IN: without `--live` the daemon refuses to dispatch. `--dry-run` prints what it WOULD
 *     dispatch now and exits, touching nothing (no lease, no claim, no dispatch).
 *
 * PURE-CORE / IO-SHELL: {@link runBuildDispatchTick} and {@link settleBookkeeping} take every effect injected
 *   and are unit-tested in we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs.
 */

import { retryTransientGit } from '../../scripts/lib/git-fetch-retry.mjs';
import { PLANNING_SNAPSHOT_ENV } from '../../scripts/lib/planning-snapshot.mjs';
import { installDaemonLog } from './daemon-log.mjs';
import { readShaCache, writeShaCache } from '../../scripts/lib/pr-snapshot.mjs';
import { createPhaseTimer } from '../../scripts/lib/phase-timer.mjs';
import { resolveOperationRoute, routingPolicyEnv } from '../../scripts/lib/dispatch-routing-policy-io.mjs';
import { childFailure } from '../../scripts/lib/child-failure.mjs';
import { execFileSync, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, mkdirSync, appendFileSync, renameSync, statSync } from 'node:fs';
import os, { tmpdir, hostname, homedir } from 'node:os';
import { gateHost } from '../../scripts/lib/dispatch-throttle.mjs';
import { admitLaunch, costAdmissionOn, freezeHolds, lightCapFor, summarizeCostAdmission } from '../../scripts/lib/cost-admission.mjs';
import { readCostAdmissionSettings, readCostFacts } from '../../scripts/lib/cost-admission-facts.mjs';
import { builderExecutorFor } from '../../scripts/lib/fix-slot-borrow.mjs';
import { startDetachedLaunch, settleLaunches, PENDING_LAUNCHES_DIRNAME } from '../../scripts/conveyor/pending-launches.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RUNNER_LOCK_ROOT, makeOwner, acquireRunnerLease, releaseRunnerLeaseIfOwned,
} from './runner-lock.mjs';
import { runDaemonLoop, startIndependentHeartbeat, realSleep } from './verify-daemon.mjs';
import { normNum } from '../../scripts/conveyor/queue-store.mjs';
import { collectProtectedNums } from '../../scripts/conveyor/queue-prune.mjs';
import {
  BUILD_DISPATCH_POLICY, planBuildDispatch, normalizeOpenPrs, prDeliversNum, prDeliveredNum, reportOpenItems,
  collectBuildHolds, stampCoversClaim,
} from '../../scripts/conveyor/build-dispatch-policy.mjs';
import {
  acquireBuildDispatchClaim, releaseBuildDispatchClaim, listBuildDispatchClaims,
  listBuildDispatchHolds, placeBuildDispatchHold, releaseBuildDispatchHold, DEFAULT_BUILD_DISPATCH_HOLD_MINUTES,
} from '../../scripts/conveyor/build-dispatch-claim.mjs';
import { listFixDispatchClaims } from '../../scripts/conveyor/fix-claim-store.mjs';
// #4465 — a held item's own route (already-done / out-of-scope / other) and the live sweep that acts on it.
// See that file's own header for the three routes and why this daemon owns the sweep.
import { planHoldRouting, routeHeldItems, reserveHoldRoute, releaseHoldRoute, appendHoldFinding } from '../../scripts/conveyor/build-dispatch-hold-router.mjs';
import { readBuilderRuns, readAuthorship, backfillAuthorship } from '../../scripts/operations/build-pr-authorship.mjs';
import { resolveCoordinationRoot } from '../../scripts/operations/coordination-root.mjs';
// #4131/#4382 build-orphan-adopt — see that module's own header for the mechanism this closes.
import { classifyClaimLiveness, settleOrphanRow, adoptOrphanedBuildClaims, decideOrphanAction, RESUME_SPAWN_GRACE_MS } from '../../scripts/conveyor/build-dispatch-orphan-adopt.mjs';
// #4464 builder-cap-machine-wide — see `cliPlanTick`'s own docblock for why this daemon's tick-core read is
// exempted from the shared, machine-wide lane-count ceiling.
import { isLeaseExpired, DEFAULT_LEASE_MINUTES } from '../../scripts/readiness/file-locks.mjs';
import { defaultIsPidAlive } from '../../scripts/operations/detached-dispatch.mjs';
import { settleDispatchEffect } from '../../scripts/operations/deliver-item-settle.mjs';
import { prepareCardStatus } from '../../scripts/conveyor/prepare-result.mjs';
import { readField } from '../../scripts/backlog/frontmatter.mjs';
import { CONSTELLATION_REPOS } from '../../scripts/lib/constellation-repos.mjs';
import { readMainRedState, resolveFreezeMainRed } from '../../scripts/lib/main-red-priority.mjs'; // card xu1nixv
import { mainRedBuildFreeze } from '../../scripts/conveyor/main-ci-red-core.mjs'; // card xu1nixv
import { MAX_CONCURRENT_LANES_ENV } from '../../scripts/lib/lane-concurrency.mjs';

import { classifyPrepareFailure, recordPrepareFailure, readFailureState, readPrepareReleases, releasedAttempt, completePrepareFailures, releaseDuePrepareRetries, takePrepareRouteHolds, rearmFalseHolds, NOT_CONFIRMED_FIX_LANDED_AT } from '../../scripts/conveyor/prepare-failure-policy.mjs';
import { CARD_REFUSAL_CODE } from '../../scripts/conveyor/retry-backoff.mjs';
import { recordBuildFailure, clearBuildFailure, listBuildBackoffs, rearmBuildFailures } from '../../scripts/conveyor/build-dispatch-failures.mjs';
import { redactSpawnText } from '../../scripts/lib/describe-spawn-failure.mjs';

import { resolveScorecardStorePath } from '../../scripts/conveyor/run-scorecard-store.mjs';

/** Prepare outcomes the runner already handled (a verified already-done resolve PR; a needs-you hold): never failures. */
const PREPARE_HANDLED_OUTCOMES = ['prepare-already-done', 'prepare-needs-you'];

/** Durable attempt history: repeated ticks and Claude runs cannot reset or double-count failures. */
export function prepareRouteFallback(records = [], releases = []) {
  const attempts = records.filter(r => r.dispatchKind === 'probation-launch' && r.taskType === 'prepare' && r.repo === CONSTELLATION_REPOS.we.slug)
    .sort((a, b) => String(a.scoredAt).localeCompare(String(b.scoredAt)));
  const failures = attempts.filter(r => !r.pr && r.launchOutcome !== 'opened-pr' && !PREPARE_HANDLED_OUTCOMES.includes(r.launchOutcome));
  return failures.length >= 2 && failures.some(r => !releasedAttempt(releases, 'route:prepare', `${r.handle}:${r.scoredAt}`));
}

export const BUILD_DISPATCH_DAEMON_LEASE_KEY = '<conveyor:build-dispatch-daemon-lease>';
export const DEFAULT_INTERVAL_MS = 120_000;
export const PREPARE_SESSION_DEAD_GRACE_MS = 20 * 60_000;
// #4517 — bounds cliRetryInfraBlocked's execFileSync so a slow `pr-land --label-on-green` CI wait inside
// `infra-blocked.mjs retry` can never stall a whole daemon tick past this. Well under DEFAULT_INTERVAL_MS
// (120_000ms) so the rest of the tick (dispatch, liveness, claims) always keeps real headroom. A retry that
// times out is simply retried next tick — idempotent, matching #2659's own backoff design; nothing is lost.
export const INFRA_RETRY_TIMEOUT_MS = 60_000;
export const KILL_SWITCH_ENV = 'WE_BUILD_DAEMON_KILL';
export const KILL_SWITCH_FILENAME = 'build-dispatch-daemon.kill';
export const PAUSED_PREP_ENV = 'WE_BUILD_DAEMON_PAUSED_PREP';
export const PAUSED_SYNC_MS_ENV = 'WE_BUILD_DAEMON_PAUSED_SYNC_MS';
export const DEFAULT_PAUSED_SYNC_MS = 30 * 60 * 1000;

// ── PURE CORE ────────────────────────────────────────────────────────────────────────────────────────────────

/** Is the kill switch engaged? Pure over its two inputs. */
export function readKillSwitch({ env = {}, killFileExists = false, killFilePath = '' } = {}) {
  const v = String(env[KILL_SWITCH_ENV] ?? '').trim().toLowerCase();
  if (v && v !== '0' && v !== 'false' && v !== 'off') return { engaged: true, reason: `${KILL_SWITCH_ENV}=${env[KILL_SWITCH_ENV]}` };
  if (killFileExists) return { engaged: true, reason: `kill file ${killFilePath}` };
  return { engaged: false };
}

/** Gate serial live ticks before preparation, retaining a slow sync for the shared verify clone. */
export function gatePausedTicks({ tickOnce, wrapSync = null, killSwitch, env = process.env, now = Date.now, log = () => {} }) {
  let pausedResult = null;
  let lastPausedSync = null;
  const inner = async () => pausedResult ?? tickOnce();
  const synced = wrapSync ? wrapSync(inner) : inner;
  return async function tick() {
    const kill = killSwitch();
    const prep = String(env[PAUSED_PREP_ENV] ?? '').trim().toLowerCase();
    if (!kill.engaged || (prep && !['0', 'false', 'off'].includes(prep))) return synced();
    const paused = { skipped: true, reason: `paused (${kill.reason})` };
    if (!wrapSync) return paused;
    const configuredMs = Number(env[PAUSED_SYNC_MS_ENV]);
    const intervalMs = Number.isFinite(configuredMs) && configuredMs > 0 ? configuredMs : DEFAULT_PAUSED_SYNC_MS;
    const time = now();
    if (lastPausedSync !== null && time - lastPausedSync < intervalMs) return paused;
    lastPausedSync = time;
    pausedResult = paused;
    try {
      const result = await synced();
      if (result !== paused && result?.skipped) return result;
      return { ...paused, reason: `${paused.reason}; clone self-synced` };
    } finally {
      pausedResult = null;
    }
  };
}

const GUARD_LISTS = ['buildGuards', 'prepareGuards', 'fixGuards', 'ciHealGuards'];
const guardId = (g) => JSON.stringify([g?.num ?? null, g?.pr ?? null, g?.kind ?? null, g?.spawnedTick ?? null]);

/**
 * The tick core records a guard for EVERY spawn it surfaces, assuming the caller launches them all. This daemon
 * launches builds that pass its policy and admitted item prepares — so a guard for a spawn it
 * did not make would hold that item's lane for the guard's TTL as if an agent were starting there. Keep every
 * guard the previous tick already carried, plus only the new build/item-prepare guards for items actually dispatched.
 * `launchedNums` is trimmed the same way. Everything else in `nextState` passes through unchanged.
 */
export function settleBookkeeping(prev = {}, next = {}, dispatchedNums = [], preparedNums = []) {
  if (!next || typeof next !== 'object') return {};
  const launched = new Set(dispatchedNums.map(normNum));
  const prepared = new Set(preparedNums.map(normNum));
  const out = { ...next };
  for (const list of GUARD_LISTS) {
    if (!Array.isArray(next[list])) continue;
    const had = new Set((Array.isArray(prev?.[list]) ? prev[list] : []).map(guardId));
    out[list] = next[list].filter((g) => had.has(guardId(g)) || (list === 'buildGuards' && launched.has(normNum(g?.num))) || (list === 'prepareGuards' && g.kind === 'prepare-item' && prepared.has(normNum(g.num))));
  }
  if (Array.isArray(next.launchedNums)) {
    const hadNums = new Set((Array.isArray(prev?.launchedNums) ? prev.launchedNums : []).map(normNum));
    out.launchedNums = next.launchedNums.filter((n) => hadNums.has(normNum(n)) || launched.has(normNum(n)) || prepared.has(normNum(n)));
  }
  return out;
}

/** A planning verdict is intent; only a persisted dispatch effect proves a launch. */
export function readDispatchOutcome(text) {
  let parsed;
  try { parsed = JSON.parse(String(text ?? '')); } catch { return { dispatching: false, reason: 'unparseable dispatch-lane output' }; }
  const run = parsed?.run ?? parsed;
  const verdict = run?.verdict;
  if (!verdict || typeof verdict.dispatching !== 'boolean') {
    // A step that REFUSED leaves no verdict by design — name the step and its reason, never just "no verdict".
    if (parsed?.stopped === 'step-refused' || (parsed?.stopped && parsed?.error)) {
      const step = String(parsed.step ?? 'unknown');
      const why = redactSpawnText(String(parsed.error ?? parsed.stopped)).replace(/\s+/g, ' ').slice(0, 400);
      return { dispatching: false, reason: `${parsed.stopped === 'step-refused' ? 'step-refused' : `stopped (${parsed.stopped})`} at \`${step}\`: ${why}`, stepRefused: { step, error: why } };
    }
    return { dispatching: false, reason: 'no verdict in dispatch-lane output' };
  }
  const result = { dispatching: false, reason: verdict.reason ?? verdict.why ?? null,
    lane: verdict.lane ?? null, sessionSlug: verdict.sessionSlug ?? null };
  // A planner declining to launch (lane cap, plan re-read race, freeze) is a typed refusal, not a failed
  // prepare: the caller retries next tick instead of holding. Only launch/parse failures fall through untyped.
  if (!verdict.dispatching) return { ...result, refused: true };
  const effect = run.effects?.find(e => e.type === 'conveyor.dispatch-delivery-agent');
  if (effect?.error) return { ...result, reason: effect.error };
  if (!effect || !['in-flight', 'applied'].includes(effect.status)
    || typeof effect.handle !== 'string' || !effect.handle.trim()) {
    return { ...result, reason: `dispatch launch not confirmed (${effect?.status ?? 'missing effect'}; no running session)` };
  }
  return { ...result, dispatching: true, handle: effect.handle };
}

/**
 * #4295 — the scopes of LIVE fix/ci-heal claims, as `planBuildDispatch`'s `fixInFlight`. A claim with no recorded
 * scope (written before scope rode in `meta`) is skipped: unknown is not proven overlapping.
 * @returns {Array<{pr:number, scope:string[]}>}
 */
/** Card 87 — live fixes running in a BORROWED builder slot, as in-flight rows the planner counts against that class. */
export function liveBorrowedFixInFlight(listClaims = () => listFixDispatchClaims(undefined, { liveOnly: true })) {
  return listClaims()
    .filter((c) => c?.meta?.borrowed?.executor && c.meta.pr != null)
    .map((c) => ({
      num: `fix-${c.meta.pr}`, scope: Array.isArray(c.meta.scope) ? c.meta.scope : [], source: `borrowed fix claim ${c.owner}`,
      executor: builderExecutorFor(c.meta.borrowed.executor), borrowedFix: true,
    }));
}

export function liveFixInFlight() {
  return listFixDispatchClaims(undefined, { liveOnly: true })
    .filter((c) => Array.isArray(c.meta.scope) && c.meta.scope.length)
    .map((c) => ({ pr: c.meta.pr, scope: c.meta.scope }));
}

/**
 * xovjhwh (operator decision 2026-09-29) — "this builder's own dispatch-lane run records," as a flat `Set` of
 * item nums: every item the run-store currently shows in-flight PLUS every item whose `dispatch-lane` build
 * effect has already settled (any outcome — even a non-`pr-opened` one; `planBuildDispatch`'s own delivered-PR
 * check is what actually gates whether an open PR counts, this set only says "the builder dispatched it at some
 * point"). Both inputs are RAW rows (`{num, ...}`), not the deduped `Map`s their callers separately build for
 * their own purposes (`inFlightNums`, `settledByNum`) — this derivation only needs the num.
 *
 * WHY THESE TWO READS ARE THAT SET: verified by a full-repo sweep (`grep -rn "'dispatch-lane'"` across
 * `scripts/` and `skills-src/`, converge round 1, claim-accuracy finding), not merely reasoned from this file's
 * own code paths — `cliDispatch` below is the ONLY place in this codebase that spawns `run.mjs dispatch-lane`
 * for a build; nothing else writes a `dispatch-lane*` run-store record. A hand-dispatched worker (per
 * `we:skills-src/mechanical-delivery-doctrine/SKILL.md`) opens its PR via the `Agent` tool directly, never
 * through `dispatch-lane` — so its num never lands in either read, and its PR correctly stays excluded from
 * `maxOpenItems` even though it still counts toward `maxOpenPrs`/`hot-file` (both read `openPrs` unfiltered).
 *
 * PULLED OUT SO `runBuildDispatchTick`'s live tick and `dryRun`'s `ifFreed` report call the SAME derivation —
 * converge round 1 (simplicity/standards-conformance findings) flagged the two as independently re-derived
 * inline, which let them silently drift if a THIRD source of "the builder's own" was ever added to one but not
 * the other.
 *
 * ACCEPTED FAIL DIRECTION: both reads already degrade to `[]` on their own read error
 * (`cliListRunStoreInFlight`/`cliListSettledBuilds` below each `catch` to `[]`, never throw — pinned against a
 * REAL broken run-store directory, not just a hand-fed empty array, by their own "real readers" tests), so a
 * read failure only SHRINKS this set — failing the `wip-cap` open (under-counts, bounded by
 * `maxConcurrentBuilds`/`maxOpenPrs`), same direction `inFlightNums` already had pre-#xovjhwh for the in-flight
 * side. Making a read fail CLOSED instead is a card Follow-up, not this MVP.
 */
export function deriveDispatchedByBuilder(runStoreRows = [], settledRows = []) {
  const nums = new Set();
  for (const r of runStoreRows) { const n = normNum(r?.num); if (n) nums.add(n); }
  for (const r of settledRows) { const n = normNum(r?.num); if (n) nums.add(n); }
  return nums;
}

/**
 * ONE tick. Every effect is injected:
 *   planTick(bookkeeping) → tick-core `{decisions, nextState}`; fetchOpenPrs() → `[{repo, prs}]`;
 *   listClaims() → claim entries; releaseClaim({num}); acquireClaim({num, scope}) → `{ok, reason, heldBy}`;
 *   listRunStoreInFlight() → `[{num, scope, source, executor}]` (card xao7080/#4518 — `executor` is the
 *     provider that actually ran it, `null` for a record with none); killSwitch() → `{engaged, reason}`;
 *   dispatch({num, bookkeeping}) → `{dispatching, reason}`.
 *   #4349 — listSettledBuilds() → `[{num, outcome}]` (a settled, non-PR terminal outcome a wrapper itself
 *     wrote — the claim-retirement signal a stale `pid:` handle used to give nothing for) and
 *     listHolds() → `[{num, reason}]` (a non-PR terminal-outcome cooldown — `not-ready`, `gate-red`, … —
 *     excluded from THIS tick's candidates entirely, so the item is not offered for dispatch again until the
 *     hold lapses). Both optional — an
 *     `effects` stub that predates #4349 (an existing test fixture) simply supplies neither and nothing
 *     about this tick's behaviour changes for it.
 * `live:false` plans and reports without retiring, claiming, or dispatching anything.
 *
 * #4131/#4382 build-orphan-adopt — `adoptOrphans({allowResume, frozenReason})` (optional, LIVE ONLY,
 * best-effort) runs before the retire loop below ever reads `effects.listClaims()`, with `allowResume` false
 * while the kill switch or a landing freeze is on: a claim it releases this same tick is then simply
 * absent from that read, freeing the item for THIS tick's own dispatch decision rather than waiting a full
 * cycle. See `scripts/conveyor/build-dispatch-orphan-adopt.mjs`'s own header for the mechanism this closes —
 * a claim whose recorded dispatch died with none of `doneWhy`'s three retirement signals ever becoming true.
 * Optional-chained so an older test stub (every fixture that predates this) behaves exactly as before.
 */
export async function runBuildDispatchTick(options) {
  const timer = options.timer ?? createPhaseTimer();
  try { return await runTimedBuildDispatchTick({ ...options, timer }); }
  catch (error) { error.timings = timer.snapshot(); throw error; }
}

/**
 * Release the hold of each card in `nums` ONLY when it is a prepare hold (the one the failure ledger places). A hold
 * file is keyed by card number alone, so an operator / supervisor / #4465-routed / `gate-red` hold sharing the card
 * would otherwise be silently lifted by a backoff release or a re-arm. Returns what was released and what was kept.
 */
export function releaseOwnPrepareHolds({ nums, holds, release }) {
  // A card with ANY non-prepare entry keeps its hold, whatever order the entries come in (`listHolds` can append a
  // synthetic prepare entry for a held ledger failure after the real hold files).
  const own = new Map();
  for (const h of holds) {
    const num = normNum(h.num);
    own.set(num, (own.get(num) ?? true) && h.reason === LEDGER_HOLD_REASON);
  }
  const released = [];
  const kept = [];
  for (const raw of nums) {
    const num = normNum(raw);
    if (!own.has(num)) continue; // no live hold at all — nothing to release
    if (!own.get(num)) { kept.push(num); continue; }
    release?.({ num });
    released.push(num);
  }
  return { released, kept };
}
// The one hold the prepare failure ledger places (`failPrepare`); `prepare-stamp-pending` belongs to stamp recovery.
const LEDGER_HOLD_REASON = 'prepare-unstamped';

async function runTimedBuildDispatchTick({ bookkeeping = {}, live = false, policy = BUILD_DISPATCH_POLICY, prepareEnabled = true, routingPolicy, effects, timer = createPhaseTimer() }) {
  effects = timer.wrap(effects);
  // Item 95 — held transient prepare failures whose backoff elapsed become dispatchable again BEFORE holds are read.
  // Live only: a dry-run must not mutate the ledger.
  if (live && typeof effects.releaseDuePrepareRetries === 'function') {
    try {
      const due = effects.releaseDuePrepareRetries() ?? [];
      // Holds are keyed by card: only lift the PREPARE hold this ledger placed, never another hold on the card.
      if (due.length) releaseOwnPrepareHolds({ nums: due, holds: effects.listHolds?.() ?? [], release: effects.releasePrepareHold });
      // Live 2026-10-09 — a held prepare whose worker reported already-done (with a commit) becomes an ordinary
      // dispatch hold the hold router lands as a resolve (graduatedTo that commit), exactly as the runner does.
      for (const r of effects.takePrepareRouteHolds?.() ?? []) effects.placePrepareHold?.({ num: r.num, reason: r.reason });
    } catch (e) { console.error(`build-dispatch-daemon: prepare retry release failed: ${String(e?.message || e).split('\n')[0]}`); }
  }
  // A held ledger failure that carries its own reason (a could-not-prepare: `needs-you: …`) is held UNDER that reason,
  // never as a silent `prepare-unstamped`: the hold router records it and the tick lists it under `needsYou`.
  const ledgerFailures = effects.listPrepareFailures?.() ?? [];
  const ledgerHoldReason = new Map(ledgerFailures.filter(f => f.held && !f.completed && f.holdReason).map(f => [normNum(f.num), f.holdReason]));
  let holds = (effects.listHolds?.() ?? []).map(h => (h.reason === LEDGER_HOLD_REASON && ledgerHoldReason.has(normNum(h.num))
    ? { ...h, reason: ledgerHoldReason.get(normNum(h.num)), ledger: true } : h));
  const prepareRows = effects.listPrepareInFlight?.() ?? [];
  const prepareClaims = effects.listPrepareClaims?.() ?? [];
  const prepareIsLive = (r) => r.row?.entry?.live === true
    && !(r.row.entry.handle?.startsWith('pid:') && classifyClaimLiveness({ row: r.row,
      isPidAlive: effects.isPidAlive ?? defaultIsPidAlive }).status === 'dead');
  // A ledger hold remapped to its `needs-you:` reason (`ledger: true`) is still the ledger's prepare hold: tracking,
  // the stamped-on-main release and the unstamped-completion path must keep applying to it.
  const isPrepareHold = h => h.ledger === true || ['prepare-unstamped', 'prepare-stamp-pending'].includes(h.reason);
  // The stamp a prepare's claim recorded at spawn, kept on its hold too: the claim is released when the attempt ends
  // unstamped, and a later tick must still tell the stamp being replaced from a result.
  // `null` (the card was unstamped at spawn) is a recorded answer, distinct from `undefined` (nothing recorded).
  const claimReplacesStamp = (num) => {
    const meta = prepareClaims.find((c) => normNum(c.meta.num) === normNum(num))?.meta;
    return meta && 'replacesStamp' in meta ? meta.replacesStamp : holds.find((h) => normNum(h.num) === normNum(num))?.replacesStamp;
  };
  const prepareStatus = new Map();
  const completedPrepares = new Set();
  const prepareReadErrors = new Map();
  // Completion invalidates the cached prepare eligibility BEFORE the expensive plan.
  // Probe only tracked attempts; live workers retain ownership even if a stamp is visible.
  const trackedPrepares = new Set([...prepareRows.map(r => normNum(r.num)),
    ...prepareClaims.map(c => normNum(c.meta.num)),
    ...(bookkeeping.prepareGuards ?? []).filter(g => g.kind === 'prepare-item').map(g => normNum(g.num)),
    ...holds.filter(isPrepareHold).map(h => normNum(h.num))]);
  try { await effects.primePrepareStatus?.({ nums: [...trackedPrepares], claims: prepareClaims }); }
  catch { /* Individual reads retain their own failure handling and can load lazily. */ }
  for (const num of trackedPrepares) {
    if (prepareRows.some(r => normNum(r.num) === num && prepareIsLive(r))) continue;
    try {
      const claim = prepareClaims.find(c => normNum(c.meta.num) === num);
      const status = await effects.readPrepareStatus?.({ num, claimedAt: claim?.meta?.claimedAt, replacesStamp: claimReplacesStamp(num) });
      prepareStatus.set(num, status);
      if (!status?.preparedDate) continue;
      for (const r of prepareRows.filter(r => normNum(r.num) === num && r.row)) {
        if (live) await effects.settlePrepareRow?.({ runId: r.row.runId, key: r.row.entry.key, outcome: 'prepare-completed' });
      }
      completedPrepares.add(num);
      if (live && holds.some(h => normNum(h.num) === num && isPrepareHold(h))) effects.releasePrepareHold?.({ num });
      // Stamped on main: a needs-you hold resolved by hand is closed with it, else the CLI's synthetic hold for that
      // record would bring the card back under a hold every tick.
      // Only for a needs-you hold: a backed-off failure of a stale-stamped re-prepare must keep its ledger record (and
      // its attempt count), or the card would be re-dispatched every tick.
      if (live && ledgerHoldReason.has(num)) effects.completePrepareFailures?.(num);
    } catch (e) { prepareReadErrors.set(num, e); }
  }
  holds = holds.filter(h => !isPrepareHold(h) || !completedPrepares.has(normNum(h.num)));
  bookkeeping = { ...bookkeeping, prepareGuards: (bookkeeping.prepareGuards ?? [])
    .filter(g => g.kind !== 'prepare-item' || !completedPrepares.has(normNum(g.num))) };
  const releases = effects.listPrepareReleases?.() ?? [];
  const allSettledPrepares = await effects.listSettledPrepares?.() ?? [];
  const failureRecords = ledgerFailures;
  const released = new Set();
  for (const row of allSettledPrepares) {
    if (releasedAttempt(releases, row.num, row.source)
      && !allSettledPrepares.some(other => other.num === row.num && other.startedAt > row.startedAt)
      && !failureRecords.some(f => f.num === row.num && f.held && !f.completed && !releasedAttempt(releases, f.num, f.attempt))) released.add(normNum(row.num));
  }
  // A launch can fail before any run-store settlement exists. Its ledger attempt is releasable too.
  for (const failure of failureRecords) {
    if (releasedAttempt(releases, failure.num, failure.attempt)
      && !failureRecords.some(f => f.num === failure.num && f.held && !f.completed && !releasedAttempt(releases, f.num, f.attempt))
      && !allSettledPrepares.some(r => r.num === failure.num && !releasedAttempt(releases, r.num, r.source))) released.add(failure.num);
  }
  holds = holds.filter(h => {
    if (!released.has(normNum(h.num)) || !(h.reason?.startsWith('prepare-') || h.ledger)) return true;
    if (live) effects.releasePrepareHold({ num: normNum(h.num) });
    return false;
  });
  // Exclude held candidates BEFORE the tick core allocates its two prepare slots.
  bookkeeping = { ...bookkeeping, prepareHeldNums: holds.map((h) => normNum(h.num)) };
  const tickBookkeeping = bookkeeping;
  // 78b — settle detached launches from earlier ticks BEFORE planning: a launched one keeps its claim (the run-store
  // row owns it from here); a failed one releases its claim and records the failure the same way a blocking launch did.
  // A still-pending one keeps its claim and keeps the item busy. Optional-chained for older effects stubs.
  const pendingLaunch = { build: new Set(), prepare: new Set() };
  const launchSettlement = { settled: [], pending: [] };
  const deferredLaunchFailures = [];
  if (live && typeof effects.settleLaunches === 'function') {
    try {
      const r = await effects.settleLaunches();
      for (const p of r.pending ?? []) (p.kind === 'prepare-item' ? pendingLaunch.prepare : pendingLaunch.build).add(normNum(p.num));
      launchSettlement.pending = r.pending ?? [];
      for (const st of r.settled ?? []) {
        const num = normNum(st.num);
        const isPrepare = st.kind === 'prepare-item';
        launchSettlement.settled.push({ num, kind: st.kind, launched: Boolean(st.outcome?.dispatching), reason: st.outcome?.reason ?? null });
        if (st.outcome?.dispatching) { if (!isPrepare && live) effects.clearBuildFailure?.({ num }); continue; }
        // The claim goes NOW (so this tick's own claim read already sees it freed); the failure record waits for
        // `failPrepare`/`failures`, declared further down.
        if (isPrepare) effects.releasePrepareClaim({ num }); else effects.releaseClaim({ num });
        deferredLaunchFailures.push({ num, isPrepare, outcome: st.outcome, attempt: st.attempt });
      }
    } catch (e) { launchSettlement.error = String(e?.message || e).split('\n')[0]; }
  }
  // Card 80 — the just-in-time prepare settings ride to tick-core as config (window) and on to dispatch-plan
  // (max age + scope drift → `prepare-stale`).
  const out = await effects.planTick(tickBookkeeping, { config: planConfigFrom(policy) });
  // The plan's age is what dispatch-lane's freshness bound must measure, so stamp it here, once, right after
  // planning — never at each (possibly much later) dispatch.
  const tickAt = new Date(effects.now?.() ?? Date.now()).toISOString();
  const d = out?.decisions || {};
  const admission = d.admission || {};
  const scopeByNum = new Map((admission.queue || []).map((r) => [normNum(r.num), Array.isArray(r.scope) ? r.scope : []]));
  const clearedNums = new Set((admission.cleared || []).map((r) => normNum(r.num)));
  const rawOpenPrs = await effects.fetchOpenPrs();
  const openPrs = normalizeOpenPrs(rawOpenPrs);
  // PR #2921 review — a resume spawns real gate/converge/PR work, so it obeys the SAME kill switch and landing
  // freeze a fresh dispatch does (`planBuildDispatch`'s own freeze rule, computed here with no candidates).
  // Still before this tick's own `listClaims()` read, so a claim released here frees its item this same tick.
  // Compute for previews too: a dry-run must report the same freeze as a live tick.
  const freeze = planBuildDispatch({ openPrs, killSwitch: effects.killSwitch(), policy }).freeze;
  let orphanAdoption = null;
  if (live && typeof effects.adoptOrphans === 'function') {
    try { orphanAdoption = await effects.adoptOrphans({ allowResume: !freeze.frozen, frozenReason: freeze.reasons.join('; '), skipNums: pendingLaunch.build }); }
    catch (e) { orphanAdoption = { error: String(e?.message || e).split('\n')[0] }; }
  }
  // Queue hygiene (automatic classes only: resolved / duplicate alias / missing card). LIVE only, best-effort, and
  // BEFORE the claim-retire loop so the protected set still holds every active claim. Never drops an entry with an
  // open PR, an active claim, or an in-flight run (see `scripts/conveyor/queue-prune.mjs`).
  let queuePrune = null;
  if (live && typeof effects.pruneQueue === 'function') {
    try {
      // The same builder the `queue.mjs prune` CLI uses (queue-prune.mjs#collectProtectedNums). A fix claim is
      // keyed by its PR, so it resolves through `openPrs` (it carries no item num of its own).
      const protectedNums = collectProtectedNums({
        prs: openPrs,
        claims: effects.listClaims(),
        fixClaims: effects.listFixClaims?.() ?? [],
        runs: effects.listRunStoreInFlight(),
        prNum: prDeliveredNum,
      });
      queuePrune = await effects.pruneQueue({ protectedNums });
    } catch (e) { queuePrune = { error: String(e?.message || e).split('\n')[0] }; }
  }
  // A delivered draft is still its builder's responsibility. This pass precedes candidate/hold
  // filtering: an "already delivers it" hold must never suppress repair of that very PR.
  let draftRecovery = null;
  if (typeof effects.recoverDrafts === 'function') {
    try { draftRecovery = await effects.recoverDrafts({ rawOpenPrs, allowResume: !freeze.frozen, dryRun: !live }); }
    catch (e) { draftRecovery = { error: String(e?.message || e).split('\n')[0] }; }
  }
  const runStoreInFlight = effects.listRunStoreInFlight();
  const settledRows = effects.listSettledBuilds?.() ?? [];
  // A claim retires on a SETTLED non-PR outcome, but never over a run-store row that is CURRENTLY in-flight
  // for the same item: only one claim ever exists per `num` at a time (the daemon's own `acquireClaim` is a
  // mutex on that resource), so a lingering settled record from an OLDER, already-retired attempt must never
  // be read as "this brand-new dispatch is also done" — it would both retire the wrong (live) claim and hide
  // that attempt's own in-flight row from the loop below.
  const inFlightNums = new Set(runStoreInFlight.map((r) => normNum(r.num)));
  // Newest attempt per item wins — never "whichever row the source returned last". `startedAt` is the settling
  // attempt's own dispatch-start time (see `cliListSettledBuilds`'s own note); a row with no timestamp at all
  // (an older effects stub, or a test) is kept only when nothing with a real timestamp has claimed the slot.
  const settledByNum = new Map();
  for (const r of settledRows) {
    const n = normNum(r.num);
    const prev = settledByNum.get(n);
    if (!prev || (typeof r.startedAt === 'string' && r.startedAt > (prev.startedAt || ''))) settledByNum.set(n, r);
  }
  const heldNums = new Set(holds.map((h) => normNum(h.num)));
  // Item 96 — a build card inside its failure backoff window (or exhausted) is withheld like a cooldown hold.
  const buildBackoffs = effects.listBuildBackoffs?.() ?? [];
  for (const b of buildBackoffs) heldNums.add(normNum(b.num));
  // #4465 — classify every LIVE hold (pure, cheap, every tick — never gated on `live`, so it is visible on a
  // `--dry-run` tick too) and, LIVE only, act on it (best-effort — a routing hiccup must never fail this
  // tick's own build-dispatch plan). Optional-chained so an older test stub that predates this field behaves
  // exactly as before (no call, no throw). See `scripts/conveyor/build-dispatch-hold-router.mjs`'s own header
  // for the three routes and why this sweeps EVERY hold each tick rather than hooking the wrapper that first
  // placed it — it catches a hold from before this fix existed exactly the same as a fresh one.
  //
  // PR #2967 review — routes (a)/(b) spawn a lane → commit → `open-pr --mode=label-on-green` landing, i.e. real
  // self-merging PR work, so they obey the SAME kill switch and landing freeze `adoptOrphans` above does. While
  // frozen they are WITHHELD — never passed to `routeHeldItems`, so no dedup lease is spent on them and the
  // first tick after the freeze lifts routes them. Route (c) is a host-local ledger append (no lane, no PR) and
  // still runs.
  const holdRouting = planHoldRouting(holds);
  let holdRoutingResult = null;
  if (live && typeof effects.routeHeldItems === 'function') {
    const allowed = freeze.frozen ? holdRouting.filter((h) => h.route === 'other') : holdRouting;
    const withheld = holdRouting.filter((h) => !allowed.includes(h))
      .map((h) => ({ num: h.num, route: h.route, action: 'withheld-frozen', reason: freeze.reasons.join('; ') }));
    try {
      const routed = await effects.routeHeldItems(allowed);
      holdRoutingResult = [...(Array.isArray(routed) ? routed : []), ...withheld];
    }
    catch (e) { holdRoutingResult = { error: String(e?.message || e).split('\n')[0] }; }
  }

  // Retire what observable progress has finished: a PR delivers it, it left the cleared queue, or the
  // dispatch's OWN wrapper already settled it with a definite non-PR outcome.
  //
  // `claimedAt`, when given, ties a settled row to THIS specific claim: the row's own `startedAt` must be AT OR
  // AFTER the claim's `claimedAt`, or it is some OLDER, already-superseded attempt's leftover record, not this
  // one's. This matters because a brand-new attempt whose own effect has not yet gone `in-flight` (still
  // `declared`) is invisible to `inFlightNums` — without this check, a stale prior attempt's settled row would
  // retire the fresh claim outright. Skipped when either timestamp is missing (an older claim/effects stub, or
  // a test) — `inFlightNums` is still the floor in that case, same as before this check existed.
  const doneWhy = (num, { claimedAt = null } = {}) => {
    const n = normNum(num);
    const pr = openPrs.find((p) => prDeliversNum(p, n));
    if (pr) return `${pr.repo}#${pr.number} delivers it`;
    // 78b — a launch still being started has no run-store row yet; its claim is the only thing keeping the item ours.
    if (pendingLaunch.build.has(n)) return null;
    const settled = settledByNum.get(n);
    if (settled && settled.outcome !== 'pr-opened' && !inFlightNums.has(n)) {
      const stale = claimedAt && typeof settled.startedAt === 'string' && settled.startedAt !== '' && settled.startedAt < claimedAt;
      if (!stale) return `run record settled: ${settled.outcome}`;
    }
    // Only trust "left the queue" when the tick actually read a queue — an empty/failed read must never retire
    // every claim at once (that would reopen the restart double-dispatch this claim exists to close).
    if (clearedNums.size > 0 && !clearedNums.has(n)) return 'left the cleared queue';
    return null;
  };
  const retired = [];
  const inFlight = [];
  for (const c of effects.listClaims()) {
    const num = normNum(c.meta?.num);
    const why = doneWhy(num, { claimedAt: c.meta?.claimedAt || null });
    if (why) {
      if (live) effects.releaseClaim({ num });
      retired.push({ num, why, released: live });
      continue;
    }
    inFlight.push({ num, scope: c.meta?.scope || [], source: `claim ${c.owner}` });
  }
  for (const r of runStoreInFlight) {
    if (!doneWhy(r.num)) inFlight.push(r);
  }
  // Card 87 — a fix borrowing a builder slot occupies it (no build may be started over it).
  try { inFlight.push(...(effects.listBorrowedFixes?.() ?? [])); } catch { /* an unreadable claim set never blocks the tick */ }

  const spawn = Array.isArray(d.spawnBuilds) ? d.spawnBuilds : [];
  // #4349 — a held item (a recent non-PR terminal-outcome cooldown) is dropped from candidates entirely, same
  // as if the tick core had never surfaced it — this is the actual fix for the re-dispatch loop the
  // settle/release above would otherwise tighten rather than close.
  const candidates = spawn
    .filter((s) => !heldNums.has(normNum(s.num)))
    .filter((s) => !prepareRows.some(r => normNum(r.num) === normNum(s.num) && !completedPrepares.has(normNum(s.num))))
    .map((s) => ({ num: normNum(s.num), lane: s.lane ?? null, scope: scopeByNum.get(normNum(s.num)) || [] }));
  for (const c of candidates) {
    c.route = effects.predictRoute ? await effects.predictRoute(c.num, c.scope) : null;
    c.executor = c.route?.executor ?? null;
  }
  const held = spawn.filter((s) => heldNums.has(normNum(s.num))).map((s) => normNum(s.num));
  // Card x0jgunh — `counts.building` includes THIS tick's own freshly-proposed spawns (right for the
  // interactive conveyor, which launches every spawn it is handed; wrong here, since this daemon only
  // dispatches a SUBSET up to its own cap). `counts.buildingInFlight` excludes them; fall back to `building`
  // for a `planTick` stub (tests, older callers) that has not been updated to emit it.
  const externalBuilding = Number(d.counts?.buildingInFlight ?? d.counts?.building) || 0;
  // xovjhwh (operator decision 2026-09-29) — the wip-cap's delivered-by-open-PR side must count only PRs THIS
  // builder itself dispatched, never a hand-dispatched worker's (fix worker, ci-heal worker, stranded-claim
  // resume) merely because its branch names a card. `deriveDispatchedByBuilder` (above) is the single, shared
  // derivation `dryRun` also calls — see its own docblock for why `runStoreInFlight`/`settledRows` ARE this
  // builder's own durable dispatch-lane run records, and why the two staying in sync matters.
  const dispatchedByBuilder = deriveDispatchedByBuilder(runStoreInFlight, settledRows);
  const plan = planBuildDispatch({
    candidates, inFlight, openPrs, externalBuilding, killSwitch: effects.killSwitch(), policy, dispatchedByBuilder,
    fixInFlight: effects.listFixClaims ? effects.listFixClaims() : [],
    // Card xu1nixv — freeze kind `main-red` (setting freeze.mainRed); an effect that is absent or throws = no freeze.
    mainRedFreeze: (() => { try { return effects.mainRedFreeze ? effects.mainRedFreeze() : null; } catch { return null; } })(),
  });

  const dispatched = [];
  const failures = [];
  // A CARD-LEVEL PERMANENT REFUSAL (a dispatch-lane step refused because of what the card says) is never retried on
  // a cooldown: the failure ledger withholds it at once, the card is HELD with the step and reason (the hold
  // router records it in the findings ledger), and it is listed under `needsYou` on the tick line for the operator.
  const needsYou = [];
  // A card stamped on main this tick (its hold just released above) is no longer waiting on anyone.
  for (const [num, reason] of ledgerHoldReason) if (!completedPrepares.has(num)) needsYou.push({ num, step: 'prepare', reason });
  const surfaceCardRefusal = (num, rec, outcome) => {
    if (!rec || rec.reasonCode !== CARD_REFUSAL_CODE) return;
    const step = outcome?.stepRefused?.step ?? null;
    const reason = outcome?.reason ?? rec.reason;
    needsYou.push({ num: normNum(num), step, reason });
    heldNums.add(normNum(num));
    // The hold reason carries NO card-authored text: the hold router (`classifyHoldReason`) scans it unanchored for
    // `spec already done on main: commit …` / `spec superseded`, which are routes that spawn lane work. The refusal
    // text quotes the card's own scope value, so quoting it here would let a card steer that router. The full reason
    // stays in the failure ledger and `needsYou`.
    try { effects.placePrepareHold?.({ num: normNum(num), reason: `card-refused: dispatch-lane step ${step ?? 'unknown'} refused the card` }); } catch { /* best-effort: the ledger already withholds it */ }
  };
  // #4139 host-load gate on NEW launches only: refuse with a logged `host-load` reason, never touch running work, and
  // take no claim (so nothing needs releasing). Re-read per launch: a detached launch raises the load immediately.
  const loadHolds = [];
  // 78b — ONE detached launch in flight at a time. Two concurrent `dispatch-lane` runs (same tick) both failed to
  // confirm live; they share the lane pool and run store. Launching is now instant, so serializing costs one tick.
  let startedThisTick = 0;
  const launchSlotBusy = () => typeof effects.settleLaunches === 'function'
    && (pendingLaunch.build.size + pendingLaunch.prepare.size + startedThisTick) > 0;
  // Card x60i0ie — cost-class admission (`we:scripts/lib/cost-admission.mjs`). `off` (the default) = today's gates.
  // Every launch decision this tick (heavy and light) is recorded for the one report line.
  const costSettings = policy?.costAdmission ?? null;
  const costOn = costAdmissionOn(costSettings);
  const costDecisions = [];
  let costFacts = null;
  const readFacts = () => {
    if (costFacts) return costFacts;
    try { costFacts = effects.costFacts?.() ?? {}; } catch { costFacts = {}; }
    return costFacts;
  };
  const loadGateFor = (kind, num) => {
    const gate = effects.hostLoadGate?.(kind) ?? { admit: true };
    if (!gate.admit) {
      loadHolds.push({ num: normNum(num), kind, reason: 'host-load', why: gate.why });
      console.error(`build-dispatch-daemon: ${kind} launch of #${normNum(num)} deferred (host-load): ${gate.why}`);
    } else if (gate.note) console.error(`build-dispatch-daemon: ${kind} launch of #${normNum(num)} admitted: ${gate.note}`);
    costDecisions.push({ num: normNum(num), kind, ...admitLaunch({ kind: kind === 'prepare' ? 'prepare-item' : kind, settings: costSettings, legacy: gate }) });
    return gate;
  };
  // A LIGHT launch under the rule ON: its own budget / cap / CPU floor; the heavy host gate is not consulted.
  const lightGateFor = (kind, num, lightInFlight) => {
    const d = admitLaunch({ kind, settings: costSettings, facts: { ...readFacts(), lightInFlight } });
    costDecisions.push({ num: normNum(num), kind, ...d });
    if (!d.admit) {
      loadHolds.push({ num: normNum(num), kind, reason: d.reason, why: d.why });
      console.error(`build-dispatch-daemon: ${kind} launch of #${normNum(num)} deferred (${d.reason}): ${d.why}`);
    } else console.error(`build-dispatch-daemon: ${kind} launch of #${normNum(num)} admitted: ${d.why}`);
    return d;
  };
  const launchBuilds = async () => {
    for (const pick of plan.dispatch) {
      if (launchSlotBusy()) continue;
      const gate = loadGateFor('build', pick.num);
      if (!gate.admit) continue;
      const claim = effects.acquireClaim({ num: pick.num, scope: pick.scope });
      if (!claim.ok) { failures.push({ num: pick.num, stage: 'claim', reason: `${claim.reason}${claim.heldBy ? ` by ${claim.heldBy}` : ''}` }); continue; }
      let res;
      try { res = await effects.dispatch({ num: pick.num, bookkeeping, tick: out, tickBookkeeping, tickAt }); } catch (e) { res = { dispatching: false, reason: String(e?.message || e).split('\n')[0] }; }
      if (res?.pending) startedThisTick += 1;
      if (res?.dispatching) { dispatched.push({ num: pick.num, lane: res.lane ?? pick.lane, sessionSlug: res.sessionSlug ?? null }); if (!res.pending) effects.clearBuildFailure?.({ num: pick.num }); }
      else {
        effects.releaseClaim({ num: pick.num });
        const rec = effects.recordBuildFailure?.({ num: pick.num, reason: res?.reason ?? 'not dispatched', output: res?.output ?? res?.reason });
        if (live) surfaceCardRefusal(pick.num, rec, res);
        failures.push({ num: pick.num, stage: 'dispatch', reason: res?.reason ?? 'not dispatched', ...(res?.stepRefused ? { step: res.stepRefused.step } : {}), ...(rec ? { reasonCode: rec.reasonCode, attempts: rec.attempts, retryAfter: rec.retryAfter, output: rec.output } : {}) });
      }
    }
  };
  // Live 2026-10-09 16:47–18:28Z: prepare.planned stayed non-empty with 6 free slots for 13 ticks
  // while every slot went to a build; the slot alternates when both kinds want it.
  const preparesFirst = launchSettlement.settled.length > 0 && launchSettlement.settled.every((s) => s.kind !== 'prepare-item');
  if (live && !preparesFirst) await launchBuilds();
  // Separate durable claims use the existing lease primitive, without occupying build slots.
  // Run-store rows survive restarts; guards cover the interval before a dispatched lane is visible.
  const prepareSpawns = d.spawnPrepareItems ?? d.itemPrepareSpawns ?? [];
  const settledPrepares = new Map();
  for (const row of allSettledPrepares) {
    if (failureRecords.some(f => f.num === row.num && f.attempt === row.source && f.retry)
      && !prepareClaims.some(c => normNum(c.meta.num) === normNum(row.num))) continue;
    const num = normNum(row.num);
    if (!settledPrepares.has(num) || row.startedAt > settledPrepares.get(num).startedAt) settledPrepares.set(num, row);
  }
  // Release applies to the LATEST attempt only: pick it first, then drop it. Filtering releases before picking
  // would let an older unreleased failure resurface and re-hold an item whose latest attempt was released.
  for (const [num, row] of settledPrepares) if (releasedAttempt(releases, row.num, row.source)) settledPrepares.delete(num);
  const prepareBusy = new Set([...prepareRows.map((r) => normNum(r.num)), ...pendingLaunch.prepare]);
  const probationRecords = (await effects.listProbationPrepares?.() ?? []).map(row => ({
    ...row, evidence: row.evidence ?? releases.find(r => r.probationAttempt === `${row.handle}:${row.scoredAt}`)?.failureEvidence,
  }));
  const configuredPrepare = resolveOperationRoute({ operation: 'prepare-item', taskType: 'prepare', policy: routingPolicy });
  const fallback = configuredPrepare ? configuredPrepare.provider === 'claude' : prepareRouteFallback(probationRecords, releases);
  // Card x60i0ie — item prepares are LIGHT: with the rule ON they run under the light cap (else today's two workers).
  const prepareCap = lightCapFor('prepare-item', costSettings, 2);
  const prepare = { policyRoute: configuredPrepare, route: fallback ? 'prepare-route-fallback' : 'probation', enabled: prepareEnabled, cap: prepareCap, planned: [], launched: [], inFlight: [], failures: [], retired: [], held: [], handled: [], stamping: [] };
  prepare.launchOrder = preparesFirst ? 'prepare-first' : 'build-first';
  prepare.routeFailures = probationRecords.filter(r => r.taskType === 'prepare' && !r.pr && r.launchOutcome !== 'opened-pr' && !PREPARE_HANDLED_OUTCOMES.includes(r.launchOutcome))
    .map(r => ({ item: r.item, attempt: `${r.handle}:${r.scoredAt}`, cause: classifyPrepareFailure(r.evidence), evidence: r.evidence ?? { reason: r.launchOutcome } }));
  const finishedPrepares = new Set(completedPrepares);
  const itemPrepareAttempts = { ...out?.nextState?.itemPrepareAttempts };
  // Observation stages (a failed status read, claim contention) say nothing about the prepare attempt itself:
  // they never hold, never file a card and never enter the ledger. The caller keeps the item out of dispatch
  // for this tick only, and the next tick simply re-observes.
  const OBSERVATION_STAGES = new Set(['retirement', 'claim', 'stamp-read', 'dispatch-refused']);
  const holdStamp = (num) => { const replacesStamp = claimReplacesStamp(num); return replacesStamp === undefined ? {} : { replacesStamp }; };
  const failPrepare = async (num, stage, reason, evidence = {}, attempt = null) => {
    if (OBSERVATION_STAGES.has(stage)) {
      prepare.failures.push({ num, stage, reason, cause: 'daemon-observation', retry: true });
      return { num, stage, cause: 'daemon-observation', retry: true, held: false };
    }
    evidence = { ...evidence, reason };
    const input = { num, stage, attempt: attempt ?? `${stage}:${num}:${reason}`, evidence };
    const failure = live && effects.recordPrepareFailure
      ? await effects.recordPrepareFailure(input)
      : { ...input, cause: classifyPrepareFailure(evidence, stage), retry: false, held: true };
    prepare.failures.push({ num, stage, reason, cause: failure.cause, retry: failure.retry, prevention: failure.prevention });
    if (live && failure.held) effects.placePrepareHold({ num, reason: 'prepare-unstamped', ...holdStamp(num) });
    // An already-done report: the resolve route hold (the ledger hands it out once, stamped at record time).
    if (live && failure.routeHold) effects.placePrepareHold({ num, reason: failure.routeHold });
    if (failure.held || failure.routeHold) heldNums.add(num);
    if (failure.holdReason) needsYou.push({ num: normNum(num), step: 'prepare', reason: failure.holdReason });
    return failure;
  };
  const inspectNums = new Set([...prepareClaims.map((c) => normNum(c.meta.num)),
    ...prepareBusy, ...prepareSpawns.map((s) => normNum(s.num)),
    ...(bookkeeping.prepareGuards ?? []).filter((g) => g.kind === 'prepare-item').map((g) => normNum(g.num)),
    ...holds.filter(isPrepareHold).map((h) => normNum(h.num))]);
  for (const f of deferredLaunchFailures) {
    if (f.isPrepare) await failPrepare(f.num, f.outcome?.refused ? 'dispatch-refused' : 'dispatch', f.outcome?.reason ?? 'not dispatched', f.outcome?.evidence ?? {}, f.attempt ?? new Date().toISOString());
    else {
      const rec = live ? effects.recordBuildFailure?.({ num: f.num, reason: f.outcome?.reason ?? 'not dispatched', output: f.outcome?.output ?? f.outcome?.reason }) : null;
      if (live) surfaceCardRefusal(f.num, rec, f.outcome);
      failures.push({ num: f.num, stage: 'dispatch', reason: f.outcome?.reason ?? 'not dispatched', ...(f.outcome?.stepRefused ? { step: f.outcome.stepRefused.step } : {}), ...(rec ? { reasonCode: rec.reasonCode, attempts: rec.attempts, retryAfter: rec.retryAfter, output: rec.output } : {}) });
    }
  }
  for (const num of inspectNums) {
    if (pendingLaunch.prepare.has(num)) { prepareBusy.add(num); continue; } // 78b — launch still starting; the claim stays
    const claim = prepareClaims.find((c) => normNum(c.meta.num) === num);
    const settled = settledPrepares.get(num);
    // As with build retirement, an older attempt must not settle a fresh claim.
    // A wrapper failure needs evidence too; an exception alone is not transient. A dead-session retirement is
    // settled by its own branch below, so it must not also be read as an unstamped prepare.
    const currentSettled = settled && settled.outcome !== 'prepare-session-dead'
      && (!claim?.meta?.claimedAt || settled.startedAt >= claim.meta.claimedAt);
    const wasHeld = holds.some((h) => normNum(h.num) === num && isPrepareHold(h));
    const tracked = Boolean(claim) || prepareBusy.has(num);
    // A bare candidate (no claim, no in-flight row, no hold, no current settled attempt) has no evidence of a
    // prepare attempt: skip it, so old PRs/rows never place a hold and the per-tick probe stays bounded.
    if (!tracked && !wasHeld && !currentSettled
      && !(bookkeeping.prepareGuards ?? []).some((g) => g.kind === 'prepare-item' && normNum(g.num) === num)) continue;
    try {
      if (prepareReadErrors.has(num)) throw prepareReadErrors.get(num);
      const status = prepareStatus.has(num) ? prepareStatus.get(num)
        : await effects.readPrepareStatus?.({ num, claimedAt: claim?.meta?.claimedAt ?? settled?.startedAt, replacesStamp: claimReplacesStamp(num) });
      if (prepareRows.some(r => normNum(r.num) === num && prepareIsLive(r))) continue;
      // builder-starved-2 (2026-10-07) — a BARE spawn candidate (no claim, no hold, no guard: only an older settled
      // run row) whose card carries a stamp on main is a `prepare-stale` card the tick core asks to RE-prepare. That
      // stamp is the result of the earlier attempt the settled row records, not of a new one, so it must never mark
      // the card finished: that skipped it every tick while it kept its prepare-ahead window slot, and nothing was
      // ever prepared again (live 16:59Z–18:49Z: 0 prepares in 38 ticks, window = 4648/4647/5189, all re-prepares).
      if (!tracked && !wasHeld && status?.preparedDate && !status?.pr
        && !(bookkeeping.prepareGuards ?? []).some((g) => g.kind === 'prepare-item' && normNum(g.num) === num)
        && prepareSpawns.some((s) => normNum(s.num) === num)) continue;
      const prDone = ['MERGED', 'CLOSED'].includes(status?.pr?.state);
      const awaitingPr = status?.pr?.state === 'OPEN';
      let why = status?.preparedDate ? 'prepared on main' : prDone ? `prepare PR ${status.pr.state.toLowerCase()}` : null;
      const worker = prepareRows.find((r) => normNum(r.num) === num)?.row;
      const now = effects.now?.() ?? Date.now();
      const sessionDead = worker?.entry?.live === false
        && (now > Date.parse(worker.entry.expectedBy)
          || now - Date.parse(worker.entry.lastSeenLiveAt) > PREPARE_SESSION_DEAD_GRACE_MS);
      if (!why && sessionDead && !(awaitingPr && status.pr.preparedDate)) {
        why = 'prepare-session-dead';
      }
      // An OPEN PR only shields the claim when it is stamped; an unstamped one must not outlive a dead worker.
      if (!why && claim && !(awaitingPr && status.pr.preparedDate) && isLeaseExpired(claim, effects.now?.() ?? Date.now(), DEFAULT_LEASE_MINUTES)) {
        // Probe the worker independently: the claim owner is the long-lived daemon, not the worker.
        // A failed Claude listing stays unknown; use owner-PID fallback only when no worker row exists.
        const host = claim.owner?.slice(0, claim.owner.lastIndexOf(':'));
        const ownerPid = host === (effects.hostname?.() ?? hostname()) ? claim.pid : null;
        const liveness = classifyClaimLiveness({ row: null, ownerPid,
          isPidAlive: effects.isPidAlive ?? defaultIsPidAlive });
        const workerLiveness = worker && classifyClaimLiveness({ row: worker, ownerPid, isPidAlive: effects.isPidAlive ?? defaultIsPidAlive });
        // An explicitly dead session whose timing fields are absent/invalid can never trip the grace check above.
        const deadUntimed = worker?.entry?.live === false
          && !Number.isFinite(Date.parse(worker.entry.expectedBy)) && !Number.isFinite(Date.parse(worker.entry.lastSeenLiveAt));
        if (deadUntimed || (worker?.entry?.handle?.startsWith('pid:') && workerLiveness?.status === 'dead')
          || (!worker && liveness.status === 'dead')) why = 'dead prepare owner past heartbeat TTL';
      }
      const wasUnstamped = holds.some((h) => normNum(h.num) === num && isPrepareHold(h));
      // Live 2026-10-09 (4435/4436/4648): 8 stamp spawns per tick, worker `already-stamped`, no PR.
      // Sections of the replaced stamp are not a result of this re-prepare attempt.
      const mainHasResult = Boolean(status?.hasSections) && !status?.replacedPreparedDate;
      // A dead session that left sections behind is a finished-but-unstamped run: route it to stamp recovery.
      const deadWithWork = why === 'prepare-session-dead' && status && !status.preparedDate
        && (mainHasResult || (awaitingPr && status.pr.hasSections));
      const ended = prDone || why === 'dead prepare owner past heartbeat TTL' || wasUnstamped || deadWithWork
        || (currentSettled && !prepareBusy.has(num));
      // An open, stamped PR is a valid finished agent run awaiting landing; main is not stamped yet.
      let unstamped = status && !status.preparedDate && ended && !(awaitingPr && status.pr.preparedDate);
      const priorFailure = failureRecords.findLast(f => f.num === num && f.held && !f.completed && !releasedAttempt(releases, num, f.attempt));
      const failureHeld = Boolean(priorFailure);
      const recoverable = !failureHeld && unstamped && (mainHasResult || (awaitingPr && status.pr.hasSections));
      if (recoverable) {
        // Mechanical completion is separate from agent capacity; failures use the same evidence policy.
        if (live) effects.placePrepareHold({ num, reason: 'prepare-stamp-pending', ...holdStamp(num) });
        heldNums.add(num);
        why = 'prepare stamp recovery';
        finishedPrepares.add(num);
        prepareBusy.delete(num);
        unstamped = false;
        if (live && prepareEnabled && !plan.freeze.frozen) {
          try {
            const result = await effects.stampPrepare({ num, status });
            prepare.stamping.push({ num, ...result });
          } catch (e) {
            await failPrepare(num, 'stamp', String(e?.message || e), {}, e.prepareAttempt ?? new Date().toISOString());
          }
        }
      }
      if (wasUnstamped && awaitingPr && status.pr.preparedDate) why ??= 'stamped prepare PR awaiting landing';
      if (status?.preparedDate && wasUnstamped) {
        if (live) { effects.releasePrepareHold({ num }); effects.completePrepareFailures?.(num); }
        heldNums.delete(num);
      }
      let handledOutcome = null;
      if (unstamped) {
        // Hold BEFORE releasing, like build orphan adoption. Re-observed settled evidence renews the hold
        // after restart/expiry, so an unchanged card cannot enter a periodic prepare loop.
        const workerRow = prepareRows.find(r => normNum(r.num) === num)?.row;
        const attemptStart = claim?.meta?.claimedAt ?? settled?.startedAt ?? '';
        const probation = probationRecords.filter(r => String(r.item) === num && r.evidence && r.scoredAt >= attemptStart)
          .sort((a, b) => b.scoredAt.localeCompare(a.scoredAt))[0];
        const evidence = probation?.evidence ?? (currentSettled ? settled.evidence : null)
          ?? (workerRow ? await effects.readPrepareEvidence?.(workerRow.entry) : null) ?? {};
        const attempt = currentSettled ? settled.source : workerRow ? `run ${workerRow.runId}` : claim?.meta?.claimedAt;
        // A prepare the runner HANDLED is an outcome, not a failure: the card was routed (an already-done card has a
        // verified resolve PR out) or held with a needs-you reason. Recording it as `prepare-unstamped` filed a
        // diagnose card and left a silent hold (live #4560, #4328). The runner already placed the hold that keeps it
        // from re-preparing; here it is only surfaced.
        handledOutcome = currentSettled && PREPARE_HANDLED_OUTCOMES.includes(settled.outcome) && !priorFailure ? settled.outcome : null;
        if (handledOutcome) {
          if (handledOutcome === 'prepare-needs-you') needsYou.push({ num, step: 'prepare', reason: redactSpawnText(String(settled.evidence?.error ?? 'prepare needs you')).slice(0, 300) });
          prepare.handled.push({ num, outcome: handledOutcome });
          heldNums.add(num);
          why ??= handledOutcome;
        } else {
          const failure = priorFailure ?? await failPrepare(num, 'result', 'prepare-unstamped', evidence, attempt);
          if (priorFailure) prepare.failures.push({ ...priorFailure, reason: priorFailure.evidence?.reason ?? 'prepare-unstamped' });
          if (failure.held) prepare.held.push({ num, reason: failure.holdReason ?? 'prepare-unstamped' });
          why ??= 'prepare-unstamped';
        }
      }
      if (why === 'prepare-session-dead') {
        prepare.failures.push({ num, stage: 'retirement', reason: why });
        // The core may already have counted this guard's TTL retirement on this tick.
        itemPrepareAttempts[num] = Math.max(Number(itemPrepareAttempts[num]) || 0,
          (Number(bookkeeping.itemPrepareAttempts?.[num]) || 0) + 1);
      }
      if (why) {
        if (live && worker && !completedPrepares.has(num)) effects.settlePrepareRow?.({ runId: worker.runId, key: worker.entry.key,
          outcome: why === 'prepare-session-dead' ? why : handledOutcome ?? (unstamped ? 'prepare-unstamped' : 'prepare-retired') });
        if (claim || worker) {
          if (live && claim) effects.releasePrepareClaim({ num });
          prepare.retired.push({ num, why, released: live });
        }
        finishedPrepares.add(num);
        prepareBusy.delete(num);
      } else if (claim || awaitingPr) prepareBusy.add(num);
    } catch (e) {
      // Failed observations never mean unprepared/dead. Keep a tracked item out of dispatch until a good read;
      // a held-only item whose card left main must not pin a prepare slot forever.
      if (tracked) prepareBusy.add(num);
      await failPrepare(num, 'retirement', String(e?.message || e));
    }
  }
  for (const g of out?.nextState?.prepareGuards ?? []) {
    if (g.kind === 'prepare-item' && !failureRecords.some(f => f.num === normNum(g.num) && f.retry) && !finishedPrepares.has(normNum(g.num))
      && (bookkeeping.prepareGuards ?? []).some((old) => guardId(old) === guardId(g))) prepareBusy.add(normNum(g.num));
  }
  for (const num of heldNums) prepareBusy.delete(num);
  prepare.inFlight = [...prepareBusy];
  // Card x60i0ie — a light prepare skips an open-PR-count freeze (`lightOpenPrFreeze: skip`); a kill switch or a
  // freeze label still holds it. Rule OFF: `freezeHolds` is exactly `plan.freeze.frozen` (today).
  prepare.freezeHeld = freezeHolds('prepare-item', plan.freeze, costSettings);
  if (prepareEnabled && !prepare.freezeHeld) {
    for (const pick of prepareSpawns) {
      const num = normNum(pick.num);
      // tick-core's cap is two (the light cap with the rule ON); it may offer fewer after its own admission checks.
      if (finishedPrepares.has(num) || heldNums.has(num) || prepareBusy.has(num) || prepareBusy.size >= prepareCap) continue;
      prepare.planned.push({ ...pick, num });
      if (!live) { prepareBusy.add(num); continue; }
      if (launchSlotBusy()) continue;
      if (!(costOn ? lightGateFor('prepare-item', num, prepareBusy.size) : loadGateFor('prepare', num)).admit) continue;
      // Record the stamp this attempt starts from (`null` = unstamped), so a re-prepare's result is told from the
      // stamp it replaces by identity, not by how recent its date is. A failed read does NOT spawn: without the
      // record the claim would fall back to the date rule, which retires it on the very stamp it replaces. (An
      // effects stub without the read records nothing — only a test double lacks it.)
      let replacesStamp;
      try {
        const before = await effects.readPreparedStamp?.({ num });
        if (before) replacesStamp = before.preparedDate
          ? { preparedDate: before.preparedDate, preparedAgainstSha: before.preparedAgainstSha ?? null } : null;
      } catch (e) {
        prepareBusy.add(num);
        await failPrepare(num, 'stamp-read', String(e?.message || e));
        continue;
      }
      const claim = effects.acquirePrepareClaim({ num, scope: scopeByNum.get(num) ?? [],
        ...(replacesStamp !== undefined ? { replacesStamp } : {}) });
      if (!claim.ok) {
        prepareBusy.add(num);
        await failPrepare(num, 'claim', claim.reason);
        continue;
      }
      let res;
      try { res = await effects.dispatch({ num, bookkeeping, launchKind: 'prepare-item', prepareFallback: fallback, tick: out, tickBookkeeping, tickAt }); }
      catch (e) { res = { dispatching: false, reason: String(e?.message || e) }; }
      if (res?.pending) startedThisTick += 1;
      if (res?.dispatching) {
        prepareBusy.add(num);
        prepare.launched.push({ num, lane: res.lane ?? pick.lane, sessionSlug: res.sessionSlug ?? null });
      } else {
        effects.releasePrepareClaim({ num });
        await failPrepare(num, res?.refused ? 'dispatch-refused' : 'dispatch', res?.reason ?? 'not dispatched', res?.evidence ?? {}, res?.attempt ?? new Date().toISOString());
      }
    }
  }
  if (live && preparesFirst) await launchBuilds();
  // #4348-open-pr-retry — ONE resume pass per LIVE tick, reusing #2659's own backoff/attempt-cap state machine
  // (`scripts/conveyor/infra-blocked.mjs retry`) wholesale rather than re-deriving it here: a `blocked-on-infra`
  // PR-open (the lane ref is already pushed; `deliver-item-wrapper.mjs` now settles this as `open-pending`,
  // never `wrapper-threw`) never re-runs a build — this only ever re-invokes `pr-land`, which itself never
  // merges (memory rule 104). This is DELIBERATELY this daemon's OWN tick, not a separate standalone pass: the
  // live incident (#4348, run f4166fa3883080a9) sat stranded for 2+ hours because nothing ever ticked the
  // registered `infra-blocked` pass at all — this daemon is the one already confirmed alive and self-syncing.
  // Optional-chained so an older test stub that predates this field behaves exactly as before (no call, no
  // throw); best-effort — a retry-pass hiccup must never fail this tick's own build-dispatch plan.
  let infraRetry = null;
  if (live && typeof effects.retryInfraBlocked === 'function') {
    try { infraRetry = await effects.retryInfraBlocked(); }
    catch (e) { infraRetry = { error: String(e?.message || e).split('\n')[0] }; }
  }
  return {
    live,
    timings: { ...timer.snapshot(), tickCore: d.timings ?? {} },
    statusLine: d.statusLine || '',
    tickCore: { building: externalBuilding, spawnBuilds: spawn, held: admission.held || [], planned: admission.planned || [], queue: admission.queue || [], suppressedBuilds: d.suppressedBuilds || [] },
    plan,
    retired,
    // #4349 — items dropped from THIS tick's candidates by a non-PR terminal-outcome cooldown (never the tick
    // core's own `tickCore.held`, a different, capacity/supervision-driven concept) — visible so a `--dry-run`
    // or the live status line can say WHY an otherwise-cleared item was not offered.
    dispatchHolds: held,
    buildBackoffs,
    dispatched,
    // 78b/#4139 — launches deferred by the host-load gate, and the detached-launch settlement this tick did.
    loadHolds,
    // Card x60i0ie — the one cost-class admission line for this tick (heavy vs light, admitted/refused and why).
    costAdmission: { ...summarizeCostAdmission(costDecisions, { settings: costSettings, facts: costOn ? readFacts() : (costFacts ?? {}) }), decisions: costDecisions },
    launchSettlement,
    // Every cleared card not dispatched this tick, with the stage and reason that held it (queue-cap included).
    buildHolds: collectBuildHolds({
      queue: admission.queue || [], planHeld: admission.held || [], suppressed: d.suppressedBuilds || [],
      prepareQueueHeld: d.queueCapHeld?.prepare || [],
      policyHold: plan.hold, cooldown: held, dispatched,
      prepareBusy: spawn.map((s) => normNum(s.num)).filter((n) => prepareRows.some((r) => normNum(r.num) === n) && !completedPrepares.has(n)),
    }),
    prepare,
    failures,
    needsYou,
    // #4348-open-pr-retry — `{retried, resumed, surfaced, waiting}` from `infra-blocked.mjs retry` (or an
    // `{error}` on a best-effort failure), `null` on a dry-run tick or an older effects stub with no such call.
    infraRetry,
    // #4131/#4382 build-orphan-adopt — the array `adoptOrphanedBuildClaims()` returned (`{num, action, reason}`
    // per live claim), or an `{error}` on a best-effort failure, `null` on a dry-run tick or an older effects
    // stub with no such call.
    orphanAdoption,
    queuePrune,
    draftRecovery,
    // #4465 — `planHoldRouting`'s own plan (always present, pure) plus `routeHeldItems`'s outcome array (or an
    // `{error}` on a best-effort failure), `null` on a dry-run tick or an older effects stub with no such call.
    holdRouting,
    holdRoutingResult,
    nextBookkeeping: settleBookkeeping(bookkeeping, {
      ...out?.nextState,
      itemPrepareAttempts,
      prepareGuards: (out?.nextState?.prepareGuards ?? []).filter((g) => !finishedPrepares.has(normNum(g.num))),
    }, dispatched.map((x) => x.num), prepare.launched.map((x) => x.num)),
  };
}

// ── IO SHELL ─────────────────────────────────────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const SCRIPTS = join(REPO_ROOT, 'scripts');

/**
 * #4464 builder-cap-machine-wide (live incident 2026-09-29 ~11 ET) — `tick-core.mjs`'s own `capacity-cap`
 * (`scripts/lib/lane-concurrency.mjs`, default 8, `WE_MAX_CONCURRENT_LANES`) is a SHARED, machine-wide ceiling
 * on ALL FOUR spawn kinds at once (build/prepare/fix/ci-heal) — a deliberate, documented hardware-safety net
 * (`lane-concurrency.mjs`'s own header: a 2026-09-07 incident put a 12-core host's 1-min load average at
 * 34.95 from 42 concurrently-dispatched lanes). This daemon's OWN tick-core call reads
 * `decisions.spawnBuilds` and `decisions.spawnPrepareItems` (`runBuildDispatchTick`, above) and NEVER acts on `spawnPrepareScope`/`spawnFixes`/
 * `spawnCiHeals` from this same call at all — so gating those *unused* build candidates against the
 * MACHINE-WIDE lane count (review loops, fix dispatches, interactive `/conveyor` sessions, health
 * investigations — none of which THIS daemon dispatches or can see progress on) starves builds for activity
 * this daemon does not control. Live: 6 of 10 leased lanes were genuine builds, but the other 4 (two review
 * loops, one fix dispatch, one unrelated investigation) alone pushed the shared count past the default cap of
 * 8, so `tick-core=capacity-cap` held EVERY build candidate — including ones this daemon had real room for
 * under its OWN executor caps (Claude 1, external 4).
 *
 * OPERATOR DECISION (2026-09-29): the builder's cap bounds ONLY the builder's own concurrent builds;
 * machine-wide load is the separate load-admission gate's job (#4076, `loadAdmission`/`load-cap`) — completely
 * UNCHANGED by this override, since it is computed independently from CPU/load sampling and never reads
 * `maxConcurrentLanes` at all.
 *
 * THE FIX, and why it is SAFE: this daemon's own `policy.maxConcurrentBuilds` (enforced by `planBuildDispatch`,
 * over this daemon's OWN durable claim count — #2924's own fix keeps that count to this daemon's own builds,
 * never machine-wide activity) is ALREADY a far tighter, correctly-scoped ceiling on what this daemon actually
 * dispatches. Exempting THIS daemon's OWN tick-core call from the shared lane-count ceiling cannot let it
 * dispatch more than its executor caps regardless — `decisions.spawnBuilds` merely gets to list MORE
 * candidates than before (informational; `planBuildDispatch` still picks at most its own cap's worth), and item prepares have their own two-worker cap plus durable claims. The scope/decision prepare,
 * fix and ci-heal candidates are still discarded. `dispatch-plan.mjs` (tick-core's own child, `main()`'s `runJson` call below) reads the
 * IDENTICAL env var independently (`scripts/readiness/dispatch-plan.mjs`'s own `resolveMaxConcurrentLanes`
 * call) — set on THIS CHILD's own env only (never `process.env` itself), it propagates through the whole
 * subprocess chain for this one call without touching any OTHER caller's environment or tick-core.mjs/
 * dispatch-plan.mjs's own code at all.
 */
export const BUILD_DAEMON_LANE_CAP_EXEMPT_VALUE = '1000000';

// Card xwn53th — see `scanAcquirable` in lane-pool.mjs: opt-in reuse of a CLEAN lane's acquirable verdict.
export const CLEAN_VERDICT_MEMO_ENV = 'LANE_POOL_CLEAN_VERDICT_MEMO_MAX_AGE_MS';
export const BUILD_DAEMON_CLEAN_VERDICT_MEMO_MS = 10 * 60_000;

// EXPORTED (#4464) so a test can assert the env override directly, against an injected `exec` — mirrors this
// file's own established `{ exec = execFileSync }` seam (`cliRetryInfraBlocked`, below).
export function cliPlanTick(payload, { exec = execFileSync, config = null } = {}) {
  const snapshotDir = mkdtempSync(join(tmpdir(), 'builder-plan-'));
  try {
    const text = exec('node', [join(SCRIPTS, 'conveyor', 'tick-core.mjs')], {
      input: JSON.stringify({ bookkeeping: payload || {}, ...(config ? { config } : {}) }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, [MAX_CONCURRENT_LANES_ENV]: BUILD_DAEMON_LANE_CAP_EXEMPT_VALUE, [PLANNING_SNAPSHOT_ENV]: snapshotDir,
        // Speed only (card xwn53th): this planning read re-proved every clean lane every tick (~50 s of the tick).
        // A clean lane's verdict is reused while its stat fingerprint is unchanged and the entry is young.
        [CLEAN_VERDICT_MEMO_ENV]: process.env[CLEAN_VERDICT_MEMO_ENV] ?? String(BUILD_DAEMON_CLEAN_VERDICT_MEMO_MS) },
    });
    return JSON.parse(text);
  } finally { rmSync(snapshotDir, { recursive: true, force: true }); }
}

// #4351's own build-dispatch follow-up (guided by #4309 spend accounting) — this was the top GraphQL spender in the fleet (121
// `gh pr list` calls/3h at ~50 points each, `gh-spend.mjs report --by=caller+op`): the full 13-field
// `defaultFetchOpenPrs` query, once per constellation repo, every tick, even though `normalizeOpenPrs`/
// `prDeliversNum` (build-dispatch-policy.mjs) read only `number`/`headRefName`/`labels`/`files`. Moved onto
// `fetchOpenPrsRest` — the REST/ETag path scoped to exactly that field set (open-pr-fetch.mjs's own header) —
// so this call now spends the `core` REST bucket, not `graphql`, and repeats cost a free `304` per unchanged PR.
// EXPORTED so `breaks/build-dispatch-graphql-exhausted.mjs` (soak) can drive it directly against a PATH-faked
// `gh` that fails the `graphql` bucket but serves `core` — the exact live incident this card fixes.
export async function cliFetchOpenPrs() {
  const { fetchOpenPrsRest } = await import('../../scripts/conveyor/open-pr-fetch.mjs');
  const { CONSTELLATION_REPOS } = await import('../../scripts/lib/constellation-repos.mjs');
  const out = [];
  for (const [key, { slug }] of Object.entries(CONSTELLATION_REPOS)) {
    out.push({ repo: key, prs: fetchOpenPrsRest({ repo: slug }) });
  }
  return out;
}

// xovjhwh converge round 2 — exported (was module-private) so a test can drive it against a real, broken
// run-store directory the same way the sibling `cliListSettledBuilds` already is below, and pin the "degrades
// to `[]`, never throws" claim `deriveDispatchedByBuilder`'s own docblock makes about this exact reader.
export async function cliListRunStoreInFlight({ now = new Date(), launchKind = 'build', listAgents } = {}) {
  const { createFileRunStore } = await import('../../scripts/operations/run-store.mjs');
  const { DISPATCH_EFFECT, dispatchStillHolds } = await import('../../scripts/operations/dispatch-lane.mjs');
  const store = createFileRunStore();
  const rows = [];
  let ids = [];
  try { ids = store.list().filter((id) => id.startsWith('dispatch-lane')); } catch { return rows; }
  for (const id of ids) {
    let run;
    try { run = store.read(id); } catch { continue; }
    for (const e of run?.effects || []) {
      if (e?.status !== 'in-flight' || e.type !== DISPATCH_EFFECT || e.payload?.launchKind !== launchKind) continue;
      if (launchKind !== 'prepare-item' && !dispatchStillHolds(e, now.toISOString())) continue;
      // card xao7080 (#4518) — `e.dispatch.executor` is the durable field the io shell already writes at
      // dispatch time (`dispatch-lane-io.mjs`'s `inFlight({..., dispatch})`, #3717/#3906): the ACTUAL provider
      // (`claude`/`antigravity`/`codex`) that ran this in-flight build, never a guess. `null` for an older
      // record written before that field existed, or a stub that never sets it — reported as "provider
      // unknown" rather than defaulting to a wrong guess.
      rows.push({ num: normNum(e.payload.num), scope: e.payload.scope || [], source: `run ${id}`, executor: e.dispatch?.executor ?? null, ...(launchKind === 'prepare-item' ? { row: { runId: id, entry: e } } : {}) });
    }
  }
  if (launchKind === 'prepare-item' && rows.length) {
    const { stampLiveness, defaultListAgents } = await import('../../scripts/operations/dispatch-lane-io.mjs');
    const stamped = stampLiveness({ runs: rows.map(r => r.row.entry) }, { listAgents: listAgents ?? defaultListAgents });
    rows.forEach((r, i) => { r.row.entry = stamped.runs[i]; });
    // A handle-less row with unknown liveness (a launch that failed or timed out before a session existed) has no
    // worker to probe, so nothing but the clock backstop can ever age it out; keep that one guard for it.
    return rows.filter((r) => r.row.entry.live != null || r.row.entry.handle || dispatchStillHolds(r.row.entry, now.toISOString()));
  }
  return rows;
}

/**
 * Every SETTLED (`applied`/`failed` — the only two terminal {@link EFFECT_STATUSES}, never merely "not
 * `in-flight`", which would also match a pre-dispatch `declared`/`pending` entry with no result at all) `build`
 * dispatch effect on disk, `{num, outcome, source, startedAt}`. `outcome` is `result?.outcome` when the wrapper
 * settled it (`deliver-item-settle.mjs`), or the literal string `'wrapper-failed'` for a `failed` entry with no
 * `result` (an exception the wrapper caught but could not further classify) — either way, `'pr-opened'` is the
 * one outcome `doneWhy` above treats as NOT a reason to retire the claim on its own (the PR-observed path
 * already owns that). `startedAt` is the ATTEMPT's own dispatch time (stamped once per run by
 * `effect-executor.mjs` when the effect goes in-flight) — the ordering key `doneWhy` uses to tell a fresh
 * attempt's own settle apart from an older, already-superseded one for the same item. EXPORTED so a test can
 * drive this against real on-disk run-store state, not just a hand-fed stub.
 */
export async function cliListSettledBuilds({ launchKind = 'build' } = {}) {
  const { createFileRunStore } = await import('../../scripts/operations/run-store.mjs');
  const { DISPATCH_EFFECT } = await import('../../scripts/operations/dispatch-lane.mjs');
  const store = createFileRunStore();
  const rows = [];
  let ids = [];
  try { ids = store.list().filter((id) => id.startsWith('dispatch-lane')); } catch { return rows; }
  for (const id of ids) {
    let run;
    try { run = store.read(id); } catch { continue; }
    for (const e of run?.effects || []) {
      if (e.type !== DISPATCH_EFFECT || e.payload?.launchKind !== launchKind) continue;
      if (e.status !== 'applied' && e.status !== 'failed') continue;
      const outcome = e.result?.outcome ?? (e.status === 'failed' ? 'wrapper-failed' : launchKind === 'prepare-item' ? 'prepare-ended' : null);
      if (!outcome) continue;
      const startedAt = typeof e.startedAt === 'string' ? e.startedAt : '';
      rows.push({ num: normNum(e.payload.num), outcome, source: `run ${id}`, startedAt, ...(launchKind === 'prepare-item' ? { evidence: cliPrepareFailureEvidence(e) } : {}) });
    }
  }
  return rows;
}

// Speed only (tick-overrun card xwn53th): the evidence read below scans every project dir for the transcript and
// reads the WHOLE file, for every settled prepare row, on every tick (~14 s p50 in the live daemon). A transcript
// of a settled attempt does not change, so the parsed answer is reused while the file's size + mtime are the
// same, and a "no transcript found" answer is reused while no project directory has changed (a new transcript
// file bumps its directory's mtime). Any change re-reads exactly as before; the returned evidence is identical.
// Both maps are BOUNDED (insertion-ordered, least-recently-used evicted past the cap; a hit re-inserts): the daemon is a long-lived process and
// every distinct settled-prepare handle would otherwise add an entry for its whole life. Eviction only costs a
// re-read, never a wrong answer.
export const EVIDENCE_CACHE_MAX_ENTRIES = 256;
const evidenceTranscripts = new Map(); // `${projects}\0${handle}` -> { file, size, mtimeMs, terminal }
const evidenceMisses = new Map(); // `${projects}\0${handle}` -> digest of the directory signature at the time of the miss
function setBounded(map, key, value) {
  map.delete(key); // re-insert at the newest end
  map.set(key, value);
  while (map.size > EVIDENCE_CACHE_MAX_ENTRIES) map.delete(map.keys().next().value);
}
const projectsSignature = (projects, dirs) => {
  const stamp = (p) => { try { return statSync(p).mtimeMs; } catch { return -1; } };
  const raw = `${stamp(projects)}|${dirs.map((d) => `${d}:${stamp(join(projects, d))}`).join(',')}`;
  return createHash('sha1').update(raw).digest('hex'); // a digest, not the string that grows with the dir count
};
/** Test seam: forget every cached transcript answer. */
export function clearPrepareEvidenceCache() { evidenceTranscripts.clear(); evidenceMisses.clear(); }
/** Test seam: how many answers the two evidence caches hold right now. */
export function prepareEvidenceCacheSizes() { return { transcripts: evidenceTranscripts.size, misses: evidenceMisses.size }; }

/** Read terminal observations only. Prompts are instructions, not evidence that a failure occurred. */
export function cliPrepareFailureEvidence(entry, { projects = join(homedir(), '.claude', 'projects') } = {}) {
  if (entry.result?.evidence) return entry.result.evidence;
  const evidence = { error: entry.result?.detail ?? entry.error ?? null };
  const handle = entry.handle;
  // A short handle would prefix-match another session's transcript and misattribute its evidence.
  if (!handle || handle.startsWith('pid:') || handle.length < 6) return evidence;
  const finish = (file, terminal) => {
    evidence.terminal = terminal;
    evidence.transcript = file;
    evidence.stoppedBeforeCompletion = /runner owns/i.test(terminal) && /no stamp|did not.*(?:stamp|commit|PR)/is.test(terminal);
    return evidence;
  };
  const cacheKey = `${projects}\0${handle}`;
  const cached = evidenceTranscripts.get(cacheKey);
  if (cached) {
    try {
      const st = statSync(cached.file);
      if (st.size === cached.size && st.mtimeMs === cached.mtimeMs) {
        setBounded(evidenceTranscripts, cacheKey, cached); // a hit refreshes recency: LRU, so a hot set under the cap never thrashes
        return finish(cached.file, cached.terminal);
      }
    } catch { /* gone or unreadable: re-scan below */ }
    evidenceTranscripts.delete(cacheKey);
  }
  // Runs on every tick for every settled prepare row: an unreadable dir or a transcript rotated mid-scan
  // must degrade to the base evidence, never throw out of the tick.
  try {
    if (!existsSync(projects)) return evidence;
    const projectDirs = readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory());
    const signature = projectsSignature(projects, projectDirs.map((d) => d.name));
    if (evidenceMisses.get(cacheKey) === signature) { setBounded(evidenceMisses, cacheKey, signature); return evidence; }
    let scanComplete = true;
    for (const project of projectDirs) {
      const dir = join(projects, project.name);
      let file;
      // A directory that cannot be read this tick may hold the transcript: skip it, but never cache the miss.
      try { file = readdirSync(dir).find(name => name.startsWith(handle) && name.endsWith('.jsonl')); } catch { scanComplete = false; continue; }
      if (!file) continue;
      let terminal = '';
      const path = join(dir, file);
      // Stat BEFORE reading: a write racing the read changes the stat, so the entry just misses next time.
      const before = statSync(path);
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; } // a transcript may end in a partial write
        if (row.type !== 'assistant') continue;
        const content = row.message?.content;
        const text = Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '';
        if (text) terminal = text;
      }
      setBounded(evidenceTranscripts, cacheKey, { file: path, size: before.size, mtimeMs: before.mtimeMs, terminal });
      return finish(path, terminal);
    }
    if (scanComplete) setBounded(evidenceMisses, cacheKey, signature);
  } catch { /* fall through to the base evidence */ }
  return evidence;
}

/** Every live non-PR-terminal-outcome cooldown (`not-ready`, `gate-red`, …; see `build-dispatch-claim.mjs`'s
 *  own header). EXPORTED so a test can drive this against a real hold, not just a hand-fed stub. */
export function cliListHolds() {
  // An unstamped result needs a corrected card, not a cooldown followed by the identical prepare.
  return listBuildDispatchHolds({ holdMinutes: Infinity })
    .filter((h) => ['prepare-unstamped', 'prepare-stamp-pending'].includes(h.meta.reason) || !isLeaseExpired(h, Date.now(), DEFAULT_BUILD_DISPATCH_HOLD_MINUTES))
    .map((h) => ({ num: normNum(h.meta.num), reason: h.meta.reason ?? null,
      ...('replacesStamp' in h.meta ? { replacesStamp: h.meta.replacesStamp } : {}) }));
}

/** The dispatch-lane argv + env for one launch, with its bookkeeping/tick handoff files written under `dir`. */
function prepareDispatchLaunch({ num, bookkeeping, launchKind = 'build', prepareFallback = false, tick, tickBookkeeping, tickAt }, dir) {
  const file = join(dir, 'bookkeeping.json');
  // dispatch-lane reuses the supplied tick, falling back to a re-read if the handoff is invalid.
  // Keep that re-read under the same lane-cap policy as cliPlanTick; otherwise a planned
  // prepare can disappear and be reported as the build-only needs-prepare hold.
  // Its model override travels in JSON argv plus a recorded reason, not a run.mjs control flag.
  writeFileSync(file, JSON.stringify({ bookkeeping: bookkeeping || {} }), { mode: 0o600 });
  const argv = [join(SCRIPTS, 'operations', 'run.mjs'), 'dispatch-lane', `--num=${num}`, `--bookkeepingFile=${file}`, '--json'];
  // `at` is the PLAN time (`tickAt`), so dispatch-lane's under-5-min bound measures the plan's real age. A
  // caller that cannot say when the plan was made hands off nothing: dispatch-lane re-plans.
  if (tick && Number.isFinite(Date.parse(tickAt))) {
    const tickFile = join(dir, 'tick.json');
    writeFileSync(tickFile, JSON.stringify({
      at: tickAt,
      bookkeepingHash: createHash('sha256').update(JSON.stringify({ bookkeeping: tickBookkeeping || {} })).digest('hex'),
      tick,
    }), { mode: 0o600 });
    argv.push(`--tickFile=${tickFile}`);
  }
  const env = { ...process.env, ...routingPolicyEnv(), ...(launchKind === 'prepare-item' && prepareFallback ? { WE_PROBATION_LAUNCH: 'off' } : {}), [MAX_CONCURRENT_LANES_ENV]: BUILD_DAEMON_LANE_CAP_EXEMPT_VALUE, WE_DISPATCH_RESERVE_LANE: '1' /* x87v3ed: lease the lane before the session launches */, WE_BUILD_DISPATCH_MODE: process.env.WE_BUILD_DISPATCH_MODE || 'mechanical' };
  return { argv, env };
}

export function cliDispatch(args, { exec = execFileSync } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'build-dispatch-daemon-'));
  try {
    const { argv, env } = prepareDispatchLaunch(args, dir);
    const text = exec('node', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, cwd: REPO_ROOT, env });
    return readDispatchOutcome(text);
  } catch (e) {
    if (e?.stdout) {
      const outcome = readDispatchOutcome(e.stdout);
      if (!outcome.dispatching && outcome.reason && !['unparseable dispatch-lane output', 'no verdict in dispatch-lane output'].includes(outcome.reason)) return outcome;
    }
    // Redact BEFORE cutting (a cut inside `--settings {"env":{"GH_TOKEN":"…` leaves a credential no pattern can match):
    // this reason is persisted in the failure ledgers and printed in the tick result.
    return { dispatching: false, reason: redactSpawnText(String(e?.stderr || e?.message || e)).replace(/\s+/g, ' ').slice(0, 400) };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

const pendingLaunchesRoot = () => join(resolveCoordinationRoot(), PENDING_LAUNCHES_DIRNAME);

/**
 * 78b — the NON-BLOCKING launch: spawn `dispatch-lane` detached, record it, return at once. The caller's claim stays
 * held; a later tick settles the launch ({@link cliSettleLaunches}). `pending: true` marks the result as "started,
 * not yet confirmed" — never a failure.
 */
export function cliDispatchDetached(args, { spawn, root = pendingLaunchesRoot() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'build-dispatch-daemon-'));
  try {
    const { argv, env } = prepareDispatchLaunch(args, dir);
    const record = startDetachedLaunch({ root, num: args.num, kind: args.launchKind ?? 'build', argv, env, cwd: REPO_ROOT, workDir: dir, ...(spawn ? { spawn } : {}) });
    return { dispatching: true, pending: true, lane: null, sessionSlug: null, attempt: record.attempt };
  } catch (e) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    return { dispatching: false, reason: `launch-spawn-failed: ${redactSpawnText(String(e?.message || e)).replace(/\s+/g, ' ').slice(0, 300)}` };
  }
}

/** Settle detached launches; a "launch not confirmed" outcome is first checked against live sessions. */
export async function cliSettleLaunches({ root = pendingLaunchesRoot(), isPidAlive = defaultIsPidAlive, now = Date.now, confirmed = null } = {}) {
  const { pending, settled } = settleLaunches({ root, readOutcome: readDispatchOutcome, isPidAlive, now });
  for (const s of settled) {
    if (!s.outcome.dispatching && /launch not confirmed/.test(s.outcome.reason ?? '') && confirmed) {
      try {
        if (await confirmed({ num: s.record.num, kind: s.record.kind })) s.outcome = { ...s.outcome, dispatching: true, confirmedBy: 'live-session' };
      } catch { /* an unreadable liveness stays a failure the next attempt retries */ }
    }
  }
  return { pending: pending.map((r) => ({ num: r.num, kind: r.kind, pid: r.pid, startedAt: r.startedAt })),
    settled: settled.map((s) => ({ num: s.record.num, kind: s.record.kind, attempt: s.record.attempt, outcome: s.outcome })) };
}

/** A launch whose result file said "not confirmed" still counts as launched when a live run-store row exists for it. */
export async function cliLaunchConfirmed({ num, kind }) {
  const launchKind = kind === 'prepare-item' ? 'prepare-item' : 'build';
  const rows = await cliListRunStoreInFlight({ launchKind });
  return rows.some((r) => normNum(r.num) === normNum(num) && (launchKind === 'build' || r.row?.entry?.live !== false));
}

/** Host-load gate for NEW launches (#4139's shared helper). Fails open on an unreadable load. */
export function cliHostLoadGate(kind = 'build', opts = {}) {
  if (kind && typeof kind === 'object') { opts = kind; kind = 'build'; }
  const { env = process.env, loadavg = () => os.loadavg()[0], cpuCount = () => os.cpus().length, sample } = opts;
  try { return gateHost({ kind, env, loadavg, cpuCount, ...(sample ? { sample } : {}) }); }
  catch { return { admit: true }; }
}

/** Card xu1nixv — the builder's `main-red` freeze from the health watch's published main-red record (TTL'd). */
function cliMainRedFreeze() {
  return mainRedBuildFreeze(readMainRedState(), { setting: resolveFreezeMainRed(), now: Date.now() });
}

function cliKillSwitch() {
  const killFilePath = join(resolveCoordinationRoot(), KILL_SWITCH_FILENAME);
  return readKillSwitch({ env: process.env, killFileExists: existsSync(killFilePath), killFilePath });
}

/**
 * #4348-open-pr-retry — where the OPERATOR'S PRIMARY WE checkout lives, so THIS daemon (which may run from a
 * genuinely DIFFERENT checkout — e.g. a dedicated daemon host clone with no git-alternates relationship to the
 * primary at all) can still find the SAME `.conveyor/infra-blocked.json` that `pr-land.mjs` actually wrote the
 * resumable handle into. `infra-blocked.mjs`'s own header says its store is "the PRIMARY checkout's session
 * sidecar" and assumes "the retry pass reads from the primary" — true when the retry pass ran from the primary
 * itself, and silently broken once a build-dispatch daemon split (#3383) moved this tick onto its own,
 * independent checkout: confirmed live for #4348 (run f4166fa3883080a9) — the record sat correctly written at
 * `~/workspace/webeverything/.conveyor/infra-blocked.json` while this daemon's own checkout has no
 * `.conveyor/` directory at all, so an un-pointed retry call would silently no-op forever (`readInfraStore`
 * returns `[]` for a missing file, never an error).
 *
 * Mirrors `coordination-root.mjs`'s own `~/workspace/`-relative convention (#3383) — that file already bakes
 * in this operator's layout for the build-dispatch claim/hold family; `WE_PRIMARY_CHECKOUT` overrides it here
 * the same way `WE_COORDINATION_ROOT` overrides that one. Returns `{}` (no override) when neither the env var
 * nor the default path resolves to a real `.conveyor/infra-blocked.json` — a host where this daemon genuinely
 * IS the primary, or one with a different layout entirely, sees no change from `infra-blocked.mjs`'s own
 * default (today's behaviour, unchanged).
 */
export function primaryInfraStoreEnv({ env = process.env, home = homedir() } = {}) {
  // An EXPLICIT `CONVEYOR_INFRA_FILE` is the operator's choice — never override it with the default layout.
  if ((env.CONVEYOR_INFRA_FILE || '').trim()) return {};
  const root = (env.WE_PRIMARY_CHECKOUT || '').trim() || join(home, 'workspace', 'webeverything');
  const file = join(root, '.conveyor', 'infra-blocked.json');
  return existsSync(file) ? { CONVEYOR_INFRA_FILE: file } : {};
}

/**
 * #4348-open-pr-retry — ONE `infra-blocked.mjs retry` pass, shelled exactly like `runner.mjs`'s own per-repo
 * mechanical-pass call (`run('conveyor/infra-blocked.mjs', ['retry'], 'we', repo)`), reusing its whole
 * backoff/attempt-cap/resume state machine (#2659) rather than re-deriving any of it here. Best-effort: a
 * malformed/unparseable result or a spawn failure never throws past this function — {@link runBuildDispatchTick}
 * already wraps its own call in try/catch, but this stays defensive on its own too, matching every other
 * `cli*` shell function in this file. `exec`/`env`/`home` are injectable so a test can assert the child env
 * really carries the primary store path (that env line IS the #4348 fix).
 *
 * #4517 — `timeoutMs` (default {@link INFRA_RETRY_TIMEOUT_MS}) bounds the child via `execFileSync`'s own
 * `timeout`/`killSignal` options, so a slow nested `pr-land --label-on-green` CI wait can never block this call
 * — and therefore the daemon tick that `await`s it — past that bound. A killed-on-timeout result carries
 * `timedOut: true` (detected from `e.signal === 'SIGTERM'` or `e.code === 'ETIMEDOUT'`) so a caller/log can tell
 * a bound-triggered stop apart from a real spawn/parse error; either way the retry is simply retried next tick
 * (idempotent — #2659's own backoff design already tolerates a repeated attempt). This bounds ONLY the direct
 * `node infra-blocked.mjs retry` child; a `pr-land` grandchild it may itself be waiting on is not signaled and
 * can outlive the bound as a harmless orphan (its own stdio is independently piped by `infra-blocked.mjs`'s own
 * `execFileSync` call, never inherited from this one, so an orphaned grandchild cannot hold this call's pipes
 * open or delay its return — see this file's own test for a real, non-fake-exec proof of exactly that shape). */
export function cliRetryInfraBlocked({
  exec = execFileSync, env = process.env, home = homedir(), timeoutMs = INFRA_RETRY_TIMEOUT_MS,
} = {}) {
  try {
    const text = exec('node', [join(SCRIPTS, 'conveyor', 'infra-blocked.mjs'), 'retry'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, cwd: REPO_ROOT,
      timeout: timeoutMs, killSignal: 'SIGTERM',
      env: { ...env, ...primaryInfraStoreEnv({ env, home }) },
    });
    return JSON.parse(text || '{}');
  } catch (e) {
    const timedOut = e?.signal === 'SIGTERM' || e?.code === 'ETIMEDOUT';
    return {
      error: String(e?.stderr || e?.message || e).replace(/\s+/g, ' ').slice(0, 400),
      ...(timedOut ? { timedOut: true } : {}),
    };
  }
}

/**
 * #4465 — spawn ONE detached landing attempt for a routed hold (`already-done`/`out-of-scope`), the same
 * `setsid`+`.unref()` shape a `build` dispatch's own delivery wrapper already uses
 * (`scripts/operations/detached-dispatch.mjs#defaultSpawnDetached`) — a lane-acquire→edit→PR arc is minutes,
 * far longer than this daemon's own tick, so it must never run inline here. Logs go beside the daemon's own
 * dispatch logs so a stuck landing is discoverable the same way a stuck build dispatch already is.
 */
export async function cliSpawnHoldLand(entry) {
  const { defaultSpawnDetached, deliveryDispatchLogPath } = await import('../../scripts/operations/detached-dispatch.mjs');
  const argv = [
    join(SCRIPTS, 'operations', 'build-dispatch-hold-route-land.mjs'),
    `--num=${entry.num}`, `--route=${entry.route}`,
  ];
  if (entry.commit) argv.push(`--commit=${entry.commit}`);
  if (entry.reason) argv.push(`--reason=${entry.reason}`);
  const logPath = deliveryDispatchLogPath(`hold-route-${entry.num}`, REPO_ROOT);
  return defaultSpawnDetached(argv, { cwd: REPO_ROOT, logPath });
}

/** #4465 — the real IO wiring for `runBuildDispatchTick`'s `effects.routeHeldItems`: dedup via
 *  `reserveHoldRoute`, spawn a detached landing for (a)/(b), record a finding for (c). Deliberately wires no
 *  release effect at all — see `routeHeldItems`'s own docblock (we:scripts/conveyor/build-dispatch-hold-router.mjs)
 *  for why every route leaves the build-dispatch hold (and, for (a)/(b), the dedup lease) to self-expire on
 *  its own TTL rather than being released the moment this call returns. ASYNC — `routeHeldItems` awaits
 *  `spawnLand` internally, so a rejected detached-spawn promise is captured per-item, never left as an
 *  unhandled rejection that could kill this resident daemon; `runBuildDispatchTick` already `await`s this. */
export async function cliRouteHeldItems(plan) {
  return routeHeldItems({
    plan,
    reserveRoute: reserveHoldRoute,
    spawnLand: cliSpawnHoldLand,
    recordFinding: appendHoldFinding,
  });
}

/** Predict the executor for admission and the dry run — the SAME `decideDispatchRoute` dispatch-lane calls, with the
 *  item's `deliveryAgent:` override honoured as the mechanical build mode would. Admission prediction: dispatch-lane
 *  recomputes it at dispatch time. */
export async function cliPredictRoute(num, scope, { root = REPO_ROOT, env = process.env, loadItems, scorecards, sizePolicy, promotions } = {}) {
  try {
    const { resolveDispatchRoute: decideDispatchRoute } = await import('../../scripts/lib/dispatch-routing-policy-io.mjs');
    const io = await import('../../scripts/operations/dispatch-lane-io.mjs');
    const { readItemDeliveryAgentOverride } = await import('../../scripts/operations/delivery-agent-marker.mjs');
    const { probationLaunchDecision, probationLaunchFromEnv } = await import('../../scripts/operations/dispatch-providers/probation-worker.mjs');
    const item = io.findItem(num, loadItems ?? (() => io.defaultLoadItems(root)));
    if (!item) throw new Error(`cannot predict route: missing item #${num}`);
    const { dispatchModesFromEnv } = await import('../../scripts/operations/dispatch-provider-registry.mjs');
    const mechanical = dispatchModesFromEnv({ ...env, WE_BUILD_DISPATCH_MODE: env.WE_BUILD_DISPATCH_MODE || 'mechanical' }).build === 'mechanical';
    const override = mechanical ? readItemDeliveryAgentOverride(num, { root }) : null;
    const r = decideDispatchRoute({
      kind: 'build', cause: null, scopePaths: item.scope, size: item.size ?? null,
      risk: item.risk ?? null, tags: item.tags ?? [],
      taskKey: { storyRef: num, round: 1, taskId: 'build' }, ...(override || {}),
    }, {
      scorecards: scorecards ?? io.defaultReadScorecards(), sizePolicy: sizePolicy ?? io.defaultReadSizePolicy({ root }), promotions: promotions ?? io.defaultReadPromotions({ root }),
    });
    const probation = probationLaunchDecision({ launchKind: 'build', probationWorker: r.probationWorker }, probationLaunchFromEnv(env));
    const executor = probation.launch ? r.probationWorker.executor : r.executed;
    return {
      executor,
      marker: override?.deliveryAgent ?? null,
      taskType: r?.taskType ?? null,
      routed: r?.routed ?? null,
      executed: r?.executed ?? null,
      model: r?.model ?? null,
      refusal: r?.refusal ?? null,
      gate: (r?.auditTrail || []).filter((a) => /critical|gate|override/i.test(JSON.stringify(a))).map((a) => a.detail || a.reason || a.rule || JSON.stringify(a)).slice(0, 2),
    };
  } catch (e) {
    return { error: String(e?.message || e).split('\n')[0] };
  }
}

const defaultExecAsync = (cmd, args, opts) => new Promise((resolveExec, rejectExec) => {
  execFile(cmd, args, { ...opts, maxBuffer: opts?.maxBuffer }, (err, out) => err ? rejectExec(err) : resolveExec(out));
});

// Content-addressed statuses remain valid across ticks, even when origin/main advances.
const prepareBlobStatuses = new Map();

/** Tick-scoped main snapshot and prepare PR discovery. Unavailable observations always throw. */
export function createPrepareStatusReader({ exec = execFileSync, execAsync = null, prefetchConcurrency = 8 } = {}) {
  // maxBuffer is explicit: the default 1 MiB overflows on a large backlog tree / card batch (cf. 21ce5ea4b).
  const opts = { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, maxBuffer: 64 * 1024 * 1024 };
  const ITEM_PR_LIMIT = 100;
  let tree, treeError, listing, prError, minClaimedAt;
  const itemListings = new Map();
  function readTree() {
    retryTransientGit(() => exec('git', ['fetch', '-q', 'origin', 'main'], opts));
    const output = exec('git', ['ls-tree', '-r', 'origin/main', '--', 'backlog/'], opts);
    const cards = new Map();
    for (const line of output.trim().split('\n')) {
      const match = line.match(/^\d+ blob ([0-9a-f]+)\t(backlog\/(\d+)-.*\.md)$/);
      if (match && !cards.has(normNum(match[3]))) cards.set(normNum(match[3]), { sha: match[1], path: match[2] });
    }
    return cards;
  }
  function loadTree() {
    if (treeError) throw treeError;
    if (tree) return tree;
    try { tree = readTree(); return tree; } catch (error) { treeError = error; throw error; }
  }
  function loadBlobs(cards) {
    const shas = [...new Set(cards.map(c => c.sha))].filter(sha => !prepareBlobStatuses.has(sha));
    if (!shas.length) return;
    const output = exec('git', ['cat-file', '--batch'], { ...opts, encoding: null,
      stdio: ['pipe', 'pipe', 'pipe'], input: shas.join('\n') + '\n' });
    const bytes = Buffer.from(output);
    const statuses = [];
    let offset = 0;
    for (const sha of shas) {
      const end = bytes.indexOf(10, offset);
      const header = end < 0 ? null : bytes.subarray(offset, end).toString('ascii').match(/^([0-9a-f]+) blob (\d+)$/);
      const size = header ? Number(header[2]) : NaN;
      const start = end + 1;
      if (!header || header[1] !== sha || !Number.isSafeInteger(size) || start + size >= bytes.length || bytes[start + size] !== 10) {
        throw new Error(`prepare card blob ${sha} unavailable or malformed`);
      }
      statuses.push([sha, stampedCardStatus(bytes.subarray(start, start + size).toString('utf8'))]);
      offset = start + size + 1;
    }
    if (offset !== bytes.length) throw new Error('unexpected prepare card batch output');
    for (const [sha, status] of statuses) prepareBlobStatuses.set(sha, status);
  }
  function ghPrList(search, limit) {
    const list = JSON.parse(exec('gh', ['pr', 'list', '--repo', CONSTELLATION_REPOS.we.slug, '--state', 'all',
      '--search', search, '--json', 'number,state,headRefName,headRefOid,createdAt,isCrossRepository', '--limit', String(limit)], opts));
    if (!Array.isArray(list)) throw new Error('prepare PR listing unavailable');
    return list;
  }
  /** The shared listing, with the date floor and limit it was actually fetched with. */
  function listPrs() {
    if (prError) throw prError;
    if (listing) return listing;
    try {
      const floor = minClaimedAt?.slice(0, 10);
      const limit = floor ? 500 : 1000;
      const prs = ghPrList(`head:lane/${floor ? ` created:>=${floor}` : ''}`, limit);
      return (listing = { prs, floor, complete: prs.length < limit });
    } catch (error) { prError = error; throw error; }
  }
  /** One item's own listing: the fallback when the shared one cannot be trusted. Saturation fails closed. */
  function itemPrs(num) {
    const key = normNum(num);
    if (!itemListings.has(key)) {
      const prs = ghPrList(`head:lane/${key}-prepare-`, ITEM_PR_LIMIT);
      if (prs.length >= ITEM_PR_LIMIT) throw new Error(`prepare PR listing for #${key} saturated at ${ITEM_PR_LIMIT}`);
      itemListings.set(key, prs);
    }
    return itemListings.get(key);
  }
  /**
   * The shared listing answers only when it is provably complete for this read: not capped (a truncated listing is
   * indistinguishable from "no PR"), and dated no later than this read's claim (a read with an earlier or missing
   * claim date can have its PR outside the date window). Otherwise fall back to the item's own search.
   */
  function prsFor(num, claimedAt) {
    const floor = listing ? listing.floor : minClaimedAt?.slice(0, 10);
    if (!floor || (claimedAt && claimedAt.slice(0, 10) >= floor)) {
      const shared = listPrs();
      if (shared.complete) return shared.prs;
    }
    return itemPrs(num);
  }
  /** Would `prsFor` fall back to this item's own listing? Mirrors its test exactly; never throws. */
  function needsItemListing(num, claimedAt) {
    if (itemListings.has(normNum(num))) return false;
    const floor = listing ? listing.floor : minClaimedAt?.slice(0, 10);
    if (!floor || (claimedAt && claimedAt.slice(0, 10) >= floor)) {
      try { if (listPrs().complete) return false; } catch { return false; } // the lazy read rethrows the cached error
    }
    return true;
  }
  /**
   * Item 94 — when the shared listing cannot answer (a held card with no claim date leaves the date floor unset, so
   * the 1000-PR cap saturates it), every read paid one sequential `gh pr list` (~0.5 s). Fetch exactly those same
   * per-item listings concurrently instead, up front. Same commands, same results, same saturation check; a failed
   * prefetch is dropped so the lazy read hits (and reports) the same failure it always did.
   */
  async function prefetchItemListings(entries) {
    const todo = [...new Set(entries.filter(e => {
      const card = tree?.get(normNum(e.num));
      if (!card) return false;
      const stamped = prepareBlobStatuses.get(card.sha);
      if (stamped?.preparedDate && stampCoversClaim(stamped.preparedDate, e.claimedAt,
        { replaces: undefined, preparedAgainstSha: stamped.preparedAgainstSha })) return false;
      return needsItemListing(e.num, e.claimedAt);
    }).map(e => normNum(e.num)))];
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const key = todo[next++];
        try {
          const prs = JSON.parse(await execAsync('gh', ['pr', 'list', '--repo', CONSTELLATION_REPOS.we.slug, '--state', 'all',
            '--search', `head:lane/${key}-prepare-`, '--json', 'number,state,headRefName,headRefOid,createdAt,isCrossRepository',
            '--limit', String(ITEM_PR_LIMIT)], opts));
          if (Array.isArray(prs) && prs.length < ITEM_PR_LIMIT) itemListings.set(key, prs);
        } catch { /* the lazy read repeats this call and reports its own failure */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(prefetchConcurrency, todo.length) }, worker));
  }
  return {
    prime(items) {
      const entries = items.map(item => typeof item === 'object' ? item : { num: item });
      minClaimedAt = entries.length && entries.every(item => item.claimedAt)
        ? entries.map(item => item.claimedAt).sort()[0] : undefined;
      if (entries.length) loadBlobs(entries.map(item => loadTree().get(normNum(item.num))).filter(Boolean));
      return execAsync && entries.length ? prefetchItemListings(entries) : undefined;
    },
    /**
     * The card's stamp on origin/main RIGHT NOW — a fresh fetch, never this reader's tick-start snapshot (a stamp that
     * landed since would be recorded as the one being replaced and then read as the result), and no PR lookup. A claim
     * records it when a prepare is spawned.
     */
    stamp({ num }) {
      const card = readTree().get(normNum(num));
      if (!card) throw new Error(`prepare card #${num} not found on origin/main`);
      loadBlobs([card]);
      return prepareBlobStatuses.get(card.sha);
    },
    read({ num, claimedAt, replacesStamp }) {
      const card = loadTree().get(normNum(num));
      if (!card) throw new Error(`prepare card #${num} not found on origin/main`);
      loadBlobs([card]);
      const stamped = prepareBlobStatuses.get(card.sha);
      const { path } = card;
      // Card 80 — the stamp the claim recorded at spawn is the one a re-prepare (`prepare-stale`) is replacing, not
      // its result: read it as unprepared so the claim is not retired at once, and look for the attempt's PR. Judged
      // by stamp identity (date + sha) when the claim recorded one, never by date proximity alone — a drift re-prepare
      // can start hours after the stamp it replaces.
      if (stamped.preparedDate && stampCoversClaim(stamped.preparedDate, claimedAt,
        { replaces: replacesStamp, preparedAgainstSha: stamped.preparedAgainstSha })) return { ...stamped, path };
      const main = stamped.preparedDate ? { ...stamped, preparedDate: null, replacedPreparedDate: stamped.preparedDate } : stamped;
      // Same-repo only: a fork PR with a lookalike branch name must never retire a claim or place a hold.
      const pr = prsFor(num, claimedAt).filter(p => !p.isCrossRepository && p.headRefName.startsWith(`lane/${normNum(num)}-prepare-`)
        && (!claimedAt || p.createdAt >= claimedAt)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!pr) return { ...main, path, pr: null };
      let status = { preparedDate: null };
      if (pr.state === 'OPEN') {
        if (!pr.headRefOid) throw new Error('prepare PR head unavailable');
        const key = { kind: 'prepare-card', repo: CONSTELLATION_REPOS.we.slug, num: pr.number, sha: pr.headRefOid };
        status = readShaCache(key);
        if (status === undefined) {
          const file = JSON.parse(exec('gh', ['api', `repos/${CONSTELLATION_REPOS.we.slug}/contents/${path}?ref=${encodeURIComponent(pr.headRefOid)}`], opts));
          if (file.encoding !== undefined && file.encoding !== 'base64') throw new Error('unreadable prepare card encoding');
          if (typeof file.content !== 'string') throw new Error('prepare card content unavailable');
          status = stampedCardStatus(Buffer.from(file.content, 'base64').toString('utf8'));
          writeShaCache({ ...key, value: status });
        }
      }
      return { ...main, path, pr: { ...pr, ...status } };
    },
  };
}

/**
 * A card's prepare status plus the main sha its stamp was written against. With the date it names WHICH prepare
 * produced the stamp, which is how a re-prepare's result is told from the stamp it replaces (card 80).
 */
function stampedCardStatus(raw) {
  const sha = readField(raw, 'preparedAgainstSha');
  return { ...prepareCardStatus(raw), ...(/^[0-9a-f]{7,64}$/i.test(sha ?? '') ? { preparedAgainstSha: sha } : {}) };
}

/** One-off callers use the same reader with a fresh remote-main snapshot. */
export function cliReadPrepareStatus(args, { exec = execFileSync } = {}) {
  return createPrepareStatusReader({ exec }).read(args);
}

export const STAMP_RECOVERY_LEASE_MINUTES = 6 * 60;

export function cliReadStampFailure(num, root = REPO_ROOT) {
  const path = join(root, '.operations', 'delivery-dispatch-logs', `prepare-stamp-${num}.log`);
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, 'utf8').split('\n').reverse()) {
    let result;
    try { result = JSON.parse(line); } catch { continue; }
    if (!result || typeof result !== 'object') continue;
    if (result.status === 'failed' && result.attempt && result.error) return result;
    if (['submitted', 'already-stamped', 'starting'].includes(result.status)) return null;
  }
  return null;
}

/** Detached lane-bound recovery: never run the gate/PR wait inside a daemon tick. */
export async function cliStampPrepare({ num }, {
  reserve = reserveHoldRoute, release = releaseHoldRoute,
  readFailure = cliReadStampFailure,
  markStarting = num => {
    const path = join(REPO_ROOT, '.operations', 'delivery-dispatch-logs', `prepare-stamp-${num}.log`);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ status: 'starting', at: new Date().toISOString() }) + '\n');
  },
  releases = () => readPrepareReleases(join(SCRIPTS, 'conveyor', 'prepare-failure-releases.json'), REPO_ROOT),
  failures = () => Object.values(readFailureState().failures),
} = {}) {
  // Finite on purpose: JSON has no Infinity (it serializes to null, which reads back as an already-expired
  // lease), and a worker killed before it writes a terminal record must not strand the item forever.
  const entry = { num, route: 'prepare-stamp', leaseMinutes: STAMP_RECOVERY_LEASE_MINUTES };
  const terminal = readFailure(num);
  if (terminal) {
    const retriable = failures().some(f => f.num === String(num) && f.attempt === terminal.attempt && f.retry);
    if (!retriable && !releasedAttempt(releases(), num, terminal.attempt)) {
      throw Object.assign(new Error(terminal.error), { prepareAttempt: terminal.attempt });
    }
    // This is an observed transient or a reviewed fix, never a lease-expiry retry.
    release(entry);
  }
  if (!reserve(entry).ok) return { pending: true };
  try {
    markStarting(num);
    const { defaultSpawnDetached, deliveryDispatchLogPath } = await import('../../scripts/operations/detached-dispatch.mjs');
    const result = defaultSpawnDetached([
      join(SCRIPTS, 'operations', 'prepare-stamp-land.mjs'), `--num=${num}`,
    ], { cwd: REPO_ROOT, logPath: deliveryDispatchLogPath(`prepare-stamp-${num}`, REPO_ROOT) });
    // The shared spawner returns ChildProcess, not a dispatch verdict. Wait for actual spawn/error.
    if (typeof result?.once === 'function') {
      await new Promise((resolveSpawn, reject) => { result.once('spawn', resolveSpawn); result.once('error', reject); });
    }
    if (!result?.pid) throw new Error('prepare stamp worker did not spawn');
    return { spawned: true, pid: result.pid };
  } catch (e) {
    release(entry);
    throw e;
  }
}

const prepareClaimRoot = () => join(resolveCoordinationRoot(), 'item-prepare-dispatch-claims');

export const DEFAULT_RED_DRAFT_MINUTES = 60;

// PR metadata writes are daemon activity, not evidence that the author is still working.
function lastDraftAuthorActivity(candidate) {
  const dates = [candidate.headCommittedAt, candidate.authorLastSeenLiveAt]
    .map(value => Date.parse(value)).filter(Number.isFinite);
  return dates.length ? Math.max(...dates) : NaN;
}

/** Builder-only gate-failure recovery. Unknown liveness fails closed, including a crash between
 * reserving an attempt and recording its handle. The existing orphan retry policy supplies the cap.
 * State is PR-bound, never head-bound: a failed fix pushing another red head cannot reset its budget. */
export async function recoverBuilderDrafts({
  candidates, allowResume = true, dryRun = false, staleMinutes = DEFAULT_RED_DRAFT_MINUTES, nowMs = Date.now(), effects,
}) {
  if (!Number.isFinite(staleMinutes) || staleMinutes < 0) throw new Error('invalid red draft age');
  const results = [];
  for (const c of candidates) {
    try {
      const at = lastDraftAuthorActivity(c);
      if (!c.isDraft || !c.builderAuthored || c.authorLive !== false || !c.failure
        || !Number.isFinite(at) || nowMs - at < staleMinutes * 60_000) continue;
      const state = effects.readState(c.pr) ?? { attempts: 0 };
      if (state.notified || (state.handle && await effects.isLive(state.handle) !== false)) continue;
      if (state.pending && nowMs - (state.pendingAt ?? 0) < RESUME_SPAWN_GRACE_MS) continue;
      const decision = state.pending
        ? { action: 'exhausted' } // unknown spawn: surface it, never race a possibly live fix
        : decideOrphanAction({ resumable: true, attempts: state.attempts, allowResume });
      if (decision.action === 'leave') continue;
      if (dryRun) { results.push({ pr: c.pr, num: c.num, action: decision.action, planned: true }); continue; }
      if (!effects.reserve(c).ok) continue;
      try {
        if (decision.action === 'exhausted') {
          await effects.escalate(c, (state.pending
            ? 'Builder gate-failure fix launch is unconfirmed; human inspection required.\n'
            : `Builder gate-failure fix budget exhausted (${state.attempts} attempts).\n`)
            + `Failing check: ${c.failure.name}\nFirst error: ${c.failure.firstError}`);
          effects.writeState(c.pr, { ...state, notified: true });
        } else {
          const pending = { attempts: state.attempts + 1, pending: true, pendingAt: nowMs };
          effects.writeState(c.pr, pending);
          const out = await effects.dispatch(c);
          if (out?.held) {
            effects.writeState(c.pr, state); // no attempt was launched
            results.push({ pr: c.pr, action: 'held', reason: out.reason });
            continue;
          }
          if (!out?.agentId) throw new Error('fix dispatch returned no probeable handle');
          effects.writeState(c.pr, { attempts: pending.attempts, handle: out.agentId });
        }
        results.push({ pr: c.pr, num: c.num, action: decision.action });
      } finally { effects.release(c); }
    } catch (e) { results.push({ pr: c.pr, action: 'error', error: String(e.message || e) }); }
  }
  return results;
}

/** Read current CI evidence only for drafts tied to a recorded builder result. REST checks are scoped
 * to the current head; a review permission gate is never a code failure. No label guesses CI colour. */
export async function cliRecoverBuilderDrafts({ rawOpenPrs, allowResume, dryRun = false, staleMinutes = Number(process.env.WE_BUILD_DAEMON_RED_DRAFT_MINUTES ?? DEFAULT_RED_DRAFT_MINUTES) }, io = {}) {
  const { stampLiveness, defaultListAgents } = await import('../../scripts/operations/dispatch-lane-io.mjs');
  const { ghRestGetJson, ghRestGetPaged } = await import('../../scripts/lib/gh-rest-read.mjs');
  const { runGhSync } = await import('../../scripts/lib/gh-throttle.mjs');
  const { dispatchCiHeal } = await import('../../scripts/operations/ci-heal-pr-dispatch.mjs');
  const { freeLaneNumbers } = await import('../../scripts/conveyor/reconcile-fix-dispatch.mjs');
  const runs = io.store ? io.store.list().filter(id => id.startsWith('dispatch-lane')).map(id => ({ id, record: io.store.read(id) })) : readBuilderRuns();
  let agents;
  const isLive = handle => stampLiveness({ runs: [{ handle }] }, {
    listAgents: () => (agents ??= (io.listAgents ?? defaultListAgents)()),
    ...(io.isPidAlive ? { isPidAlive: io.isPidAlive } : {}),
  }).runs[0].live;
  const candidates = [];
  const repo = CONSTELLATION_REPOS.we.slug;
  const api = io.api ?? (path => ghRestGetJson(`repos/${repo}/${path}`).json);
  const paged = io.paged ?? ghRestGetPaged;
  const gh = io.gh ?? runGhSync;
  const { parseAuthorActorId } = await import('../../scripts/lib/review-independence.mjs');
  const prs = rawOpenPrs.find(r => r.repo === 'we')?.prs ?? [];
  const receipts = backfillAuthorship({ runs, prs, repo,
    receipts: io.receipts ?? (io.store ? [] : readAuthorship()), persist: !dryRun && !io.store });
  for (const pr of prs) {
    if (!pr.isDraft) continue;
    const row = receipts.find(r => r.repo === repo && r.pr === pr.number);
    if (!row || (row.ref && row.ref !== pr.headRefName) || isLive(row.entry.handle) !== false) continue;
    const num = normNum(row.entry.payload.num);
    const currentEntry = runs.find(r => r.id === row.runId)?.record?.effects?.find(e => e.key === row.entry.key);
    const p = api(`pulls/${pr.number}`);
    if (!p.draft || p.state !== 'open' || p.head?.repo?.full_name !== repo || p.head.ref !== pr.headRefName) continue;
    const author = parseAuthorActorId(p.body ?? '');
    if (author && isLive(author) !== false) continue;
    const activity = {
      headCommittedAt: api(`commits/${p.head.sha}`).commit?.committer?.date,
      authorLastSeenLiveAt: currentEntry?.lastSeenLiveAt ?? row.entry.lastSeenLiveAt,
    };
    const at = lastDraftAuthorActivity(activity);
    if (!Number.isFinite(at) || Date.now() - at < staleMinutes * 60_000) continue;
    const checks = [];
    for (let page = 1; ; page++) {
      const batch = api(`commits/${p.head.sha}/check-runs?filter=latest&per_page=100&page=${page}`).check_runs;
      if (!Array.isArray(batch)) throw new Error('unreadable check-runs response');
      checks.push(...batch);
      if (batch.length < 100) break;
    }
    const failed = checks.find(c => c.name !== 'review-gate' && ['failure', 'timed_out', 'cancelled', 'action_required'].includes(c.conclusion));
    if (!failed) continue;
    const annotations = paged(`repos/${repo}/check-runs/${failed.id}/annotations`);
    let firstError = annotations.find(a => a.annotation_level === 'failure')?.message
      || failed.output?.summary || failed.output?.text || 'No error detail published by the check.';
    // GitHub Actions often publishes no annotations; retrieve the job's actual first error.
    const job = /\/job\/(\d+)/.exec(failed.details_url ?? '')?.[1];
    if (job && !annotations.some(a => a.annotation_level === 'failure')) {
      const log = String(gh(['run', 'view', '--repo', repo, '--job', job, '--log-failed']));
      firstError = log.split('\n').find(line => /##\[error\]|AssertionError|(?:^|\s)FAIL\s|Error:/.test(line)) || firstError;
    }
    candidates.push({ pr: pr.number, num, itemNum: num, repo: 'we', laneRef: p.head.ref, headRefOid: p.head.sha,
      scope: (pr.files ?? []).map(f => `we:${f.path}`), isDraft: true, builderAuthored: true,
      authorLive: false, ...activity, failure: { name: failed.name, firstError: firstError.split('\n').find(Boolean)?.slice(0, 2000) } });
  }
  const dir = join(io.stateRoot ?? resolveCoordinationRoot(), 'build-red-draft-resumes');
  const path = pr => join(dir, `${pr}.json`);
  const route = c => ({ num: c.num, route: `red-draft-${c.pr}` });
  let lanes;
  return recoverBuilderDrafts({ candidates, allowResume, dryRun, staleMinutes, effects: {
    readState: pr => existsSync(path(pr)) ? JSON.parse(readFileSync(path(pr), 'utf8')) : null,
    writeState: (pr, state) => {
      mkdirSync(dir, { recursive: true });
      const tmp = `${path(pr)}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, path(pr));
    },
    isLive,
    reserve: c => (io.reserve ?? reserveHoldRoute)(route(c)),
    release: c => (io.release ?? releaseHoldRoute)(route(c)),
    dispatch: async c => {
      const lane = (lanes ??= (io.freeLanes ?? freeLaneNumbers)()).shift();
      if (!lane) return { held: true, reason: 'no-lane' };
      // The builder invokes the existing PR repair primitive directly. Its brief acquires the PR's
      // own ref and pushes back there; it never creates a second delivery PR or clears human review.
      return (io.dispatch ?? dispatchCiHeal)({ ...c, lane, reason: 'red-ci' });
    },
    escalate: async (c, body) => {
      // Comment first: a failed label write retries the evidence rather than silently marking done.
      gh(['pr', 'comment', String(c.pr), '--repo', repo, '--body', body]);
      gh(['pr', 'edit', String(c.pr), '--repo', repo, '--add-label', 'blocked:needs-human']);
    },
  } });
}

function cliEffects() {
  let prepareReader;
  return {
    completePrepareFailures,
    releaseDuePrepareRetries: () => releaseDuePrepareRetries(),
    recordBuildFailure: (o) => recordBuildFailure(o),
    clearBuildFailure: ({ num }) => clearBuildFailure(num),
    listBuildBackoffs: () => listBuildBackoffs(),
    listPrepareFailures: () => Object.values(readFailureState().failures),
    listPrepareReleases: () => readPrepareReleases(join(SCRIPTS, 'conveyor', 'prepare-failure-releases.json'), REPO_ROOT),
    recordPrepareFailure: async input => recordPrepareFailure(input, { fileCard: async card => {
      const { spawnPreventionLandingJob } = await import('../../scripts/lib/prevention-landing-job.mjs');
      return spawnPreventionLandingJob(card, { sessionPrefix: 'prepare-prevention' });
    } }),
    listProbationPrepares: () => {
      const path = resolveScorecardStorePath();
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).records : [];
    },
    listPrepareClaims: () => listBuildDispatchClaims({ lockRoot: prepareClaimRoot(), ignoreExpiry: true }),
    listSettledPrepares: () => cliListSettledBuilds({ launchKind: 'prepare-item' }),
    primePrepareStatus: ({ nums, claims }) => {
      prepareReader = createPrepareStatusReader({ execAsync: defaultExecAsync });
      return prepareReader.prime(nums.map(num => ({ num,
        claimedAt: claims.find(c => normNum(c.meta.num) === normNum(num))?.meta?.claimedAt })));
    },
    readPrepareStatus: args => (prepareReader ??= createPrepareStatusReader()).read(args),
    // The card's stamp as it stands at spawn, recorded on the claim.
    readPreparedStamp: args => (prepareReader ??= createPrepareStatusReader()).stamp(args),
    readPrepareEvidence: cliPrepareFailureEvidence,
    stampPrepare: cliStampPrepare,
    placePrepareHold: (o) => placeBuildDispatchHold(o),
    releasePrepareHold: (o) => releaseBuildDispatchHold(o),
    settlePrepareRow: ({ runId, key, outcome }) => {
      if (outcome !== 'prepare-completed') return settleOrphanRow({ runId, key, outcome });
      const settled = settleDispatchEffect({ runId, key, status: 'applied', result: { outcome } });
      if (!settled.settled && !['already-applied', 'already-failed'].includes(settled.reason)) {
        throw new Error(`prepare settlement: ${settled.reason}`);
      }
      return settled;
    },
    acquirePrepareClaim: (o) => acquireBuildDispatchClaim({ ...o, lockRoot: prepareClaimRoot() }),
    releasePrepareClaim: (o) => releaseBuildDispatchClaim({ ...o, lockRoot: prepareClaimRoot() }),
    planTick: (payload, { config } = {}) => cliPlanTick(payload, { config }),
    predictRoute: cliPredictRoute,
    fetchOpenPrs: cliFetchOpenPrs,
    listClaims: () => listBuildDispatchClaims(),
    listFixClaims: () => liveFixInFlight(),
    listBorrowedFixes: () => liveBorrowedFixInFlight(),
    releaseClaim: ({ num }) => releaseBuildDispatchClaim({ num }),
    acquireClaim: ({ num, scope }) => acquireBuildDispatchClaim({ num, scope }),
    listRunStoreInFlight: () => [],
    // #4349 — `listSettledBuilds` is ASYNC (a run-store scan) so it gets the SAME "placeholder default,
    // overwritten with a fresh read before use" treatment `listRunStoreInFlight` above already has — see
    // `dryRun`/`live`'s own wiring below. `listHolds` is synchronous and cheap, so it is wired to the real
    // reader directly; an `effects` object built straight from `cliEffects()` (rather than through
    // `dryRun`/`live`) still reads real holds.
    listSettledBuilds: () => [],
    listHolds: () => [...cliListHolds(), ...Object.values(readFailureState().failures)
      .filter(f => f.held && !f.completed).map(f => ({ num: f.num, reason: 'prepare-unstamped' }))],
    takePrepareRouteHolds: () => takePrepareRouteHolds(),
    killSwitch: cliKillSwitch,
    mainRedFreeze: cliMainRedFreeze, // card xu1nixv
    dispatch: cliDispatchDetached,
    settleLaunches: (o) => cliSettleLaunches({ confirmed: cliLaunchConfirmed, ...o }),
    hostLoadGate: cliHostLoadGate,
    // Card x60i0ie — the plain facts the cost-class rule reads (host sample + Claude spend today). Fails open.
    costFacts: () => readCostFacts(),
    // #4348-open-pr-retry — only called by `runBuildDispatchTick` when `live` (never on a `--dry-run` tick).
    retryInfraBlocked: cliRetryInfraBlocked,
    // #4131/#4382 build-orphan-adopt — only called by `runBuildDispatchTick` when `live`, and BEFORE this same
    // tick's own claim retirement read — see that function's own docblock.
    adoptOrphans: ({ skipNums, ...o } = {}) => adoptOrphanedBuildClaims({
      ...o,
      // 78b — a claim whose detached launch is still starting has no run row yet; never read it as an orphan.
      ...(skipNums?.size ? { listClaims: () => listBuildDispatchClaims({ ignoreExpiry: true }).filter((c) => !skipNums.has(normNum(c.meta?.num))) } : {}),
    }),
    recoverDrafts: cliRecoverBuilderDrafts,
    // Queue hygiene every N live ticks (`WE_BUILD_DAEMON_QUEUE_PRUNE_EVERY_TICKS`, default 5; 0 = off).
    pruneQueue: makeCliPruneQueue(),
    // #4465 — only called by `runBuildDispatchTick` when `live` (never on a `--dry-run` tick).
    routeHeldItems: (plan) => cliRouteHeldItems(plan),
  };
}

/** The declared setting: prune the conveyor queue every N live ticks. 0 turns the automatic prune off. */
export const QUEUE_PRUNE_EVERY_TICKS_ENV = 'WE_BUILD_DAEMON_QUEUE_PRUNE_EVERY_TICKS';
export const DEFAULT_QUEUE_PRUNE_EVERY_TICKS = 5;
export function queuePruneEveryTicks(env = process.env) {
  const raw = env?.[QUEUE_PRUNE_EVERY_TICKS_ENV];
  if (raw == null || String(raw).trim() === '') return DEFAULT_QUEUE_PRUNE_EVERY_TICKS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_QUEUE_PRUNE_EVERY_TICKS;
}

/**
 * Build the daemon's `pruneQueue` effect: runs {@link planPrune}'s AUTOMATIC classes on the cadence above and
 * logs every drop. `io` is injectable for tests. Fail-closed: an unloadable backlog plans nothing.
 */
export function makeCliPruneQueue({ env = process.env, io = {} } = {}) {
  let ticks = 0;
  return async ({ protectedNums = [] } = {}) => {
    const every = queuePruneEveryTicks(env);
    if (every === 0) return { skipped: 'disabled' };
    ticks += 1;
    if ((ticks - 1) % every !== 0) return { skipped: 'cadence' };
    const store = io.store ?? await import('../../scripts/conveyor/queue-store.mjs');
    const prune = io.prune ?? await import('../../scripts/conveyor/queue-prune.mjs');
    const items = io.items ? io.items() : (await import('node:module')).createRequire(import.meta.url)('../../src/_data/backlog.js')();
    const path = io.path ?? store.resolveQueuePath();
    // `items` is THIS checkout's backlog, which can lag origin/main: a card filed on main since would read as
    // missing. So `missing-card` needs origin/main to confirm the absence (`confirmMissing`), never the working tree alone.
    const confirmMissing = io.confirmMissing ?? prune.makeConfirmMissingOnMain();
    const plan = prune.planPrune({ queue: store.readQueueFile(path), items, protectedNums, confirmMissing });
    if (!plan.ok) return { refused: plan.reason };
    if (plan.drop.length || plan.rename.length) (io.apply ?? prune.applyPlan)(plan, path);
    for (const d of plan.drop) console.error(`build-dispatch-daemon: queue prune dropped #${d.num} (${d.reason}${d.detail ? `: ${d.detail}` : ''})`);
    return { dropped: plan.drop.map((d) => ({ num: d.num, reason: d.reason })), renamed: plan.rename.length, protectedKept: plan.protectedKept.length };
  };
}

function parseFlags(argv) {
  const f = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const i = a.indexOf('=');
    f[i === -1 ? a.slice(2) : a.slice(2, i)] = i === -1 ? true : a.slice(i + 1);
  }
  return f;
}

/** EXPORTED (#4353) so a test can assert `--max-open-items` flows into the policy the same mechanical way
 *  `--max-concurrent`/`--max-open-prs` already do, without going through the full CLI/IO shell. */
// Flags override WE_BUILD_DAEMON_MAX_CONCURRENT[_EXTERNAL]; the legacy knob is Claude-only.
export function policyFrom(flags, env = process.env) {
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return {
    ...BUILD_DISPATCH_POLICY,
    maxConcurrentBuilds: n(flags['max-concurrent'] ?? env.WE_BUILD_DAEMON_MAX_CONCURRENT, BUILD_DISPATCH_POLICY.maxConcurrentBuilds),
    maxConcurrentExternalBuilds: n(flags['max-concurrent-external'] ?? env.WE_BUILD_DAEMON_MAX_CONCURRENT_EXTERNAL, BUILD_DISPATCH_POLICY.maxConcurrentExternalBuilds),
    maxOpenPrs: n(flags['max-open-prs'], BUILD_DISPATCH_POLICY.maxOpenPrs),
    maxOpenItems: n(flags['max-open-items'], BUILD_DISPATCH_POLICY.maxOpenItems),
    // Card 80 — declared settings; `off` (or a negative value) disables the window / the staleness gate.
    prepareAheadWindow: offOr(flags['prepare-ahead-window'] ?? env.WE_BUILD_DAEMON_PREPARE_AHEAD_WINDOW, BUILD_DISPATCH_POLICY.prepareAheadWindow),
    preparedMaxAgeDays: offOr(flags['prepared-max-age-days'] ?? env.WE_BUILD_DAEMON_PREPARED_MAX_AGE_DAYS, BUILD_DISPATCH_POLICY.preparedMaxAgeDays),
    // Card x60i0ie — declared cost-class admission settings (env + dispatch-settings.json); built-in `off`.
    costAdmission: readCostAdmissionSettings({ env }),
  };
}

/** A count setting that can be switched off: unset → the default; `off` / a negative number → `null` (off). */
function offOr(v, d) {
  if (v === undefined || v === null || v === '' || v === true) return d;
  if (/^off$/i.test(String(v))) return null;
  const x = Number(v);
  return Number.isFinite(x) ? (x < 0 ? null : x) : d;
}

/**
 * builder-starved — the free capacity a tick ended with, logged on every tick record so the health watch's
 * `builder-starved` smell can tell "nothing to do / no room" from "room, a queue, and still nothing launched".
 * `buildSlots` is the per-executor-class room left after this tick's picks; `prepareSlots` the item-prepare room
 * (two workers). A frozen tick (kill switch / landing freeze) reports `frozen` — it is idle on purpose.
 */
export function tickCapacity(r) {
  const buildSlots = r?.plan?.slotsByClass ?? {};
  const prepareCap = Number.isFinite(r?.prepare?.cap) ? r.prepare.cap : 2; // card x60i0ie — the light cap when ON
  const prepareSlots = Math.max(0, prepareCap - (Array.isArray(r?.prepare?.inFlight) ? r.prepare.inFlight.length : 0));
  return { buildSlots, prepareSlots, frozen: r?.plan?.freeze?.frozen === true,
    free: r?.plan?.freeze?.frozen !== true && (prepareSlots > 0 || Object.values(buildSlots).some((n) => Number(n) > 0)) };
}

/** builder-starved — the tick-core spawn kinds this daemon launches (it reads `spawnBuilds` + `spawnPrepareItems`). */
export const BUILD_DAEMON_LAUNCH_KINDS = Object.freeze(['prepare-item']);

/** Card 80 — the tick-core config this daemon's policy implies. EXPORTED for the test. */
export function planConfigFrom(policy = BUILD_DISPATCH_POLICY) {
  // builder-starved — this daemon launches builds and item prepares only; the tick core plans nothing else for it.
  const cfg = { launchKinds: BUILD_DAEMON_LAUNCH_KINDS };
  if (Number.isFinite(policy?.prepareAheadWindow)) cfg.prepareAheadWindow = policy.prepareAheadWindow;
  if (Number.isFinite(policy?.preparedMaxAgeDays)) cfg.preparedMaxAgeDays = policy.preparedMaxAgeDays;
  if (costAdmissionOn(policy?.costAdmission)) cfg.costAdmission = policy.costAdmission; // card x60i0ie — only when ON
  return cfg;
}

/**
 * The dry-run report: the dispatch plan for the tick core's launchable builds, PLUS the same policy evaluated
 * over the items the tick core held only for lane capacity — so the operator sees what the daemon would do
 * with each queued card once a lane frees, and why it holds the rest.
 */
async function dryRun(flags) {
  const policy = policyFrom(flags);
  const timer = createPhaseTimer();
  const effects = cliEffects();
  const prepareEnabled = !flags['no-prepare'];
  const runStoreRows = await timer.measure('readBuildRuns', () => cliListRunStoreInFlight());
  effects.listRunStoreInFlight = () => runStoreRows;
  const settledRows = await timer.measure('readSettledBuilds', () => cliListSettledBuilds()); // #4349
  effects.listSettledBuilds = () => settledRows;
  const prepareRows = await timer.measure('readPrepareRuns', () => cliListRunStoreInFlight({ launchKind: 'prepare-item' }));
  effects.listPrepareInFlight = () => prepareRows;
  const tick = await runBuildDispatchTick({ bookkeeping: {}, live: false, policy, prepareEnabled, effects, timer });
  const core = tick.tickCore;
  const scopeByNum = new Map((core.queue || []).map((r) => [normNum(r.num), r.scope || []]));
  const heldByCore = new Map((core.held || []).map((h) => [normNum(h.num), h.reason]));
  for (const s of core.suppressedBuilds || []) heldByCore.set(normNum(s.num), s.by || 'suppressed');
  const capacityOnly = [...heldByCore.entries()].filter(([, why]) => /capacity/.test(String(why))).map(([num]) => ({ num, lane: null, scope: scopeByNum.get(num) || [] }));
  const openPrs = await effects.fetchOpenPrs();
  const inFlight = [
    ...listBuildDispatchClaims().map((c) => ({ num: normNum(c.meta.num), scope: c.meta.scope || [], source: `claim ${c.owner}` })),
    ...runStoreRows,
    ...liveBorrowedFixInFlight(),
  ];
  // xovjhwh — the SAME shared derivation `runBuildDispatchTick` calls internally for `tick.plan` (unavailable
  // here since it is local to that function's own call); recomputed from the same two rows this dry-run already
  // fetched (`runStoreRows`/`settledRows`, above), through `deriveDispatchedByBuilder` rather than a second
  // inline copy, so the per-num status detail below can never drift from the headline
  // `tick.plan.openItems`/`wouldDispatchNow` this report also prints.
  const dispatchedByBuilder = deriveDispatchedByBuilder(runStoreRows, settledRows);
  const reportCandidates = [];
  for (const c of [...tick.plan.dispatch, ...tick.plan.hold, ...capacityOnly]) {
    const scope = c.scope || scopeByNum.get(normNum(c.num)) || [];
    const route = await cliPredictRoute(c.num, scope);
    reportCandidates.push({ num: c.num, lane: c.lane, scope, route, executor: route.executor });
  }
  const ifFreed = planBuildDispatch({ candidates: reportCandidates, inFlight, openPrs: normalizeOpenPrs(openPrs), externalBuilding: core.building, killSwitch: cliKillSwitch(), policy, dispatchedByBuilder, fixInFlight: liveFixInFlight(), mainRedFreeze: cliMainRedFreeze() });
  const focus = String(flags.focus || '').split(',').map(normNum).filter(Boolean);
  const rows = [];
  const holdByNum = new Map((tick.buildHolds || []).map((h) => [normNum(h.num), h]));
  const nums = new Set([...ifFreed.dispatch.map((x) => x.num), ...ifFreed.hold.map((x) => x.num), ...holdByNum.keys()]);
  for (const num of focus) nums.add(num);
  for (const num of nums) {
    if (focus.length && !focus.includes(num)) continue;
    const coreSpawn = tick.tickCore.spawnBuilds.some((s) => normNum(s.num) === num);
    const coreWhy = coreSpawn ? 'launchable now' : (heldByCore.get(num) || (scopeByNum.has(num) ? 'not planned' : 'not in the ready build queue'));
    const pick = ifFreed.dispatch.find((x) => x.num === num);
    const held = ifFreed.hold.find((x) => x.num === num);
    // A card only the hold list names needs no route read (it is not a dispatch candidate this tick).
    const route = (pick || held || focus.includes(num)) ? await cliPredictRoute(num, scopeByNum.get(num) || []) : null;
    rows.push({
      num,
      tickCore: coreWhy,
      daemon: pick ? (coreSpawn ? 'WOULD DISPATCH NOW' : 'would dispatch once the tick core frees a lane') : held ? `hold [${held.rule}] ${held.reason}` : holdText(holdByNum.get(num)),
      route,
    });
  }
  const report = {
    mode: 'dry-run',
    at: new Date().toISOString(),
    timings: { ...timer.snapshot(), tickCore: tick.timings.tickCore },
    statusLine: tick.statusLine,
    policy: {
      maxConcurrentBuilds: policy.maxConcurrentBuilds, maxConcurrentExternalBuilds: policy.maxConcurrentExternalBuilds, maxOpenPrs: policy.maxOpenPrs, maxOpenItems: policy.maxOpenItems,
      // #3383 continuation, live incident 2026-09-28 — `globalFreezeLabels` is what actually freezes every
      // candidate now; the three per-PR `*-stalled` labels only hold a scope-overlapping build (`freezeLabels`
      // still lists all four for anything reading the historical shape, kept alongside, not replaced).
      globalFreezeLabels: policy.globalFreezeLabels ?? policy.freezeLabels, freezeLabels: policy.freezeLabels,
    },
    killSwitch: cliKillSwitch(),
    freeze: tick.plan.freeze,
    openPrs: normalizeOpenPrs(openPrs).map((p) => `${p.repo}#${p.number}`),
    inFlight: tick.plan.inFlight,
    // #4353 — {inFlight} ∪ {delivered-by-open-PR ∩ this builder's own dispatches, xovjhwh}, the cap this card
    // adds. `filling` names which nums fill it (never just a count) so a full-cap dry-run says WHY, not only
    // THAT.
    openItems: reportOpenItems(tick.plan.openItems),
    prepare: tick.prepare,
    draftRecovery: tick.draftRecovery,
    wouldDispatchNow: tick.plan.dispatch.map((x) => x.num),
    buildHolds: tick.buildHolds,
    wouldRetireClaims: tick.retired,
    dispatchHolds: tick.dispatchHolds, // #4349 — items excluded this tick by a non-PR terminal-outcome cooldown
    // #4465 — every LIVE hold's classified route (`already-done`/`out-of-scope`/`other`), read-only here: a
    // `--dry-run` tick never calls `effects.routeHeldItems`, so this is purely informational.
    holdRouting: tick.holdRouting,
    items: rows,
  };
  if (flags.json) { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return; }
  const w = (s) => process.stdout.write(`${s}\n`);
  w(`build-dispatch-daemon DRY RUN @ ${report.at}`);
  w(`  tick core: ${report.statusLine}`);
  w(`  policy: caps Claude ${policy.maxConcurrentBuilds} / external ${policy.maxConcurrentExternalBuilds} builds · GLOBAL freeze if open PRs > ${policy.maxOpenPrs} or any of [${(policy.globalFreezeLabels ?? policy.freezeLabels).join(', ')}] · a per-PR *-stalled label only holds a scope-overlapping build (scope-vs-open-prs)`);
  w(`  kill switch: ${report.killSwitch.engaged ? `ENGAGED (${report.killSwitch.reason})` : 'off'} · landing freeze: ${report.freeze.frozen ? `ON — ${report.freeze.reasons.join('; ')}` : 'off'}`);
  // card xao7080/#4518 — provider (`executor`) is visible per in-flight build here: a claim entry has no run
  // record yet (`executor` absent — the dispatch has not gone `in-flight` on disk), a run-store row carries the
  // durable field once it has (`null` only for an older record with none, never a default guess).
  w(`  open PRs: ${report.openPrs.join(', ') || 'none'} · durable in-flight builds (claims/run records): ${report.inFlight.map((f) => `#${f.num} (${f.source}${f.executor ? ` executor=${f.executor}` : ''})`).join(', ') || 'none'} · tick core counts ${core.building} building`);
  w(`  open items ${report.openItems.count}/${report.openItems.cap}${report.openItems.filling.length ? ` (${report.openItems.filling.map((n) => `#${n}`).join(', ')})` : ''}`);
  w(`  prepare: ${JSON.stringify(report.prepare)}`);
  w(`  would dispatch now: ${report.wouldDispatchNow.map((n) => `#${n}`).join(', ') || 'nothing'}`);
  w(`  held items, routed: ${report.holdRouting.map((h) => `#${h.num}→${h.route}${h.commit ? `(${h.commit})` : ''}`).join(', ') || 'none'}`);
  for (const r of rows) {
    if (!r.route) { w(`  #${r.num}: tick-core=${r.tickCore} → ${r.daemon}`); continue; }
    const rt = r.route?.error ? `route ? (${r.route.error})` : `marker=${r.route.marker ?? '-'} taskType=${r.route.taskType ?? '-'} routed=${r.route.routed ?? '-'} executed=${r.route.executed ?? '-'} executor=${r.route.executor ?? '-'}${r.route.refusal ? ` REFUSED: ${r.route.refusal}` : ''}`;
    w(`  #${r.num}: tick-core=${r.tickCore} → ${r.daemon}\n      ${rt}`);
  }
}

/** One held card's reason as the dry-run prints it (`held [tick-core] queue-cap — projected …`). */
export function holdText(h) {
  return h ? `held [${h.stage}] ${h.reason}${h.detail ? ` — ${h.detail}` : ''}` : 'not a candidate';
}

async function live(flags) {
  if (flags['self-sync'] !== undefined && flags['self-sync'] !== true) {
    console.error('build-dispatch-daemon: --self-sync takes no value'); process.exit(1);
  }
  const owner = makeOwner('build-dispatch-daemon');
  const acquired = acquireRunnerLease(RUNNER_LOCK_ROOT, owner, { key: BUILD_DISPATCH_DAEMON_LEASE_KEY });
  if (!acquired.ok) { console.error(`build-dispatch-daemon: a live instance holds the lease (${acquired.heldBy}) — exiting.`); return; }
  const { isAlive, stop } = startIndependentHeartbeat({ owner, key: BUILD_DISPATCH_DAEMON_LEASE_KEY,
    onLost: () => console.error('build-dispatch-daemon: lease lost — stopping after this tick.') });
  const release = () => { stop(); releaseRunnerLeaseIfOwned(RUNNER_LOCK_ROOT, owner, { key: BUILD_DISPATCH_DAEMON_LEASE_KEY }); };
  const shutdown = (sig) => { console.error(`build-dispatch-daemon: ${sig} — releasing the lease.`); release(); process.exit(0); };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const policy = policyFrom(flags);
  const effects = cliEffects();
  const prepareEnabled = !flags['no-prepare'];
  let bookkeeping = {};
  const rawTickOnce = async () => {
    const timer = createPhaseTimer();
    const rows = await timer.measure('readBuildRuns', () => cliListRunStoreInFlight());
    effects.listRunStoreInFlight = () => rows;
    const settledRows = await timer.measure('readSettledBuilds', () => cliListSettledBuilds()); // #4349
    effects.listSettledBuilds = () => settledRows;
    const prepareRows = await timer.measure('readPrepareRuns', () => cliListRunStoreInFlight({ launchKind: 'prepare-item' }));
    effects.listPrepareInFlight = () => prepareRows;
    const r = await runBuildDispatchTick({ bookkeeping, live: true, policy, prepareEnabled, effects, timer });
    bookkeeping = r.nextBookkeeping;
    return r;
  };
  const { wireSelfSyncAndAppAuth } = flags['self-sync'] === true ? await import('./runner.mjs') : {};
  const tickOnce = gatePausedTicks({
    tickOnce: rawTickOnce,
    wrapSync: flags['self-sync'] === true
      ? (t) => wireSelfSyncAndAppAuth({ tickOnce: t, root: REPO_ROOT, selfSync: true, onRestart: () => { release(); process.exit(0); } })
      : null,
    killSwitch: cliKillSwitch,
  });
  const intervalMs = Number(flags['interval-ms']) > 0 ? Number(flags['interval-ms']) : DEFAULT_INTERVAL_MS;
  console.error(`build-dispatch-daemon: live on ${hostname()}:${process.pid}, caps Claude ${policy.maxConcurrentBuilds} / external ${policy.maxConcurrentExternalBuilds}, tick every ${intervalMs}ms${flags['self-sync'] ? ', self-sync ON' : ''}.`);
  const { stoppedReason } = await runDaemonLoop({
    tickOnce, sleep: realSleep, isAlive, intervalMs, fixedCadence: true, maxTicks: flags.once ? 1 : Infinity,
    onTick: (r, _tick, loop) => {
      if (!r || !r.plan) { console.error(`build-dispatch-daemon: tick skipped (${r?.reason ?? 'self-sync'})`); return; }
      // card xao7080/#4518 — `{num, executor}` per in-flight build, not a bare num: `executor` is the durable
      // dispatch-record field (`claude`/`antigravity`/`codex`, `null` before the run goes `in-flight` on disk
      // or for an older record with none) so the operator's tick line names WHO is running each build without
      // reading scorecards. Additive over the previous bare-num array — nothing on `main` parses this stdout
      // JSON as a strict array-of-strings today (grepped 2026-09-29).
      process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), timings: { ...r.timings, loop }, status: r.statusLine, freeze: r.plan.freeze, inFlight: r.plan.inFlight.map((f) => ({ num: f.num, executor: f.executor ?? null })), openItems: reportOpenItems(r.plan.openItems), dispatched: r.dispatched, buildHolds: r.buildHolds, prepare: r.prepare, hold: r.plan.hold, dispatchHolds: r.dispatchHolds, failures: r.failures, needsYou: r.needsYou, retired: r.retired, infraRetry: r.infraRetry, orphanAdoption: r.orphanAdoption, queuePrune: r.queuePrune, draftRecovery: r.draftRecovery, holdRouting: r.holdRouting, holdRoutingResult: r.holdRoutingResult, loadHolds: r.loadHolds, costAdmission: r.costAdmission ? { line: r.costAdmission.line, tally: r.costAdmission.tally } : null, launchSettlement: r.launchSettlement, capacity: tickCapacity(r) })}\n`);
      if (r.costAdmission?.line) console.error(`build-dispatch-daemon: ${r.costAdmission.line}`);
    },
    onTickError: (e, _tick, loop) => {
      // Keep the health watcher's existing failure-line contract; timings are an additive JSON line.
      console.error(`build-dispatch-daemon: tick failed (non-fatal): ${childFailure(e, { singleLine: true })}`);
      console.error(JSON.stringify({ at: new Date().toISOString(), event: 'tick-failed', timings: { ...e.timings, loop } }));
    },
  });
  console.error(`build-dispatch-daemon: stopped (${stoppedReason}).`);
  release();
}

/**
 * Item 95 — the one-shot re-arm, through the product: clear held prepare failures whose reason code is
 * `launch-not-confirmed` (default) recorded before #4148's fix landed, and release their hold files.
 * `--before=<ISO>` `--codes=a,b` `--build-failures` (also drop exhausted build backoffs) `--dry-run`.
 */
function rearm(flags) {
  const dryRun = Boolean(flags['dry-run']);
  // An explicit `--before` that is not a usable timestamp (a typo, a bare `--before`) is an error, never the default:
  // silently widening a one-shot re-arm to "everything" is worse than refusing.
  const before = flags.before === undefined ? NOT_CONFIRMED_FIX_LANDED_AT : flags.before;
  const codes = typeof flags.codes === 'string' ? flags.codes.split(',').filter(Boolean) : undefined;
  let res;
  try { res = rearmFalseHolds({ before, dryRun, ...(codes ? { codes } : {}) }); }
  catch (e) { console.error(`build-dispatch-daemon: ${String(e?.message || e).split('\n')[0]}`); process.exitCode = 2; return; }
  // `res.nums` already omits a card that still has another held failure; of those, lift only the prepare hold.
  const holds = dryRun ? { released: [], kept: [] } : releaseOwnPrepareHolds({ nums: res.nums, holds: cliListHolds(), release: o => { try { releaseBuildDispatchHold(o); } catch { /* hold already gone */ } } });
  const build = flags['build-failures'] ? rearmBuildFailures({ dryRun }) : null;
  console.log(JSON.stringify({ rearmed: res.count, nums: res.nums, before, dryRun, holdsReleased: holds.released, holdsKept: holds.kept, ...(build ? { buildFailures: build } : {}) }));
}

async function main(argv) {
  installDaemonLog(); // item 68a/68b: ISO stamp, collapse identical repeats, size-rotate (see daemon-log.mjs)
  const flags = parseFlags(argv);
  if (flags['rearm-false-holds']) return rearm(flags);
  if (flags['dry-run']) return dryRun(flags);
  if (flags.live) return live(flags);
  console.error('usage: build-dispatch-daemon.mjs --dry-run [--json] [--focus=N,M]   (read-only: what it would dispatch now)\n'
    + '       build-dispatch-daemon.mjs --live [--once] [--self-sync] [--no-prepare] [--max-concurrent=1] [--max-concurrent-external=4] [--max-open-prs=12] [--max-open-items=7] [--prepare-ahead-window=4|off] [--prepared-max-age-days=3|off] [--interval-ms=120000]\n'
    + '       build-dispatch-daemon.mjs --rearm-false-holds [--dry-run] [--before=ISO] [--codes=launch-not-confirmed] [--build-failures]   (one-shot: clear false "launch not confirmed" holds recorded before ISO, plus any EXHAUSTED backoff hold of those codes; --before must be a valid ISO timestamp)\n'
    + 'retry backoff env: WE_DISPATCH_RETRY_BASE_MS (300000), WE_DISPATCH_RETRY_MAX_MS (3600000), WE_DISPATCH_RETRY_MAX_ATTEMPTS (6)\n'
    + 'red draft age env: WE_BUILD_DAEMON_RED_DRAFT_MINUTES (default 60)\n'
    + 'caps env: WE_BUILD_DAEMON_MAX_CONCURRENT (Claude), WE_BUILD_DAEMON_MAX_CONCURRENT_EXTERNAL (Codex/agy); flags win\n'
    + `paused ticks: ${PAUSED_PREP_ENV}=1 restores full preparation; ${PAUSED_SYNC_MS_ENV} sets clone sync interval (default ${DEFAULT_PAUSED_SYNC_MS}ms)\n`
    + `kill switch: ${KILL_SWITCH_ENV}=1 or touch <coordination root>/${KILL_SWITCH_FILENAME}`);
  process.exit(2);
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  main(process.argv.slice(2)).catch((e) => { console.error(`build-dispatch-daemon: fatal: ${String(e?.stack || e)}`); if (e.timings) console.error(JSON.stringify({ timings: e.timings })); process.exit(1); });
}
