#!/usr/bin/env node
/**
 * @file skills-src/conveyor/review-daemon.mjs
 * @description #3876 (epic #3383) — the standalone Review daemon: reconcile-pass.mjs (discovery) +
 *   review-dispatch.mjs (dispatch) + review-round-tag.mjs / review-status-tag.mjs (cosmetic labels),
 *   grouped into ONE daemon per #3860's split analysis — one sequential pass over the same PR, not four
 *   things worth separating.
 *
 * WHAT THIS REPLACES. we:skills-src/conveyor/runner.mjs's own `makeCliMechanicalPasses` ran this exact
 * sequence (reconcile-pass → review-dispatch per review-kind entry → review-round-tag → review-status-tag)
 * as ONE STEP of its own per-tick pass list, with a shared `--prs-file` fetched once and passed to both
 * reconcile-fix-dispatch AND reconcile-pass in the same tick. This daemon does NOT replicate that sharing —
 * it does its own `gh pr list` each tick, an accepted, honest tradeoff of running independently (the same
 * tradeoff #3870's Fix-dispatch daemon already made).
 *
 * CROSS-REPO (#xvyuwtg, 2026-09-22). This daemon was originally built WE-only, matching #3870's own scoping
 * at the time — deliberate, not an oversight, per this file's own original header. That turned out wrong in
 * practice: plateau-app PR #167 sat `review:pending` with nothing watching it, because this daemon's tick
 * never asked any repo but WE. Every downstream step was ALREADY fully repo-generic (`reconcile-pass.mjs`
 * accepts `--repo` end to end; `review-dispatch.mjs` dispatches any constellation repo's review correctly —
 * proven live by hand for plateau-app#167 — as long as the DISPATCHING process itself, not the target repo's
 * own checkout, is a clean, fresh, non-lane WE checkout; this daemon's own dedicated clone already is one).
 * The only real gap was discovery, so {@link runReviewTickAllRepos} now ticks {@link REVIEW_DAEMON_REPOS} —
 * today the three constellation repos, kept as data so a future per-user configurable repo list (plateau as
 * a product letting an operator choose which repos to integrate) is a source swap, not a redesign.
 *
 * DOUBLE-DISPATCH, STATED HONESTLY. Unlike we:scripts/conveyor/reconcile-fix-dispatch.mjs (which fences
 * through we:scripts/operations/action-store.mjs's durable ledger), `review-dispatch.mjs`'s `dispatchReview`
 * carries NO durable per-PR claim of its own (confirmed by direct read — no action-store import). Its ONLY
 * double-dispatch protection is UPSTREAM, in `reconcile-pass.mjs`/`reconcile-core.mjs`'s own liveness read:
 * a PR with a live `review-<pr>` session bound to it simply does not reappear in the NEXT tick's plan. This
 * daemon inherits that exact protection level — the same one the legacy runner already relied on — not a
 * weaker one, but also not a stronger one. A `claude agents --json` listing lag right after a fresh spawn
 * remains a real (pre-existing, not newly introduced) race window.
 *
 * PURE-CORE / IO-SHELL SPLIT (mirrored from #3870's own daemon and runner.mjs's header):
 *   • {@link runDaemonLoop} is IDENTICAL in shape to #3870's own loop (tickOnce/sleep/heartbeat/onTick/
 *     onTickError/intervalMs/maxTicks) — duplicated here rather than imported because #3870 has not yet
 *     landed on `main` at the time this was written; a follow-up can dedup the two into one shared file
 *     once both exist there.
 *   • {@link runReviewTick} is the pure-ish per-tick sequence (every effect — reconcile, dispatch, the two
 *     taggers — is injectable, so the whole sequence is unit-tested with fakes, no real `gh`/`claude`).
 *   • The IO SHELL (`main()`) wires the real functions and the real keyed runner-lock lease (#3877).
 *
 * THE SESSION REAPER LIVES HERE TOO (epic #3383, daemon split). `we:scripts/conveyor/session-reaper.mjs`'s
 * `runSessionReaperPass` used to run only inside `we:skills-src/conveyor/runner.mjs`'s own per-tick
 * `makeCliMechanicalPasses` — a dispatcher that this repo's daemons have since REPLACED and that is not
 * itself running. Left uncalled, every `review-*`/`review-pa-*`/`fix-*`/`fix-pa-*` session this daemon (and
 * `reconcile-fix-dispatch-daemon.mjs`) ever dispatches accumulates forever once it finishes — a real, observed
 * cost: ~40 finished sessions and ~200 lingering `claude` child processes (~24 GB) in one overnight run before
 * this wiring existed. THIS daemon claims it, not `reconcile-fix-dispatch-daemon.mjs`, for three reasons:
 *   1. `session-reaper.mjs` reads the WHOLE `claude agents --json --all` listing and reaps ANY matching
 *      session regardless of which daemon spawned it — placement is about who's the natural OWNER of session
 *      lifecycle, not about scoping which sessions get swept (both daemons' own dispatches are covered either
 *      way).
 *   2. `reconcile-fix-dispatch-daemon.mjs`'s whole job is narrowly single-purpose and safe-by-construction to
 *      run twice at once (its own header: every dispatch decision fences through `action-store.mjs`'s durable
 *      ledger) — folding in an unrelated OS-process-cleanup concern would blur that narrow contract for no
 *      benefit, where this daemon already owns a broader "review session lifecycle" concern (dispatch AND the
 *      two cosmetic tags that describe a session's own progress).
 *   3. This daemon is ALREADY cross-repo (`REVIEW_DAEMON_REPOS`, #xvyuwtg) and already ticks on the same
 *      120s cadence `runner.mjs`'s own mechanical pass used for `session-reaper.mjs` — no new interval, no new
 *      lease, no new cross-repo plumbing to add.
 * `neverReapWorking: true` and `allowedCwd: REPO_ROOT` (imported from `session-reaper.mjs` itself, resolved
 * by THAT file's own script location — i.e., whichever checkout is actually running, the SAME one every
 * `review-*`/`fix-*` session it dispatches inherits as its own `cwd`, per `review-dispatch.mjs`'s `root`) are
 * BOTH opted into deliberately, stricter than `session-reaper.mjs`'s own historical CLI default — this is the
 * first caller to run that pass against LIVE, unattended production sessions on a recurring schedule rather
 * than a one-off/dry-run invocation, so it takes every available safety axis rather than the original
 * ground-truth-only default. See {@link defaultReapSessions} and `session-reaper.mjs`'s own doc for exactly
 * what each guard does. A session-reap failure is swallowed exactly like every other best-effort mechanical
 * pass in this repo (`runner.mjs`'s `makeCliMechanicalPasses`) — it never fails the review tick itself.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { runReconcilePass } from '../../scripts/conveyor/reconcile-pass.mjs';
import { dispatchReview } from '../../scripts/operations/review-dispatch.mjs';
import { tagReviewRound } from '../../scripts/conveyor/review-round-tag.mjs';
import { tagReviewStatus } from '../../scripts/conveyor/review-status-tag.mjs';
// #x01u7az — the review-hold reconcile sweep (a stray review:pending beside a live review:human; a stray
// advisory:* once review:human is cleared) lives here, not only in we:skills-src/conveyor/runner.mjs's own
// `makeCliMechanicalPasses` (see that file's header: it is NOT itself running — replaced by this daemon and
// the Fix-dispatch daemon). This daemon owns review labels end to end and already self-updates
// (`withSelfSync`) and self-heals (`withGithubAppAuth`, the per-repo isolation below) with NO launchd install
// beyond the one this daemon already has, so wiring it here is the one change that actually reaches the live
// PRs — landing it in `runner.mjs` alone would leave #2549/#2578's stray labels uncleaned indefinitely, the
// exact gap this wiring closes.
import { sweepReviewHoldLabels } from '../../scripts/conveyor/review-hold-reconcile.mjs';
import { selectStatusCandidates } from '../../scripts/conveyor/reconcile-core.mjs';
import { runSessionReaperPass, REPO_ROOT as SESSION_REAPER_REPO_ROOT, DEFAULT_IDLE_REAP_THRESHOLD_MS } from '../../scripts/conveyor/session-reaper.mjs';
import { freeLaneNumbers } from '../../scripts/conveyor/reconcile-fix-dispatch.mjs';
import { repoProfile } from '../../scripts/lib/repo-profile.mjs';
import { CONSTELLATION_REPOS } from '../../scripts/lib/constellation-repos.mjs';
import { forEachRepo } from '../../scripts/lib/for-each-repo.mjs';
import { withGithubAppAuth } from '../../scripts/lib/github-app-auth-env.mjs';
import { withSelfSync } from '../../scripts/lib/daemon-self-sync.mjs';
import { isStaleMainRefusalMessage } from '../../scripts/lib/main-staleness.mjs';
import {
  RUNNER_LOCK_ROOT, makeOwner,
  acquireRunnerLease, heartbeatRunnerLease, releaseRunnerLeaseIfOwned,
} from './runner-lock.mjs';

/** This daemon's own lease key — distinct from the Dispatcher's default sentinel, #3870's Fix-dispatch key,
 *  and any future daemon's own key (#3877). */
