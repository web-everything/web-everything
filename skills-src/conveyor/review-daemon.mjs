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
import { runReconcilePass, defaultReadPrs, defaultReadAgents } from '../../scripts/conveyor/reconcile-pass.mjs';
import { notifyReferralHold } from '../../scripts/conveyor/review-referral-hold.mjs';
// x26lw6u — the review is dispatched as a deterministic JOB (`review-job.mjs`: acquire → review-loop-cli →
// report → release, no Claude wrapper session); `WE_REVIEW_DISPATCH_MODE=session` keeps the old `claude --bg`
// path reachable. The jurors review-loop-cli spawns are the fresh, independent reviewers either way.
import { parseEscalationReason } from '../../scripts/review-detail.mjs';
import { dispatchReviewByMode } from '../../scripts/operations/review-job.mjs';
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
// #xconv1 (web-everything/web-everything#2766/#2767 unblock) — the mechanical, no-session executor for a
// `kind:'convert-advisory'` dispatch entry. Wired as its OWN additive pipeline stage below
// (`runConvertAdvisoryTick`/`runConvertAdvisoryTickAllRepos`), never folded into `runReviewTick`'s existing
// `reviews`/`fixes` dispatch loop: that loop is gated on `acquirableLanes` (a convert-advisory entry needs no
// lane) and is fully SYNCHRONOUS (posting the note + running the targeted-check judge seat are both async IO,
// and `runReviewTick`'s own return shape is pinned byte-for-byte by many existing exact-equality tests).
import { dispatchConvertAdvisory } from '../../scripts/conveyor/convert-advisory-dispatch.mjs';
import { planClaudeAuthDispatchGate } from '../../scripts/conveyor/claude-auth-health.mjs'; // card x5kagse
import { runSessionReaperPass, makeReapedLedger, makePidDeadResolver, REPO_ROOT as SESSION_REAPER_REPO_ROOT, DEFAULT_IDLE_REAP_THRESHOLD_MS } from '../../scripts/conveyor/session-reaper.mjs';
import { mintSessionSlug } from '../../scripts/conveyor/session-slug.mjs';
import { freeLaneNumbers } from '../../scripts/conveyor/reconcile-fix-dispatch.mjs';
import { repoProfile } from '../../scripts/lib/repo-profile.mjs';
import { CONSTELLATION_REPOS, repoKeyForSlug } from '../../scripts/lib/constellation-repos.mjs';
import { forEachRepo } from '../../scripts/lib/for-each-repo.mjs';
import { withGithubAppAuth, FLEET_APP_AUTH_OPTS } from '../../scripts/lib/github-app-auth-env.mjs';
import { withSelfSync } from '../../scripts/lib/daemon-self-sync.mjs';
import { withPrEvents, makeDrainNudgeForward } from '../../scripts/lib/pr-events.mjs';
import { makePoolExhaustionLogger } from '../../scripts/conveyor/pool-exhaustion.mjs';
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

/** The labels whose PRs get a per-tick "why not dispatched" line: `review:pending` (the drain parked it for an
 *  independent review, `review-escalation.mjs`) and `ci:failed` (a required check is red — owed a ci-heal). */
export const EXPLAINED_HOLD_LABELS = ['review:pending', 'ci:failed'];

/**
 * Live-caught 2026-09-26 (WE PRs #2746–#2758 sat `review:pending` for ~an hour while every tick logged only
 * "N owed" — nothing said WHY each parked PR was skipped, so a correct `live-process` refusal (a stale fix /
 * ci-heal session still bound to the PR) looked exactly like a discovery bug). For every open PR carrying
 * `review:pending` that this tick did NOT hand to `dispatch`, return the reason(s) straight from the reconcile
 * plan — never re-derived. Pure. `prs` is the tick's own shared `gh pr list` read; `null` (the opt-out
 * no-shared-reads path) returns `[]`, since there is then no label list to scan.
 * @param {{prs:Array<object>|null, plan:{dispatch?:Array<object>, refusals?:Array<object>}, dispatchable:Array<object>,
 *   deferredForLanes?:Array<object>, paused?:boolean}} o
 * @returns {Array<{prNumber:number, labels:string[], reasons:string[]}>}
 */