export const REVIEW_DAEMON_LEASE_KEY = '<conveyor:review-daemon-lease>';

/** Matches runner.mjs's own tick cadence — this sequence ran at that rate as one of its mechanical passes. */
export const DEFAULT_INTERVAL_MS = 120_000;

const WE_SLUG = CONSTELLATION_REPOS.we.slug;

// ── PURE CORE (no IO — every effect is injected; unit-tested directly) ─────────────────────────────────────

/** Identical shape to we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs's own `runDaemonLoop` — see
 *  that file's header for why it is duplicated here rather than imported (not yet landed on `main`). */
export async function runDaemonLoop({
  tickOnce, sleep, heartbeat = () => true, onTick = () => {}, onTickError = () => {},
  intervalMs = DEFAULT_INTERVAL_MS, maxTicks = Infinity,
}) {
  if (typeof tickOnce !== 'function') throw new TypeError('runDaemonLoop requires a tickOnce effect');
  let tick = 0;
  for (;;) {
    try {
      const result = await tickOnce();
      onTick(result, tick);
    } catch (error) {
      onTickError(error, tick);
    }
    const alive = await heartbeat();
    if (!alive) return { ticks: tick + 1, stoppedReason: 'lease-lost' };
    if (tick + 1 >= maxTicks) return { ticks: tick + 1, stoppedReason: 'max-ticks' };
    await sleep(intervalMs);
    tick += 1;
  }
}

/**
 * One tick: discover PRs owed a review (`reconcile`), dispatch an independent review for each
 * (`dispatch`), then apply the two purely-informative labels (`tagRound`/`tagStatus`) — the exact sequence
 * runner.mjs's own mechanical pass ran (see the file header for what's deliberately NOT replicated). Every
 * per-PR step is isolated in its own try/catch, mirroring `makeCliMechanicalPasses`'s own "one bad entry
 * never aborts the rest" discipline — a failed dispatch or a failed tag never stops the tick. `reconcile`
 * itself is now isolated the same way (#xvzwiew) — see the try/catch around it below for why.
 *
 * #3383 bug 3 — live-caught 2026-09-24: every dispatched review session runs its OWN `lane-pool.mjs acquire`
 * as its first step (`review-dispatch.mjs`'s own brief; this daemon never acquires a lane itself), so a tick
 * that fires N sessions against a pool with fewer than N lanes actually acquirable right now guarantees at
 * least N-minus-acquirable of them fail (review-2597/2584/2578/2600/2602, all within 2 minutes, pool
 * "web-everything" — every one an independent session hitting the SAME starved pool at once). `acquirableLanes`
 * is a real read (`defaultAcquirableLaneCount`, wired in by `buildCliDaemonEffects` for the actual daemon) that
 * this tick caps its own dispatch batch by; it defaults to an unbounded `() => Infinity` here so every
 * pre-existing caller/test of this pure function is unaffected unless it opts in.
 * @returns {{reviewsOwed:number, dispatched:Array<{prNumber:number, agentId:string|null}>, failed:Array<{prNumber:number, error:string}>, refusals:number, reconcileError:string|null, deferredForLanes:number, holdReconcile:Array<object>, holdReconcileError:string|null}}
 */