export function explainPendingNotDispatched({ prs, plan, dispatchable = [], deferredForLanes = [], paused = false }) {
  if (!Array.isArray(prs)) return [];
  const labelName = (l) => (typeof l === 'string' ? l : l?.name);
  const sent = new Set(dispatchable.map((d) => Number(d.prNumber)));
  const deferred = new Set(deferredForLanes.map((d) => Number(d.prNumber)));
  const out = [];
  for (const pr of prs) {
    const n = Number(pr?.number);
    if (!Number.isInteger(n) || sent.has(n)) continue;
    // Referral holds have one durable notice/log, never one explanation per tick.
    if (plan?.refusals?.some(r => r.prNumber === n
      && (r.kind === 'review-referrals-pending' || r.reviewRefusal?.kind === 'review-referrals-pending'))) continue;
    const held = (pr?.labels ?? []).map(labelName).filter((l) => EXPLAINED_HOLD_LABELS.includes(l));
    if (held.length === 0) continue;
    const reasons = [];
    if (deferred.has(n)) reasons.push(paused ? 'review owed, but dispatch is paused (Claude login)' : 'review owed, but no acquirable lane this tick');
    for (const d of (plan?.dispatch ?? [])) {
      if (Number(d?.prNumber) === n && d.kind !== 'review') reasons.push(`owed a ${d.kind}, not a review — ${d.why ?? ''}`.trim());
    }
    for (const r of (plan?.refusals ?? [])) {
      if (Number(r?.prNumber) !== n) continue;
      const bind = r.cwd || r.pid != null ? ` [cwd=${r.cwd ?? '?'} pid=${r.pid ?? 'absent'}]` : '';
      reasons.push(`${r.kind}: ${r.why ?? ''}${bind}`);
    }
    if (reasons.length === 0) reasons.push('absent from the reconcile plan (no dispatch, no refusal)');
    out.push({ prNumber: n, labels: held, reasons });
  }
  return out;
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
  dispatch = dispatchReviewByMode,
  tagRound = tagReviewRound,
  tagStatus = tagReviewStatus,
  statusCandidates = selectStatusCandidates,
  holdReconcile = sweepReviewHoldLabels,
  notifyReferral = notifyReferralHold,
  acquirableLanes = () => Infinity,
  // Pool-exhaustion reporting: `{exhausted({repo, deferred}), recovered(repo)}` (see
  // `we:scripts/conveyor/pool-exhaustion.mjs`). `null` (the default) keeps every existing test byte-identical;
  // the real daemon wires a logger that says WHY the pool is empty once per episode, never a silent skip.
  poolExhaustion = null,
  repo = WE_SLUG,
  // #4133 (epic #3383/#4075) — audit `we:reports/2026-09-24-daemon-blocking-antipatterns.md` finding R2: the
  // tick's OWN single `gh pr list` / `claude agents --json` reads, taken ONCE here and reused two ways —
  // (1) injected straight into `reconcile` below, so ITS OWN internal `readPrs`/`readAgents` calls become a
  // no-op reuse of this SAME data rather than a second fetch; (2) passed as `currentLabels`/`agents` into
  // `tagRound`/`tagStatus`, which otherwise re-fetch the identical facts once PER PR they tag (`we:scripts/
  // conveyor/review-round-tag.mjs`/`we:scripts/conveyor/review-status-tag.mjs`'s own `currentLabels`/`agents`
  // params exist for exactly this). DELIBERATELY OPT-IN (`null` default, never `defaultReadPrs`/
  // `defaultReadAgents` directly): every pre-existing test of this function mocks `reconcile` to skip its real
  // IO, and a non-null default here would make THIS function's own new pre-fetch step spawn a real `gh`/
  // `claude` process underneath every one of them regardless — the exact antipode of what this card fixes.
  // `null` (the default) is BYTE-IDENTICAL to this function's pre-#4133 behavior: `reconcile` is called with
  // just `{repo}`, and `tagRound`/`tagStatus` get no `currentLabels`/`agents`, falling back to their own
  // existing fresh reads exactly as before. The real daemon (`buildCliDaemonEffects`, below) opts in.
  readPrs = null,
  readAgents = null,
  // card x5kagse (epic #4075/#3383) — while the operator's Claude login is broken
  // (`we:scripts/conveyor/claude-auth-health.mjs`), no NEW review session is dispatched, full stop: `false` by
  // default so every pre-existing test of this function (none of which pass this) is unaffected. The real
  // daemon (`runReviewTickAllRepos`, below) computes this ONCE per tick (host-global, not per-repo) and forwards
  // it into every repo's own call.
  paused = false,
  pauseReason = null,
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
  // #4133 — read ONCE, here, and hand the SAME data into `reconcile` (via injected `readPrs`/`readAgents`
  // closures) so its own internal fetch is a reuse, not a second call. Isolated in the SAME try/catch as
  // `reconcile` itself always was — a fetch hiccup here is the identical failure class #xvzwiew's own comment
  // documents (a flaky `claude`/`gh` spawn under load), just now caught one call frame earlier.
  const sharedReads = typeof readPrs === 'function' && typeof readAgents === 'function';
  let plan;
  let rawPrs = null;
  let rawAgents = null;
  try {
    if (sharedReads) {
      rawPrs = readPrs({ repo });
      rawAgents = readAgents({});
      plan = reconcile({ repo, readPrs: () => rawPrs, readAgents: () => rawAgents });
    } else {
      plan = reconcile({ repo });
    }
  } catch (e) {
    return {
      reviewsOwed: 0, dispatched: [], failed: [], refusals: 0, deferredForLanes: 0,
      reconcileError: String((e && e.message) || e).split('\n')[0],
      holdReconcile: holdReconcileResults, holdReconcileError,
    };
  }
  // Keyed by PR number so `tagRound`/`tagStatus` below can look up EACH PR's own already-fetched labels rather
  // than asking `gh` again — `undefined` (a PR the tick's own listing somehow missed, a rare open-PR-appeared-
  // mid-tick race) falls through to each helper's own fresh-read default, never a hard failure.
  const labelsByPr = new Map((Array.isArray(rawPrs) ? rawPrs : []).map((p) => [Number(p?.number), p?.labels ?? []]));
  // draft-first PRs (operator-approved 2026-09-27) — the SAME `rawPrs` snapshot already carries `isDraft`
  // (`reconcile-pass.mjs#PR_LIST_JSON_FIELDS`); threaded into `tagStatus` below so `review-status:awaiting-ci`
  // reflects the PR's OWN current draft state, never a second `gh` read.
  const isDraftByPr = new Map((Array.isArray(rawPrs) ? rawPrs : []).map((p) => [Number(p?.number), !!p?.isDraft]));
  // `fixing-conflict` (draft reason at a glance, operator ask 2026-09-27, #2811 follow-up) — the SAME `rawPrs`
  // snapshot already carries `mergeStateStatus` (`reconcile-pass.mjs#PR_LIST_JSON_FIELDS`, the identical field
  // `reconcile-core.mjs#classifyPr`'s `conflicted` phase reads); threaded into `tagStatus` below so a live
  // fixer working a PR GitHub itself reports as conflicting reads `review-status:fixing-conflict`, never the
  // generic `fixing` — no second `gh` read.
  const mergeConflictedByPr = new Map((Array.isArray(rawPrs) ? rawPrs : [])
    .map((p) => [Number(p?.number), String(p?.mergeStateStatus ?? '').toUpperCase() === 'DIRTY']));
  const reviews = (plan.dispatch ?? []).filter((d) => d && d.kind === 'review');
  // Live-caught 2026-09-22, #xli631k: a PR that moved to being owed a FIX (not a review) used to never
  // reach `statusCandidates` at all, so its `review-status:reviewing` label sat stale once its review
  // session finished (PR #2472, ~2 hours stale). `selectStatusCandidates` now takes fix-owed entries as a
  // real third source, included below the same unconditional way `reviews` already is.
  const fixes = (plan.dispatch ?? []).filter((d) => d && d.kind === 'fix');
  // Live-caught 2026-09-26, PR #2742, card xg790dh: a PR that moves from being owed a FIX to being owed a
  // CI-HEAL (its fix session finished, its re-push then went CI-red) used to fall out of `statusCandidates`
  // just the same — `kind:'ci-heal'` matched neither `reviews` nor `fixes` above, and a ci-heal-owed PR is a
  // real `dispatch` entry (not a refusal) whenever its cap is unspent. `review-status:fixing` (added while the
  // fix was genuinely live) sat stale indefinitely. `selectStatusCandidates` now takes ci-heal-owed entries as
  // a real fourth source, included below the same unconditional way `reviews`/`fixes` already are.
  const ciHeals = (plan.dispatch ?? []).filter((d) => d && d.kind === 'ci-heal');
  // #3383 bug 3 — cap THIS TICK's dispatch batch by how many lanes are actually acquirable right now, never
  // by `reviews.length` alone. A deferred review is NOT lost: it stays owed (still counted in `reviewsOwed`
  // and still fed to `statusCandidates` below, unchanged, since no session was ever bound to it), and simply
  // reappears in the next tick's plan 120s later, by which point growth/reclaim/releases may well have freed
  // up capacity. `Math.max(0, …)` tolerates a negative/garbage read the same way `Math.min` below tolerates
  // an oversized one — both fail toward "dispatch nothing this tick", never toward "dispatch more than asked".
  // card x5kagse — a login-broken tick dispatches NOTHING (`acquirable` forced to 0 rather than skipping this
  // whole block): every review stays owed exactly like a lane-starved tick already does (`reviewsOwed` and
  // `statusCandidates` below are unaffected), so nothing here re-derives a second "was anything dispatched"
  // path — it is the SAME deferred-not-lost shape `deferredForLanes` already models, just for a different cause.
  const lanes = paused ? 0 : acquirableLanes({ repo });
  const acquirable = Math.max(0, (Array.isArray(lanes) ? lanes.length : Number(lanes)) || 0);
  const dispatchable = reviews.slice(0, Math.min(reviews.length, acquirable));
  const deferredForLanes = paused ? 0 : reviews.length - dispatchable.length;
  const deferredForAuth = paused ? reviews.length - dispatchable.length : 0;
  if (poolExhaustion && !paused) {
    try {
      if (acquirable === 0 && deferredForLanes > 0) poolExhaustion.exhausted({ repo, lanePoolRepo: poolExhaustionLanePoolRepo(repo), deferred: deferredForLanes });
      else if (acquirable > 0) poolExhaustion.recovered(repo);
    } catch { /* reporting only — never fails the tick */ }
  }
  const dispatched = [];
  const failed = [];
  for (const row of plan.refusals ?? []) {
    const hold = row.referralHold ?? row.reviewRefusal?.referralHold;
    if (!hold) continue;
    try {
      notifyReferral({ repo, prNumber: row.prNumber, hold,
        comments: (rawPrs ?? []).find(p => Number(p.number) === row.prNumber)?.comments ?? [] });
    } catch (e) {
      failed.push({ prNumber: row.prNumber, error: `pause notice: ${String(e.message ?? e).split('\n')[0]}` });
    }
  }
  // x26lw6u — NOT named `skipped`: `withSelfSync` already returns `{skipped: true}` for a whole skipped tick,
  // and `onTick` reads both shapes.
  const notStarted = [];
  for (const [i, d] of dispatchable.entries()) {
    try {
      const subject = (Array.isArray(rawPrs) ? rawPrs : []).find(p => Number(p?.number) === Number(d.prNumber));
      const result = dispatch({ pr: d.prNumber, repo,
        ...(Array.isArray(lanes) ? { preferLane: lanes[i] } : {}),
        escalationReason: parseEscalationReason(subject?.body ?? ''),
        scopePaths: (subject?.files ?? []).map(f => typeof f === 'string' ? f : f.path),
      });
      // x26lw6u — a job dispatch that declined to start (a live job already on this PR, or the lane cool-off)
      // did not advance the round, so it gets no round tag — same rule as a failed dispatch.
      if (result?.skipped) { notStarted.push({ prNumber: d.prNumber, reason: result.skipped }); continue; }
      dispatched.push({
        prNumber: d.prNumber, agentId: result?.agentId ?? null,
        ...(result?.mode ? { mode: result.mode } : {}), ...(Number.isInteger(result?.jobPid) ? { jobPid: result.jobPid } : {}),
      });
    } catch (e) {
      failed.push({ prNumber: d.prNumber, error: String((e && e.message) || e).split('\n')[0] });
      continue; // no round tag on a failed dispatch — the round did not actually advance
    }
    try { tagRound({ pr: d.prNumber, repo, round: (d.attempts ?? 0) + 1, currentLabels: labelsByPr.get(Number(d.prNumber)) }); }
    catch { /* cosmetic — a failed tag never fails the tick, see review-round-tag.mjs's own header */ }
  }
  // A PR dispatched THIS tick is absent from the pre-dispatch `rawAgents` snapshot, yet its review job record
  // already exists (`dispatchReviewJob` writes it before returning) — reusing the snapshot would tag it "nothing
  // live" and strip its `review-status:reviewing` until the next tick. Those PRs read fresh (`undefined`).
  const dispatchedThisTick = new Set(dispatched.map((d) => Number(d.prNumber)));
  for (const c of statusCandidates(reviews, plan.refusals ?? [], fixes, ciHeals)) {
    const agents = dispatchedThisTick.has(Number(c.prNumber)) ? undefined : (rawAgents ?? undefined);
    try {
      tagStatus({
        pr: c.prNumber, repo, agents, prState: (rawPrs ?? []).find(p => Number(p.number) === Number(c.prNumber)), currentLabels: labelsByPr.get(Number(c.prNumber)),
        isDraft: isDraftByPr.get(Number(c.prNumber)), mergeConflicted: mergeConflictedByPr.get(Number(c.prNumber)),
      });
    }
    catch { /* cosmetic — see review-status-tag.mjs's own header */ }
  }
  return {
    reviewsOwed: reviews.length, dispatched, failed, notStarted, refusals: (plan.refusals ?? []).length,
    pendingNotDispatched: explainPendingNotDispatched({
      prs: rawPrs, plan, dispatchable, deferredForLanes: reviews.slice(dispatchable.length), paused,
    }),
    reconcileError: null, deferredForLanes, deferredForAuth,
    authPaused: paused, authPauseReason: paused ? pauseReason : null,
    holdReconcile: holdReconcileResults, holdReconcileError,
    // #3383 follow-up (live-caught 2026-09-26) — the PR numbers THIS tick's own reconcile refused
    // `live-process` (`we:scripts/conveyor/reconcile-core.mjs#assessLiveness`: "a bound session has a LIVE
    // pid — something is already working this PR, however stale its transcript looks"). Fed into the NEXT
    // tick's own session-reap pass as `priorityNames` (see `buildCliDaemonEffects`'s `tickOnce`, below) so a
    // budget-bounded reap spends its limited stops on the sessions actually STARVING a PR's own dispatch
    // first — reaping one promptly is what frees that PR for the tick right after, instead of it sitting
    // behind an unrelated backlog of hundreds of already-finished, lower-stakes sessions.
    liveProcessPrs: (plan.refusals ?? []).filter((r) => r?.kind === 'live-process').map((r) => r.prNumber),
  };
}