export function runReviewTick({
  reconcile = runReconcilePass,
  dispatch = dispatchReview,
  tagRound = tagReviewRound,
  tagStatus = tagReviewStatus,
  statusCandidates = selectStatusCandidates,
  holdReconcile = sweepReviewHoldLabels,
  acquirableLanes = () => Infinity,
  repo = WE_SLUG,
} = {}) {
  // #x01u7az — runs FIRST and INDEPENDENTLY of `reconcile`'s own plan: it is a plain `gh pr list` + label read
  // over the whole repo, not scoped to whatever this tick's discovery found owed, so a `reconcile` failure
  // below must never suppress it. Isolated in its own try/catch, same "one bad entry never aborts the rest"
  // discipline as every other step in this tick — a `gh` hiccup here must not cost a review dispatch.
  let holdReconcileResults = [];
  let holdReconcileError = null;
  try {
    holdReconcileResults = holdReconcile({ repo }) ?? [];
  } catch (e) {
    holdReconcileError = String((e && e.message) || e).split('\n')[0];
  }
  // `repo` used to reach dispatch/tagRound/tagStatus but never `reconcile` itself (live-caught 2026-09-22,
  // #xvyuwtg): `reconcile({})` always discovered WE's own PRs regardless of the `repo` this tick was called
  // for, which is exactly why plugging in a non-WE repo here silently kept reconciling WE. `reconcile-pass.mjs`'s
  // own `runReconcilePass` already accepts `{repo}` end to end — this was the one call site that dropped it.
  //
  // RECONCILE ITSELF IS ISOLATED HERE (#xvzwiew, live-caught 2026-09-23) — the one step in this sequence that
  // used to be the EXCEPTION to this file's own "one bad entry never aborts the rest" discipline. A transient
  // `claude agents --json` spawn hiccup inside `reconcile-pass.mjs`'s `defaultReadAgents` (`spawnSync claude
  // ENOENT` in the review daemon's own production log, `~/workspace/wev-review-daemon/.conveyor/
  // review-daemon.log`; also observed as `Unknown system error -8` and `ETIMEDOUT` — a flaky spawn under load,
  // not a missing binary or a wrong cwd: `defaultListAgents` never varies its cwd by repo) used to throw
  // straight out of this function uncaught. `runReviewTickAllRepos` then reported that ONE failure TWICE and
  // misleadingly: once folded into `failed` as though a SPECIFIC review dispatch had failed (`prNumber: null`,
  // rendered `#?` in the daemon's own log line — no PR was ever identified, because reconcile crashed before
  // producing one), and once as a `repos[].error` entry. Catching it here reports it through exactly ONE clear
  // channel (`reconcileError`) and — the real functional cost of the old behavior — stops it from silently
  // discarding whatever this repo's tick WOULD have dispatched had the read succeeded; the caller can still
  // retry next tick, exactly as before, just without the double, contradictory report.
  let plan;
  try {
    plan = reconcile({ repo });
  } catch (e) {
    return {
      reviewsOwed: 0, dispatched: [], failed: [], refusals: 0, deferredForLanes: 0,
      reconcileError: String((e && e.message) || e).split('\n')[0],
      holdReconcile: holdReconcileResults, holdReconcileError,
    };
  }
  const reviews = (plan.dispatch ?? []).filter((d) => d && d.kind === 'review');
  // Live-caught 2026-09-22, #xli631k: a PR that moved to being owed a FIX (not a review) used to never
  // reach `statusCandidates` at all, so its `review-status:reviewing` label sat stale once its review
  // session finished (PR #2472, ~2 hours stale). `selectStatusCandidates` now takes fix-owed entries as a
  // real third source, included below the same unconditional way `reviews` already is.
  const fixes = (plan.dispatch ?? []).filter((d) => d && d.kind === 'fix');
  // #3383 bug 3 — cap THIS TICK's dispatch batch by how many lanes are actually acquirable right now, never
  // by `reviews.length` alone. A deferred review is NOT lost: it stays owed (still counted in `reviewsOwed`
  // and still fed to `statusCandidates` below, unchanged, since no session was ever bound to it), and simply
  // reappears in the next tick's plan 120s later, by which point growth/reclaim/releases may well have freed
  // up capacity. `Math.max(0, …)` tolerates a negative/garbage read the same way `Math.min` below tolerates
  // an oversized one — both fail toward "dispatch nothing this tick", never toward "dispatch more than asked".
  const acquirable = Math.max(0, Number(acquirableLanes({ repo })) || 0);
  const dispatchable = reviews.slice(0, Math.min(reviews.length, acquirable));
  const deferredForLanes = reviews.length - dispatchable.length;
  const dispatched = [];
  const failed = [];
  for (const d of dispatchable) {
    try {
      const result = dispatch({ pr: d.prNumber, repo });
      dispatched.push({ prNumber: d.prNumber, agentId: result.agentId ?? null });
    } catch (e) {
      failed.push({ prNumber: d.prNumber, error: String((e && e.message) || e).split('\n')[0] });
      continue; // no round tag on a failed dispatch — the round did not actually advance
    }
    try { tagRound({ pr: d.prNumber, repo, round: (d.attempts ?? 0) + 1 }); }
    catch { /* cosmetic — a failed tag never fails the tick, see review-round-tag.mjs's own header */ }
  }
  for (const c of statusCandidates(reviews, plan.refusals ?? [], fixes)) {
    try { tagStatus({ pr: c.prNumber, repo }); }
    catch { /* cosmetic — see review-status-tag.mjs's own header */ }
  }
  return {
    reviewsOwed: reviews.length, dispatched, failed, refusals: (plan.refusals ?? []).length,
    reconcileError: null, deferredForLanes,
    holdReconcile: holdReconcileResults, holdReconcileError,
  };
}

/** The repos this daemon watches each tick. Today: the three constellation repos (WE-only was the ratified
 *  scope at build time — see the file header — but plateau-app PR #167 sat `review:pending` with nothing
 *  watching it, live-caught 2026-09-22, #xvyuwtg). Kept as a plain exported list, not inlined into the loop
 *  below, so a future per-user configurable repo list (plateau as a product letting an operator choose which
 *  repos to integrate) is a source swap here, not a redesign of {@link runReviewTickAllRepos}. */
export const REVIEW_DAEMON_REPOS = Object.values(CONSTELLATION_REPOS).map((r) => r.slug);

/**
 * Run {@link runReviewTick} once per watched repo, isolating one repo's failure from the rest — a plateau-app
 * `gh` outage (or a rate limit, or a repo with zero open PRs) must never stop WE's own reviews from being
 * dispatched, the same "one bad entry never aborts the rest" discipline `runReviewTick` already applies
 * per-PR, one level up. Every downstream step this daemon already calls (`reconcile-pass.mjs`,
 * `review-dispatch.mjs`, both tag scripts) was already fully repo-generic before this — the daemon's own tick
 * was the only WE-hardcoded link (see `runReviewTick`'s own `repo` fix above, filed the same day this was).
 * @param {{repos?:string[], tick?:Function}} [o] - `tick` is injectable (defaults to `runReviewTick`); every
 *   other option is forwarded to it for EVERY repo except `repo` itself, which this loop supplies per-iteration.
 * @returns {{repos:Array<{repo:string, result?:object, error?:string}>, reviewsOwed:number,
 *   dispatched:Array<object>, failed:Array<object>, refusals:number, reconcileFailed:Array<{repo:string, error:string}>,
 *   deferredForLanes:number, holdReconcile:Array<{num:number, remove:string[], repo:string}>,
 *   holdReconcileFailed:Array<{repo:string, error:string}>}}
 */