/** The repos this daemon watches each tick. Today: the three constellation repos (WE-only was the ratified
 *  scope at build time — see the file header — but plateau-app PR #167 sat `review:pending` with nothing
 *  watching it, live-caught 2026-09-22, #xvyuwtg). Kept as a plain exported list, not inlined into the loop
 *  below, so a future per-user configurable repo list (plateau as a product letting an operator choose which
 *  repos to integrate) is a source swap here, not a redesign of {@link runReviewTickAllRepos}. */
export const REVIEW_DAEMON_REPOS = Object.values(CONSTELLATION_REPOS).map((r) => r.slug);

/**
 * App auth for this daemon is PER-OWNER: it sweeps every constellation repo in one process, and each org has its
 * own App installation. Pinning ONE installation's token in GH_TOKEN (the old default) made every call to a repo
 * outside that org fail with GraphQL "Could not resolve to a Repository" — live 2026-10-04, plateauapp/plateau-app
 * #202 skipped every pass as `review-ci: unreadable-ci` while its CI was green. Per-owner leaves GH_TOKEN unset and
 * routes `gh` through the shim, which picks each call's token by the target repo's owner (as the drain does).
 */
export const REVIEW_DAEMON_APP_AUTH_OPTS = FLEET_APP_AUTH_OPTS;