export function runReviewTickAllRepos({ repos = REVIEW_DAEMON_REPOS, tick = runReviewTick, ...tickOpts } = {}) {
  const perRepo = forEachRepo(repos, (repo) => tick({ ...tickOpts, repo }));
  const dispatched = [];
  const failed = [];
  // #xvzwiew — a RECONCILE-PHASE failure (`runReviewTick` now catches it and returns `reconcileError` instead
  // of throwing) reports through this SEPARATE bucket, never folded into `failed` as a bogus `prNumber: null`
  // dispatch failure — no PR was ever identified for a repo whose reconcile crashed, so reporting it as if a
  // specific review dispatch failed was always misleading. `entry.error` below (a whole-tick throw `tick`
  // itself never caught — the genuinely-unexpected case) still reports through `failed`/`repos[].error`,
  // unchanged: that safety net is orthogonal to this and stays in place.
  const reconcileFailed = [];
  // #x01u7az — the review-hold reconcile sweep runs INDEPENDENTLY of `reconcile`'s own plan inside
  // `runReviewTick` (it populates both the normal AND the early-`reconcileError`-return shape), so it is
  // aggregated here BEFORE the `reconcileError` continue below, never skipped alongside the dispatch/refusal
  // data a failed reconcile genuinely has none of.
  const holdReconcileRemoved = [];
  const holdReconcileFailed = [];
  let reviewsOwed = 0;
  let refusals = 0;
  let deferredForLanes = 0;
  for (const entry of perRepo) {
    if (entry.error) {
      failed.push({ prNumber: null, repo: entry.repo, error: entry.error });
      continue;
    }
    const { repo, result } = entry;
    for (const h of (result?.holdReconcile ?? [])) holdReconcileRemoved.push({ ...h, repo });
    if (result?.holdReconcileError) holdReconcileFailed.push({ repo, error: result.holdReconcileError });
    if (result?.reconcileError) {
      reconcileFailed.push({ repo, error: result.reconcileError });
      continue; // no dispatch/refusal data — reconcile never produced a plan this tick
    }
    reviewsOwed += result.reviewsOwed;
    refusals += result.refusals;
    deferredForLanes += result.deferredForLanes ?? 0;
    for (const d of result.dispatched) dispatched.push({ ...d, repo });
    for (const f of result.failed) failed.push({ ...f, repo });
  }
  return {
    repos: perRepo, reviewsOwed, dispatched, failed, refusals, reconcileFailed, deferredForLanes,
    holdReconcile: holdReconcileRemoved, holdReconcileFailed,
  };
}

/**
 * #3383 bug 1 — did this tick's own result show it hit `assertMainNotStale`'s refusal for at least one PR or
 * repo? Two shapes both carry it: a per-PR `dispatchReview` throw (`runReviewTick`'s own `failed.push({
 * prNumber, error })` loop) and a whole-repo tick failure (`forEachRepo`'s own `{repo, error}` capture, surfaced
 * here as `result.repos[].error`). Wired into `withSelfSync`'s `hasStaleRefusal` option so the daemon re-syncs
 * immediately instead of wasting the full interval on a race it will otherwise keep losing. Pure.
 * @param {{failed?:Array<{error?:string}>, repos?:Array<{error?:string}>}} tickResult
 * @returns {boolean}
 */
export function hasStaleMainRefusal(tickResult) {
  const failed = tickResult?.failed ?? [];
  const repos = tickResult?.repos ?? [];
  return failed.some((f) => isStaleMainRefusalMessage(f?.error)) || repos.some((r) => isStaleMainRefusalMessage(r?.error));
}

/**
 * #3383 bug 3 — the REAL `acquirableLanes` effect: how many lanes are acquirable RIGHT NOW in `repo`'s own
 * pool. Reuses `reconcile-fix-dispatch.mjs`'s own `freeLaneNumbers` — the SAME `lane-pool.mjs list
 * --acquirable --json` read `tick-core.mjs`'s IO shell already uses — rather than re-deriving a second copy;
 * `repoProfile(repo).lanePoolRepo` is the exact same derivation `review-dispatch.mjs#planReviewDispatch`
 * already uses to pick which pool a given repo's own review session acquires from. Fail-soft, like
 * `freeLaneNumbers` itself: any read hiccup (`gh`/git/lane-pool timeout) reads as 0 acquirable, so a starved
 * or momentarily-unreadable pool defers EVERY review this tick rather than guessing high — self-heals next
 * tick, 120s later.
 * @param {{repo:string}} o
 * @returns {number}
 */