/**
 * Run {@link runReviewTick} once per watched repo, isolating one repo's failure from the rest — a plateau-app
 * `gh` outage (or a rate limit, or a repo with zero open PRs) must never stop WE's own reviews from being
 * dispatched, the same "one bad entry never aborts the rest" discipline `runReviewTick` already applies
 * per-PR, one level up. Every downstream step this daemon already calls (`reconcile-pass.mjs`,
 * `review-dispatch.mjs`, both tag scripts) was already fully repo-generic before this — the daemon's own tick
 * was the only WE-hardcoded link (see `runReviewTick`'s own `repo` fix above, filed the same day this was).
 * @param {{repos?:string[], tick?:Function, authGateOverride?:Function}} [o] - `tick` is injectable (defaults to
 *   `runReviewTick`); every other option is forwarded to it for EVERY repo except `repo` itself, which this
 *   loop supplies per-iteration. `authGateOverride` (card x5kagse) is a test-only injection point for
 *   {@link planClaudeAuthDispatchGate}'s own real IO decision — see the block below for when the real one runs.
 * @returns {{repos:Array<{repo:string, result?:object, error?:string}>, reviewsOwed:number,
 *   dispatched:Array<object>, failed:Array<object>, refusals:number, reconcileFailed:Array<{repo:string, error:string}>,
 *   deferredForLanes:number, deferredForAuth:number, authPaused:boolean, authPauseReason:(string|null),
 *   holdReconcile:Array<{num:number, remove?:string[], healed?:string[], commentPosted?:boolean,
 *     flagged?:string[], flagReason?:string, error?:string, fetchError?:string, repo:string}>,
 *   holdReconcileFailed:Array<{repo:string, error:string}>}}
 */
export function runReviewTickAllRepos({ repos = REVIEW_DAEMON_REPOS, tick = runReviewTick, authGateOverride, ...tickOpts } = {}) {
  // card x5kagse (epic #4075/#3383) — computed ONCE per tick (the login is a host-global fact, not per-repo),
  // then forwarded into every repo's own `runReviewTick` call below. Real IO runs only for a genuine production
  // tick (`tick` left at its real default) — mirrors `runTickAllRepos`'s own identical rule in
  // `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs`: a test that injects a fake `tick` never wants
  // this file to shell out for a gate decision it did not ask about, unless it explicitly injects
  // `authGateOverride` to test the gate itself.
  const authGate = authGateOverride ? authGateOverride()
    : (tick === runReviewTick ? planClaudeAuthDispatchGate() : { paused: false, reason: null });
  const perRepo = forEachRepo(repos, (repo) => tick({
    ...tickOpts, repo, paused: authGate.paused, pauseReason: authGate.reason,
  }));
  const dispatched = [];
  const failed = [];
  const notStarted = [];
  const pendingNotDispatched = [];
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
  let deferredForAuth = 0;
  const liveProcessPrs = [];
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
    deferredForAuth += result.deferredForAuth ?? 0;
    for (const d of result.dispatched) dispatched.push({ ...d, repo });
    for (const k of (result.notStarted ?? [])) notStarted.push({ ...k, repo });
    for (const p of (result.pendingNotDispatched ?? [])) pendingNotDispatched.push({ ...p, repo });
    for (const f of result.failed) failed.push({ ...f, repo });
    for (const prNumber of (result.liveProcessPrs ?? [])) liveProcessPrs.push({ repo, prNumber });
  }
  return {
    repos: perRepo, reviewsOwed, dispatched, failed, notStarted, pendingNotDispatched, refusals, reconcileFailed, deferredForLanes,
    deferredForAuth, authPaused: authGate.paused, authPauseReason: authGate.reason,
    holdReconcile: holdReconcileRemoved, holdReconcileFailed,
    liveProcessPrs, // #3383 follow-up — see `runReviewTick`'s own field for the why; consumed by `buildCliDaemonEffects`
  };
}

/**
 * #xconv1 (web-everything/web-everything#2766/#2767 unblock) — ONE repo's worth of `kind:'convert-advisory'`
 * dispatch entries, posted mechanically. A SEPARATE, ADDITIVE stage from {@link runReviewTick}: a
 * convert-advisory entry needs no lane and no session (see `convert-advisory-dispatch.mjs`'s own header for
 * why the targeted-check judge seat needs neither either), so gating it behind `acquirableLanes` — the cap
 * that exists because a REVIEW session's own `lane-pool.mjs acquire` can starve a pool — would be a wrong,
 * unrelated cap on a population that was never going to touch a lane at all. Async (posting the note + the
 * judge seat are both async IO), which is exactly why this is NOT folded into `runReviewTick` itself: that
 * function stays fully synchronous, unchanged, its return shape pinned byte-for-byte by many pre-existing
 * exact-equality tests.
 *
 * MIRRORS `runReviewTick`'s OWN #4133 shared-reads shape exactly: `readPrs`/`readAgents`, when both supplied,
 * are injected into `reconcile` so its internal fetch is a reuse of data the CALLER (the IO shell) already
 * read once for `runReviewTick` — never a second `gh pr list`. `null` (the default) is unaffected — every
 * pre-existing test of this function that fakes `reconcile` directly never pays for real IO either way.
 * `dryRun` (default `false`, forwarded straight to `convertAdvisory`) — computes and returns the exact plan
 * (comment body, label diff, the REAL targeted-check judge's real answer) for every owed entry with NO `gh`
 * write at all; a production tick never sets it. The one thing it does NOT skip is the judge seat itself —
 * "don't post" means never writing to the PR, not never asking the one narrow question the whole mechanism
 * exists to answer, so a dry-run still shows the ACTUAL content it would post, off a real (bounded-cost)
 * answer, never a placeholder.
 * @param {{reconcile?:Function, convertAdvisory?:Function, repo?:string, readPrs?:(Function|null),
 *   readAgents?:(Function|null), dryRun?:boolean}} [o]
 * @returns {Promise<{convertAdvisoriesOwed:number, posted:Array<{prNumber:number, outcome:(string|null)}>,
 *   skipped:Array<{prNumber:number, reason:string}>, failed:Array<{prNumber:number, error:string}>,
 *   reconcileError:(string|null)}>}
 */
export async function runConvertAdvisoryTick({
  reconcile = runReconcilePass, convertAdvisory = dispatchConvertAdvisory, repo = WE_SLUG,
  readPrs = null, readAgents = null, dryRun = false,
} = {}) {
  const sharedReads = typeof readPrs === 'function' && typeof readAgents === 'function';
  let plan;
  let rawPrs = null;
  try {
    if (sharedReads) {
      rawPrs = readPrs({ repo });
      const rawAgents = readAgents({});
      plan = reconcile({ repo, readPrs: () => rawPrs, readAgents: () => rawAgents });
    } else {
      plan = reconcile({ repo });
    }
  } catch (e) {
    return {
      convertAdvisoriesOwed: 0, posted: [], skipped: [], failed: [],
      reconcileError: String((e && e.message) || e).split('\n')[0],
    };
  }
  // Keyed by PR number so a fresh `gh` read is never needed when the tick already has this PR's comments/
  // labels in hand (the SAME shared-read reuse `tagRound`/`tagStatus` already get in `runReviewTick`).
  const prsByNumber = new Map((Array.isArray(rawPrs) ? rawPrs : []).map((p) => [Number(p?.number), p]));
  const entries = (plan.dispatch ?? []).filter((d) => d && d.kind === 'convert-advisory');
  const posted = [];
  const skipped = [];
  const failed = [];
  for (const d of entries) {
    // One bad entry never aborts the rest — the SAME per-PR isolation `runReviewTick`'s own dispatch loop uses.
    try {
      const pr = prsByNumber.get(Number(d.prNumber));
      const result = await convertAdvisory(d, {
        repo, comments: pr?.comments ?? null, labels: pr?.labels ?? null, dryRun,
      });
      if (result?.skipped) {
        // PR #2781 review — a label repair on an already-converted head IS a write; surface it, never hide it
        // under a bare `skipped`.
        skipped.push({
          prNumber: d.prNumber, reason: result.skipped,
          ...(result.repairedLabels ? { repairedLabels: true } : {}),
          ...(result.wouldRepairLabels ? { wouldRepairLabels: true } : {}),
          ...(result.labelRepairUnverified ? { labelRepairUnverified: true } : {}),
        });
      }
      else {
        posted.push({
          prNumber: d.prNumber, outcome: result?.targetedCheckAnswer?.verdict ?? null,
          // dryRun carries the FULL plan (what it WOULD post) — a production tick never reads these three,
          // so they are simply absent (never `undefined`-valued keys) rather than always-present-but-null.
          ...(dryRun ? { body: result?.body, addLabel: result?.addLabel, removeLabels: result?.removeLabels } : {}),
        });
      }
    } catch (e) {
      failed.push({ prNumber: d.prNumber, error: String((e && e.message) || e).split('\n')[0] });
    }
  }
  return { convertAdvisoriesOwed: entries.length, posted, skipped, failed, reconcileError: null };
}

/**
 * {@link runConvertAdvisoryTick}, once per watched repo — the SAME per-repo isolation
 * {@link runReviewTickAllRepos} gives `runReviewTick` (a plateau-app outage must never stop WE's own converts),
 * just its own tiny async loop rather than a reuse of `forEachRepo` (that helper is deliberately synchronous —
 * `fn(repo)`'s return value is captured inline, so an async `fn`'s REJECTION would surface after the loop's own
 * try/catch already returned, as an unhandled rejection rather than a captured `{repo, error}` entry).
 * @param {{repos?:string[], tick?:Function}} [o] - every other option forwards to `tick` for every repo.
 * @returns {Promise<{repos:Array<{repo:string, result?:object, error?:string}>, convertAdvisoriesOwed:number,
 *   posted:Array<object>, skipped:Array<object>, failed:Array<object>, reconcileFailed:Array<{repo:string, error:string}>}>}
 */