export function defaultAcquirableLaneCount({ repo }) {
  return freeLaneNumbers({ lanePoolRepo: repoProfile(repo).lanePoolRepo }).length;
}

// ── IO SHELL (runs only as a CLI — owns the real lease + the real reconcile/dispatch/tag calls) ─────────────

// Live-caught bug (this daemon's own first launchd-managed run, and the sibling #3870/pass-daemon.mjs
// daemons built on this exact pattern): `.unref()`-ing this timer told Node it was fine to exit before it
// fired. Between ticks, nothing else keeps the event loop alive (a spawned agent's own stdio is `ignore`d —
// no other ref'd handle exists), so the daemon exited right after its FIRST tick instead of waiting out
// `intervalMs` and looping. A REF'd timer (Node's default — no `.unref()`) is exactly what a resident
// daemon needs: the sleep IS the reason it stays alive between ticks.
export function realSleep(ms) { return new Promise((resolve) => { setTimeout(resolve, ms); }); }

/**
 * THE DEFAULT SESSION-REAP EFFECT for one tick — see the file header ("THE SESSION REAPER LIVES HERE TOO")
 * for why this daemon owns it and why every option below is deliberately stricter than
 * `session-reaper.mjs`'s own CLI default:
 *   - `allowedCwd: SESSION_REAPER_REPO_ROOT` — scopes reaping to sessions spawned from THIS checkout (the
 *     naming-pattern-plus-cwd safety rule); resolved by `session-reaper.mjs`'s OWN script location, so it is
 *     always this daemon's real dedicated-clone root, never a hardcoded path.
 *   - `neverReapWorking: true` — a session the listing itself reports as still actively `working` is never
 *     touched, full stop, even if a secondary signal (a merged PR, a completion record) suggests otherwise.
 *   - `idleThresholdMs: DEFAULT_IDLE_REAP_THRESHOLD_MS` — the generous last-resort backstop for a `blocked`
 *     session neither the completion-record nor the backlog/PR axis can confirm either way.
 * Every other option (the listing read, the ground-truth resolver, the completion-record resolver, the real
 * `claude stop`) is `session-reaper.mjs`'s own default. Injectable so a test can swap it for a fake.
 */
export function defaultReapSessions() {
  return runSessionReaperPass({
    allowedCwd: SESSION_REAPER_REPO_ROOT,
    neverReapWorking: true,
    idleThresholdMs: DEFAULT_IDLE_REAP_THRESHOLD_MS,
  });
}