export async function runConvertAdvisoryTickAllRepos({
  repos = REVIEW_DAEMON_REPOS, tick = runConvertAdvisoryTick, ...tickOpts
} = {}) {
  const perRepo = [];
  for (const repo of repos) {
    try {
      perRepo.push({ repo, result: await tick({ ...tickOpts, repo }) });
    } catch (e) {
      perRepo.push({ repo, error: String((e && e.message) || e).split('\n')[0] });
    }
  }
  let convertAdvisoriesOwed = 0;
  const posted = [];
  const skipped = [];
  const failed = [];
  const reconcileFailed = [];
  for (const entry of perRepo) {
    if (entry.error) { failed.push({ prNumber: null, repo: entry.repo, error: entry.error }); continue; }
    const { repo, result } = entry;
    if (result?.reconcileError) { reconcileFailed.push({ repo, error: result.reconcileError }); continue; }
    convertAdvisoriesOwed += result.convertAdvisoriesOwed ?? 0;
    for (const p of (result.posted ?? [])) posted.push({ ...p, repo });
    for (const s of (result.skipped ?? [])) skipped.push({ ...s, repo });
    for (const f of (result.failed ?? [])) failed.push({ ...f, repo });
  }
  return { repos: perRepo, convertAdvisoriesOwed, posted, skipped, failed, reconcileFailed };
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
  return defaultAcquirableLaneNumbers({ repo }).length;
}

/** Preserve the tick's fresh scan so sibling jobs acquire distinct lanes without scanning again. */
export function defaultAcquirableLaneNumbers({ repo }) {
  return freeLaneNumbers({ lanePoolRepo: repoProfile(repo).lanePoolRepo });
}

/** The lane-pool repo path for `repo` (the same derivation {@link defaultAcquirableLaneCount} uses). */
function poolExhaustionLanePoolRepo(repo) {
  try { return repoProfile(repo).lanePoolRepo ?? null; } catch { return null; }
}

/** One logger per daemon process — its once-per-episode memory must survive across ticks. */
const DAEMON_POOL_EXHAUSTION = makePoolExhaustionLogger({ log: (line) => console.error(`review-daemon: ${line}`) });

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
/**
 * @param {{priorityNames?:Set<string>|null}} [o] - #3383 follow-up: forwarded straight through to
 *   {@link runSessionReaperPass}'s own `priorityNames` (its `maxStops`/`maxDurationMs` budget stays at THAT
 *   function's own env-resolved defaults — see its own doc — so this daemon is bounded with no extra wiring
 *   here). `null`/omitted (every pre-existing caller) reaps in the plan's own existing order, unchanged.
 */
export function defaultReapSessions({ priorityNames = null } = {}) {
  return runSessionReaperPass({
    allowedCwd: SESSION_REAPER_REPO_ROOT,
    neverReapWorking: true,
    idleThresholdMs: DEFAULT_IDLE_REAP_THRESHOLD_MS,
    reapedLedger: makeReapedLedger(),
    priorityNames,
    // #ghost-sessions-inflate-cap — explicitly wired ON here: `runSessionReaperPass`'s own bare default is
    // OFF (see that function's own docblock for why), so the real production reap this daemon owns must ask
    // for it by name, the same way `retention-sweep`/`dispatch-scratch-sweep` are opt-in at their own call
    // sites rather than silently inherited. This is what actually reaps a `conveyor-NNNN` (or `review-*`/
    // `fix-*`) session whose process is confirmed gone, regardless of which checkout dispatched it — the live
    // incident: 18 such sessions, `state:'working'`, 20-26 days old, none reaped because `allowedCwd` above
    // (this daemon's own checkout) short-circuited every other axis for every one of them.
    pidDeadFor: makePidDeadResolver(),
  });
}

/**
 * PURE: the session names worth reaping FIRST this tick, given the LAST tick's own `liveProcessPrs` (a PR
 * `reconcile-core.mjs#assessLiveness` refused `live-process` for — see `runReviewTick`'s own field doc). A
 * blocking session's ROLE (review/fix/ci-heal) is not recorded on that refusal, so all three of a PR's
 * possible session names are minted and included — harmless when one doesn't exist (the reap plan simply
 * never matches it), and correct whichever role the actual blocker turns out to be.
 * @param {Array<{repo:string, prNumber:number}>} liveProcessPrs
 * @returns {Set<string>}
 */
export function priorityNamesForLiveProcessPrs(liveProcessPrs) {
  const names = new Set();
  for (const { repo, prNumber } of (Array.isArray(liveProcessPrs) ? liveProcessPrs : [])) {
    // `mintSessionSlug` takes the repo KEY ('we'/'plateau-app'/'frontierui'), never the full `owner/name`
    // slug this daemon otherwise threads around (`REVIEW_DAEMON_REPOS`/`result.repo` are slugs) — same
    // slug→key translation `we:scripts/conveyor/review-status-tag.mjs#tagReviewStatus` already does before
    // its own `deriveReviewStatus` call.
    const repoKey = repoKeyForSlug(repo);
    if (repoKey === null) continue;
    for (const kind of ['review', 'fix', 'ci-heal']) {
      try { names.add(mintSessionSlug({ kind, id: prNumber, repo: repoKey })); } catch { /* an unresolvable id mints nothing — skip it, never guess */ }
    }
  }
  return names;
}

export function buildCliDaemonEffects({
  owner, intervalMs = DEFAULT_INTERVAL_MS, log = console,
  reapSessions = defaultReapSessions,
  // #3383 bug 3 — the real daemon wires the real `acquirableLanes` effect through by default, so production
  // dispatch is bounded by lane reality; `runReviewTick`'s OWN default stays unbounded (`() => Infinity`) so
  // every pre-existing test of it (which fakes reconcile/dispatch directly, never this) is unaffected.
  // #4133 — likewise, the real daemon opts INTO the shared-reads optimization by wiring the real
  // `defaultReadPrs`/`defaultReadAgents` through; `runReviewTick`'s own default stays `null` (see that
  // function's own doc for why) so every pre-existing test of it is unaffected here too.
  runReview = (opts) => runReviewTickAllRepos({
    acquirableLanes: defaultAcquirableLaneNumbers, readPrs: defaultReadPrs, readAgents: defaultReadAgents,
    poolExhaustion: DAEMON_POOL_EXHAUSTION, ...opts,
  }),
  // #xconv1 — the SAME shared-reads optimization `runReview` above opts into, wired the same way for its own
  // separate, additive async stage (see `runConvertAdvisoryTick`'s own doc for why this is not folded into
  // `runReview`/`runReviewTick`).
  runConvertAdvisories = (opts) => runConvertAdvisoryTickAllRepos({
    readPrs: defaultReadPrs, readAgents: defaultReadAgents, ...opts,
  }),
  // PR #2781 review — OPT-IN, OFF BY DEFAULT for its first landing. The stage posts real comments, applies real
  // `advisory:*` labels and spawns a billed judge on trust-sensitive escalations, so it only runs when the
  // operator sets REVIEW_DAEMON_CONVERT_ADVISORY=1 on the daemon — flipped on deliberately once live behavior
  // has been watched (e.g. via `convert-advisory-dispatch.mjs <pr> --dry-run`), never by merely shipping this.
  convertAdvisoryEnabled = process.env.REVIEW_DAEMON_CONVERT_ADVISORY === '1',
} = {}) {
  // #3383 follow-up (live-caught 2026-09-26) — carries the LAST tick's own `liveProcessPrs` across the
  // `await`/closure boundary into the NEXT tick's `reapSessions()` call, below. A plain closure variable is
  // correct here (never a race): `runDaemonLoop` awaits ONE `tickOnce()` to completion before ever calling it
  // again — see that function's own `for (;;) { await tickOnce(); ... }` shape — so there is never a second,
  // concurrent tick reading or writing this while one is in flight.
  let priorityNames = new Set();
  return {
    intervalMs,
    tickOnce: async () => {
      // Live-caught 2026-09-26: the reap runs BEFORE discovery, not after. A hung fix/ci-heal session bound to a
      // `review:pending` PR makes reconcile refuse it (`live-process`); reaping it first lets THIS tick's
      // discovery see the PR free, instead of the next tick — which, while the reaper re-stopped ~1,500 finished
      // sessions every pass, was ~20 minutes later (see `session-reaper.mjs#makeReapedLedger`).
      //
      // #3383 follow-up, SAME incident — an UNBOUNDED reap running first is worse than one running last: it
      // blocked discovery+dispatch and status tagging for the reap's ENTIRE duration, every tick, not merely
      // the next one. `reapSessions` (real default: {@link defaultReapSessions}) is now BUDGETED (see
      // `session-reaper.mjs#DEFAULT_REAP_MAX_STOPS_PER_PASS`/`DEFAULT_REAP_MAX_DURATION_MS`) so this call
      // always returns quickly; `priorityNames` — this closure's own memory of the LAST tick's
      // `live-process`-blocked PRs — makes a budget-bounded pass spend its limited stops on exactly the
      // sessions worth clearing first, so the "reap first, so a freed PR is picked up THIS tick" intent above
      // still mostly holds even when the full backlog can't fit in one budget.
      //
      // Best-effort, mirrors `runner.mjs`'s own `makeCliMechanicalPasses` discipline: a session-reap failure
      // is logged and swallowed, never lets a lingering `claude` process take down this tick's real job
      // (dispatching/tagging reviews).
      let sessionReap = null;
      try {
        sessionReap = reapSessions({ priorityNames });
      } catch (e) {
        log.error(`review-daemon: session-reap failed (non-fatal): ${String((e && e.message) || e).split('\n')[0]}`);
      }
      const result = await runReview();
      // Refreshed for the NEXT tick's own reap call, above — always recomputed from THIS tick's fresh
      // discovery, never accumulated, so a PR that frees up (or a new one that blocks) is reflected within
      // one 120s cycle either way.
      priorityNames = priorityNamesForLiveProcessPrs(result?.liveProcessPrs);
      // #xconv1 — its OWN best-effort try/catch, mirroring the session-reap discipline immediately above: a
      // convert-advisory failure (a `gh`/judge hiccup) must never take down the tick's real job (dispatching/
      // tagging reviews), which has already completed by the time this runs.
      let convertAdvisory = null;
      if (convertAdvisoryEnabled) {
        try {
          convertAdvisory = await runConvertAdvisories();
        } catch (e) {
          log.error(`review-daemon: convert-advisory tick failed (non-fatal): ${String((e && e.message) || e).split('\n')[0]}`);
        }
      }
      return { ...result, sessionReap, convertAdvisory };
    },
    sleep: realSleep,
    heartbeat: () => heartbeatRunnerLease(RUNNER_LOCK_ROOT, owner, { key: REVIEW_DAEMON_LEASE_KEY }),
    onTick: (result) => {
      // A `withSelfSync`-skipped tick (`skippedTick`: `repos: []`) used to print as "tick () — 0 owed", which read
      // like discovery had watched NO repo. Say what actually happened.
      if (result?.skipped) { log.error(`review-daemon: tick skipped (${result.reason ?? 'unknown'}) — no repo was read this tick`); return; }
      log.error(`review-daemon: tick (${result.repos.map((r) => r.repo).join(', ')}) — ${result.reviewsOwed} owed, dispatched ${result.dispatched.length}, failed ${result.failed.length}${result.deferredForLanes ? `, deferred ${result.deferredForLanes} (no acquirable lane this tick, #3383)` : ''}`);
      // card x5kagse (epic #4075/#3383) — logged EVERY tick review dispatch stays paused, exact wording
      // required by the card and matched by the soak scenario/live-proof read.
      if (result.authPaused) log.error(`review-daemon: ${result.authPauseReason ?? 'paused: Claude login expired — run /login'}`);
      for (const k of (Array.isArray(result.notStarted) ? result.notStarted : [])) log.error(`review-daemon: ${k.repo}#${k.prNumber} not dispatched — ${k.reason}`);
      for (const d of (Array.isArray(result.dispatched) ? result.dispatched : [])) log.error(`review-daemon: ${d.repo}#${d.prNumber} dispatched as ${d.mode ?? 'session'}${d.jobPid ? ` (job pid ${d.jobPid})` : ''}${d.agentId ? ` (agent ${d.agentId})` : ''}`);
      for (const p of (Array.isArray(result.pendingNotDispatched) ? result.pendingNotDispatched : [])) log.error(`review-daemon: ${p.repo}#${p.prNumber} ${(p.labels ?? []).join('+') || 'held'}, no review dispatched — ${p.reasons.join('; ')}`);
      for (const f of result.failed) log.error(`review-daemon: ${f.repo}#${f.prNumber ?? '?'} failed (non-fatal): ${f.error}`);
      // #xvzwiew — a reconcile-phase failure (discovery itself, e.g. a transient `claude agents --json`
      // ENOENT) reports here ONLY, never also folded into the `failed` (dispatch) line above — see
      // `runReviewTickAllRepos`'s own header for why the old double, contradictory report was a bug.
      for (const rf of (result.reconcileFailed ?? [])) log.error(`review-daemon: ${rf.repo} reconcile failed (non-fatal, other repos unaffected): ${rf.error}`);
      for (const r of result.repos) if (r.error) log.error(`review-daemon: ${r.repo} tick failed unexpectedly (non-fatal, other repos unaffected): ${r.error}`);
      // #x01u7az — the review-hold reconcile sweep's own findings: a stray review:pending beside a live
      // review:human, a stray advisory:* once review:human is cleared (#2549, #2578), or — #2766/#2767 —
      // an EXISTING contradictory review:accepted + review:human pair, either HEALED (comment posted,
      // review:accepted removed) or FLAGGED (comment history proved a genuine clearance, or the fetch failed).
      // `h.remove`/`h.healed`/`h.flagged` are INDEPENDENT optional fields on one entry (see
      // `sweepReviewHoldLabels`'s own return doc) — never assume any one of them is present.
      for (const h of (result.holdReconcile ?? [])) {
        if (h.remove?.length) log.error(`review-daemon: ${h.repo}#${h.num} hold-reconcile removed ${h.remove.join(',')}${h.error ? ` (FAILED: ${h.error})` : ''}`);
        if (h.healed?.length) log.error(`review-daemon: ${h.repo}#${h.num} hold-reconcile HEALED — removed ${h.healed.join(',')}${h.commentPosted ? ', comment posted' : ''}${h.error ? ` (FAILED: ${h.error})` : ''}`);
        if (h.flagged?.length) log.error(`review-daemon: ${h.repo}#${h.num} hold-reconcile FLAGGED contradictory ${h.flagged.join(',')} — not auto-resolved (${h.flagReason || 'unresolved'}${h.fetchError ? `, fetch error: ${h.fetchError}` : ''})`);
      }
      for (const hf of (result.holdReconcileFailed ?? [])) log.error(`review-daemon: ${hf.repo} hold-reconcile failed (non-fatal, other repos unaffected): ${hf.error}`);
      if (result.sessionReap && !result.sessionReap.unreadable) {
        const sr = result.sessionReap;
        log.error(`review-daemon: session-reap — ${sr.scanned} scanned, ${sr.stopped} stopped${sr.alreadyGone ? `, ${sr.alreadyGone} already gone` : ''}${sr.failures ? `, ${sr.failures} failed` : ''}${sr.anomalies ? `, ${sr.anomalies} anomalies` : ''}${sr.previouslyReaped ? `, ${sr.previouslyReaped} already reaped earlier (skipped)` : ''}, ${sr.kept} kept${sr.deferred ? `, ${sr.deferred} deferred to next tick (reap budget: ${sr.reapBudget?.maxStops} stops / ${sr.reapBudget?.maxDurationMs}ms, #3383)` : ''}`);
      }
      // #xconv1 (web-everything/web-everything#2766/#2767 unblock) — the mechanical, no-session convert-advisory
      // stage's own report: `posted` names the targeted check's own verdict, `skipped` is the idempotency
      // no-op (a head already carrying the converted note), `failed`/`reconcileFailed` mirror the review
      // stage's own non-fatal reporting one level up.
      const ca = result.convertAdvisory;
      if (ca) {
        for (const p of (ca.posted ?? [])) log.error(`review-daemon: ${p.repo}#${p.prNumber} convert-advisory posted (targeted check: ${p.outcome ?? '?'})`);
        for (const s of (ca.skipped ?? [])) log.error(`review-daemon: ${s.repo}#${s.prNumber} convert-advisory skipped — ${s.reason}${s.repairedLabels ? ' (labels repaired from the recorded outcome)' : ''}${s.labelRepairUnverified ? ' (advisory label disagrees with the recorded outcome, and the label timeline could not be read to tell a lost write from an override — not repaired)' : ''}`);
        for (const f of (ca.failed ?? [])) log.error(`review-daemon: ${f.repo}#${f.prNumber ?? '?'} convert-advisory failed (non-fatal): ${f.error}`);
        for (const rf of (ca.reconcileFailed ?? [])) log.error(`review-daemon: ${rf.repo} convert-advisory reconcile failed (non-fatal, other repos unaffected): ${rf.error}`);
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
  // Webhook-driven wake (flag WE_PR_EVENTS, default OFF → effects unchanged): a relevant PR event ends the sleep
  // early; the interval stays as the safety net. This daemon also forwards drain-relevant events to the drain
  // daemon's localhost POST /nudge — one forwarder, so the drain wakes on events without its own feed client.
  const { stoppedReason } = await runDaemonLoop(
    withPrEvents(withSelfSync(withGithubAppAuth(buildCliDaemonEffects({ owner }), REVIEW_DAEMON_APP_AUTH_OPTS), {
      root: selfRoot, onRestart: restartOntoNewCode, hasStaleRefusal: hasStaleMainRefusal,
    }), { role: 'review', repos: REVIEW_DAEMON_REPOS, forward: [makeDrainNudgeForward()] }),
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