export function buildCliDaemonEffects({
  owner, intervalMs = DEFAULT_INTERVAL_MS, log = console,
  reapSessions = defaultReapSessions,
  // #3383 bug 3 — the real daemon wires the real `acquirableLanes` effect through by default, so production
  // dispatch is bounded by lane reality; `runReviewTick`'s OWN default stays unbounded (`() => Infinity`) so
  // every pre-existing test of it (which fakes reconcile/dispatch directly, never this) is unaffected.
  runReview = (opts) => runReviewTickAllRepos({ acquirableLanes: defaultAcquirableLaneCount, ...opts }),
} = {}) {
  return {
    intervalMs,
    tickOnce: async () => {
      const result = await runReview();
      // Best-effort, mirrors `runner.mjs`'s own `makeCliMechanicalPasses` discipline: a session-reap failure
      // is logged and swallowed, never lets a lingering `claude` process take down this tick's real job
      // (dispatching/tagging reviews).
      let sessionReap = null;
      try {
        sessionReap = reapSessions();
      } catch (e) {
        log.error(`review-daemon: session-reap failed (non-fatal): ${String((e && e.message) || e).split('\n')[0]}`);
      }
      return { ...result, sessionReap };
    },
    sleep: realSleep,
    heartbeat: () => heartbeatRunnerLease(RUNNER_LOCK_ROOT, owner, { key: REVIEW_DAEMON_LEASE_KEY }),
    onTick: (result) => {
      log.error(`review-daemon: tick (${result.repos.map((r) => r.repo).join(', ')}) — ${result.reviewsOwed} owed, dispatched ${result.dispatched.length}, failed ${result.failed.length}${result.deferredForLanes ? `, deferred ${result.deferredForLanes} (no acquirable lane this tick, #3383)` : ''}`);
      for (const f of result.failed) log.error(`review-daemon: ${f.repo}#${f.prNumber ?? '?'} failed (non-fatal): ${f.error}`);
      // #xvzwiew — a reconcile-phase failure (discovery itself, e.g. a transient `claude agents --json`
      // ENOENT) reports here ONLY, never also folded into the `failed` (dispatch) line above — see
      // `runReviewTickAllRepos`'s own header for why the old double, contradictory report was a bug.
      for (const rf of (result.reconcileFailed ?? [])) log.error(`review-daemon: ${rf.repo} reconcile failed (non-fatal, other repos unaffected): ${rf.error}`);
      for (const r of result.repos) if (r.error) log.error(`review-daemon: ${r.repo} tick failed unexpectedly (non-fatal, other repos unaffected): ${r.error}`);
      // #x01u7az — the review-hold reconcile sweep's own findings: a stray review:pending beside a live
      // review:human, or a stray advisory:* once review:human is cleared (see review-hold-reconcile.mjs's
      // header for the live PRs — #2549, #2578 — this cleans up).
      for (const h of (result.holdReconcile ?? [])) log.error(`review-daemon: ${h.repo}#${h.num} hold-reconcile removed ${h.remove.join(',')}${h.error ? ` (FAILED: ${h.error})` : ''}`);
      for (const hf of (result.holdReconcileFailed ?? [])) log.error(`review-daemon: ${hf.repo} hold-reconcile failed (non-fatal, other repos unaffected): ${hf.error}`);
      if (result.sessionReap && !result.sessionReap.unreadable) {
        const sr = result.sessionReap;
        log.error(`review-daemon: session-reap — ${sr.scanned} scanned, ${sr.stopped} stopped${sr.alreadyGone ? `, ${sr.alreadyGone} already gone` : ''}${sr.failures ? `, ${sr.failures} failed` : ''}${sr.anomalies ? `, ${sr.anomalies} anomalies` : ''}, ${sr.kept} kept`);
      }
    },
    onTickError: (error) => {
      log.error(`review-daemon: tick failed (non-fatal): ${String((error && error.message) || error).split('\n')[0]}`);
    },
  };
}

async function main() {
  const owner = makeOwner('review-daemon');
  const acquired = acquireRunnerLease(RUNNER_LOCK_ROOT, owner, { key: REVIEW_DAEMON_LEASE_KEY });
  if (!acquired.ok) {
    console.error(`review-daemon: a live instance already holds the lease (${acquired.heldBy}) — exiting.`);
    return;
  }
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.error(`review-daemon: ${signal} — releasing the lease and exiting.`);
    releaseRunnerLeaseIfOwned(RUNNER_LOCK_ROOT, owner, { key: REVIEW_DAEMON_LEASE_KEY });
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  console.error(`review-daemon: started on ${hostname()}:${process.pid}, tick every ${DEFAULT_INTERVAL_MS}ms.`);
  // xv6fciw — keep this daemon's dedicated clone on origin/main, and restart onto new code BETWEEN ticks
  // (launchd KeepAlive brings it back), instead of refusing every dispatch until someone re-syncs by hand.
  const selfRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
  const restartOntoNewCode = () => {
    stopping = true;
    releaseRunnerLeaseIfOwned(RUNNER_LOCK_ROOT, owner, { key: REVIEW_DAEMON_LEASE_KEY });
    process.exit(0);
  };
  const { stoppedReason } = await runDaemonLoop(
    withSelfSync(withGithubAppAuth(buildCliDaemonEffects({ owner })), {
      root: selfRoot, onRestart: restartOntoNewCode, hasStaleRefusal: hasStaleMainRefusal,
    }),
  );
  if (!stopping) {
    console.error(`review-daemon: loop stopped (${stoppedReason}) — releasing the lease and exiting.`);
    releaseRunnerLeaseIfOwned(RUNNER_LOCK_ROOT, owner, { key: REVIEW_DAEMON_LEASE_KEY });
  }
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  main().catch((e) => { console.error(`review-daemon: fatal: ${String((e && e.message) || e)}`); process.exit(1); });
}
