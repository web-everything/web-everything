#!/usr/bin/env node
import { readMainFixPriority } from '../../scripts/lib/merge-queue-hook.mjs';
import { repoKeyFromSlug } from '../../scripts/readiness/lane-manifest.mjs';
import { redTeamEnabled } from '../../scripts/lib/review-red-team-policy.mjs';
import { readDrainRedTeamRequests, finishDrainRedTeamRequest } from '../../scripts/lib/drain-red-team-requests.mjs';
import { withReviewFetchTick } from '../../scripts/lib/review-fetch.mjs';
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

import { readReviewEvidenceAtHead } from '../../scripts/lib/review-evidence-at-head.mjs';
import { readRedTeamTiming } from '../../scripts/lib/red-team-gate.mjs';
import { readFileSync, statSync } from 'node:fs';
import { cascadePolicy } from '../../scripts/lib/policy-cascade.mjs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { execFileSyncThrottled } from '../../scripts/lib/gh-throttle.mjs';
import { hostname } from 'node:os';
import { spawnLedgerOutboxBackstop } from '../../scripts/lib/verdict-ledger-outbox.mjs';
import { runReconcilePass, defaultReadPrs, defaultReadAgents, isConflictingPr } from '../../scripts/conveyor/reconcile-pass.mjs';
import { promoteDraftsThenReplan, promoteDraftsGuarded, rearmStaleAcceptanceGuarded, rearmStaleAcceptsThenReplan } from '../../scripts/conveyor/review-tick-promote.mjs'; // card xemxk3h
import { notifyReferralHold, referralHoldSendBackBody, REFERRAL_HOLD_AUTO_RESOLVED } from '../../scripts/conveyor/review-referral-hold.mjs';
import { AUTO_POLICY_ACTOR } from '../../scripts/lib/jury-core.mjs';
// card x29vm8a — a scope-bloated PR (stale base) is refreshed onto main through the SAME mechanical path the ci-red
// recovery watch uses, once per head, before any review reads its diff.
import { refreshOntoMain, defaultPostRebaseComment } from '../../scripts/conveyor/ci-red-recovery-watch.mjs';
import { recordScopeBloatRefresh, noteScopeBloatMarkerFailure } from '../../scripts/conveyor/scope-bloat.mjs';
// x26lw6u — the review is dispatched as a deterministic JOB (`review-job.mjs`: acquire → review-loop-cli →
// report → release, no Claude wrapper session); `WE_REVIEW_DISPATCH_MODE=session` keeps the old `claude --bg`
// path reachable. The jurors review-loop-cli spawns are the fresh, independent reviewers either way.
import { parseEscalationReason } from '../../scripts/review-detail.mjs';
import { dispatchReviewJob, dispatchReviewByMode } from '../../scripts/operations/review-job.mjs';
import { runRedTeamOnSkip } from '../../scripts/lib/review-red-team-on-skip.mjs';
import { hostLoadAdmission } from '../../scripts/lib/host-load.mjs';
import { loadHostOverloadSettings } from '../../scripts/lib/host-overload-settings.mjs';
import { tagReviewRound } from '../../scripts/conveyor/review-round-tag.mjs';
import { tagReviewStatus } from '../../scripts/conveyor/review-status-tag.mjs';
import { PR_STATUS_LABEL_RE } from '../../scripts/conveyor/pr-status-label.mjs';
// #x01u7az — the review-hold reconcile sweep (a stray review:pending beside a live review:human; a stray
// advisory:* once review:human is cleared) lives here, not only in we:skills-src/conveyor/runner.mjs's own
// `makeCliMechanicalPasses` (see that file's header: it is NOT itself running — replaced by this daemon and
// the Fix-dispatch daemon). This daemon owns review labels end to end and already self-updates
// (`withSelfSync`) and self-heals (`withGithubAppAuth`, the per-repo isolation below) with NO launchd install
// beyond the one this daemon already has, so wiring it here is the one change that actually reaches the live
// PRs — landing it in `runner.mjs` alone would leave #2549/#2578's stray labels uncleaned indefinitely, the
// exact gap this wiring closes.
import { sweepReviewHoldLabels } from '../../scripts/conveyor/review-hold-reconcile.mjs';
import { sweepHumanSurfaceRepark } from '../../scripts/conveyor/human-surface-repark.mjs';
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
import { installDaemonLog } from './daemon-log.mjs';
import { describeDispatchFailure } from '../../scripts/lib/describe-spawn-failure.mjs';
import { warmReviewFacts, readReviewCiGateFactsFirst, withFactsLabels } from '../../scripts/lib/review-facts.mjs';
import { createGhProvider } from '../../scripts/lib/review-label-provider.mjs';
import { runPrepReviewTick, resolvePrepReviewMode } from '../../scripts/conveyor/prep-review.mjs';
import { makePrepReviewDeps } from '../../scripts/conveyor/prep-review-io.mjs';

/** This daemon's own lease key — distinct from the Dispatcher's default sentinel, #3870's Fix-dispatch key,
 *  and any future daemon's own key (#3877). */
export const REVIEW_DAEMON_LEASE_KEY = '<conveyor:review-daemon-lease>';

/** Matches runner.mjs's own tick cadence — this sequence ran at that rate as one of its mechanical passes. */
export const DEFAULT_INTERVAL_MS = 120_000;
export const MIN_INTERVAL_MS = 10_000;
/** Node's setTimeout treats any delay above 2**31-1 ms (~24.8 days) as 1 ms, which would turn a "tick rarely"
 *  setting into back-to-back passes — so valid intervals are clamped to this ceiling. */
export const MAX_INTERVAL_MS = 2 ** 31 - 1;

/** #5136 — `--interval-ms` overrides `WE_REVIEW_DAEMON_INTERVAL_MS`, then the default cadence.
 *  Invalid values fall through to the next source; valid intervals are clamped to [10 s, 2**31-1 ms]. */
export function resolveReviewIntervalMs({ env = process.env, argv = process.argv.slice(2) } = {}) {
  const flagIndex = argv.findIndex((arg) => arg === '--interval-ms' || arg.startsWith('--interval-ms='));
  const flagValue = flagIndex < 0 ? undefined : argv[flagIndex] === '--interval-ms'
    ? argv[flagIndex + 1] : argv[flagIndex].slice('--interval-ms='.length);
  for (const value of [flagValue, env.WE_REVIEW_DAEMON_INTERVAL_MS]) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, n));
  }
  return DEFAULT_INTERVAL_MS;
}

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
 *  independent review, `review-escalation.mjs`), `ci:failed` (a required check is red — owed a ci-heal) and
 *  `review:human` (a human gate; its refusal reason is the only trace of why no advisory is coming). */
export const EXPLAINED_HOLD_LABELS = ['review:pending', 'ci:failed', 'review:human'];
/** The four hold kinds that wait on a person. The health watch ages them (`operator-hold-aged`). */
export const OPERATOR_HOLD_KINDS = Object.freeze(['cap-exhausted', 'stood-down', 'review-referrals-pending', 'ruling-dispute']);

/**
 * Pure: the operator-only holds in a reconcile plan, from top-level refusals and their nested `reviewRefusal`.
 * Only an allowlisted kind and a positive integer PR number are read; one entry per (PR, kind), sorted. Does not
 * look at labels or the human-readable explanation, so omitted referral explanations never hide a hold.
 * @param {{refusals?:Array<object>}} plan
 * @returns {Array<{prNumber:number, kind:string}>}
 */
export function operatorHoldsFromPlan(plan) {
  const seen = new Map();
  for (const row of Array.isArray(plan?.refusals) ? plan.refusals : []) {
    const prNumber = Number(row?.prNumber);
    if (!Number.isInteger(prNumber) || prNumber <= 0) continue;
    for (const refusal of [row, row?.reviewRefusal]) {
      const kind = refusal?.kind;
      if (!OPERATOR_HOLD_KINDS.includes(kind)) continue;
      // A referral persist that failed with retries left is still owned by automation (it resumes on its own at the
      // hold's `retryAt`), so it is not yet waiting on a person; only an exhausted budget is (live #5752).
      const hold = refusal.referralHold;
      if (kind === 'review-referrals-pending' && hold?.persistenceFailed === true && hold.exhausted === false
        && Number.isFinite(hold.retryAt)) continue;
      seen.set(`${prNumber}|${kind}`, { prNumber, kind });
    }
  }
  return [...seen.values()].sort((a, b) => a.prNumber - b.prNumber || a.kind.localeCompare(b.kind));
}

/** Pure: the one-line log record the health watch reads — `review-daemon: operator-holds {json}`. An empty
 *  `holds` list is affirmative clearance evidence for that repository. */
export function formatOperatorHoldsRecord({ repo, observedAt, intervalMs, holds }) {
  return `review-daemon: operator-holds ${JSON.stringify({ version: 1, repo, observedAt, intervalMs, holds })}`;
}

/** `review:human` PRs are explained EVERY tick, including a referral hold (live #4271, 2026-10-07: a ruled PR went
 *  unlogged for hours because its refusal was dropped here and the notice that excuses the silence is posted once). */
const ALWAYS_EXPLAINED_LABEL = 'review:human';

/**
 * The dispatch order for this tick's owed reviews. Pure, stable. Rank 0: a main-fix PR (the plan marks it
 * `mainFix`); rank 1: a PR someone is blocked on (`review:human` or `ready-to-merge`); rank 2: the rest.
 * Within a rank the oldest PR (lowest number) goes first. Only the plan's own review rows move: a red-team
 * request row (`redTeamRequest` / `carriedAcceptHead`) keeps its slot, since the code that adds those rows already
 * places them deliberately (the main-fix PR's red-team first).
 * @param {Array<object>} reviews
 * @param {{labelsByPr?:Map<number, Array<string|{name:string}>>, plan?:{dispatch?:Array<object>}}} [o]
 */
export function orderReviewsForDispatch(reviews, { labelsByPr = new Map(), plan = {} } = {}) {
  const mainFixPrs = new Set((plan?.dispatch ?? []).filter((d) => d?.mainFix).map((d) => Number(d.prNumber)));
  const rank = (d) => {
    const n = Number(d?.prNumber);
    if (d?.mainFix || mainFixPrs.has(n)) return 0;
    const names = (labelsByPr.get(n) ?? []).map((l) => (typeof l === 'string' ? l : l?.name));
    return names.includes('review:human') || names.includes('ready-to-merge') ? 1 : 2;
  };
  const movable = (d) => !d?.redTeamRequest && !d?.carriedAcceptHead;
  const slots = reviews.map((d, i) => (movable(d) ? i : -1)).filter((i) => i >= 0);
  const sorted = slots.map((i) => ({ d: reviews[i], i, r: rank(reviews[i]), n: Number(reviews[i]?.prNumber) }))
    .sort((a, b) => a.r - b.r || (Number.isFinite(a.n) && Number.isFinite(b.n) ? a.n - b.n : 0) || a.i - b.i);
  const out = [...reviews];
  slots.forEach((slot, k) => { out[slot] = sorted[k].d; });
  return out;
}

/**
 * Live-caught 2026-09-26 (WE PRs #2746–#2758 sat `review:pending` for ~an hour while every tick logged only
 * "N owed" — nothing said WHY each parked PR was skipped, so a correct `live-process` refusal (a stale fix /
 * ci-heal session still bound to the PR) looked exactly like a discovery bug). For every open PR carrying
 * `review:pending` that this tick did NOT hand to `dispatch`, return the reason(s) straight from the reconcile
 * plan — never re-derived. Pure. `prs` is the tick's own shared `gh pr list` read; `null` (the opt-out
 * no-shared-reads path) returns `[]`, since there is then no label list to scan.
 * @param {{prs:Array<object>|null, plan:{dispatch?:Array<object>, refusals?:Array<object>}, dispatchable:Array<object>,
 *   deferredForLanes?:Array<object>, paused?:boolean, deferReason?:string}} o
 * @returns {Array<{prNumber:number, labels:string[], reasons:string[]}>}
 */
export function explainPendingNotDispatched({ prs, plan, dispatchable = [], deferredForLanes = [], paused = false, deferReason = null }) {
  if (!Array.isArray(prs)) return [];
  const labelName = (l) => (typeof l === 'string' ? l : l?.name);
  const sent = new Set(dispatchable.map((d) => Number(d.prNumber)));
  const deferred = new Set(deferredForLanes.map((d) => Number(d.prNumber)));
  const out = [];
  for (const pr of prs) {
    const n = Number(pr?.number);
    if (!Number.isInteger(n) || sent.has(n)) continue;
    // Referral holds have one durable notice/log, never one explanation per tick.
    // EXCEPT the same-head pause: it has no notice comment and no other log line, so skipping it left a
    // `review:pending` PR (#4288, 2026-10-07) with no logged reason at all.
    const names = (pr?.labels ?? []).map(labelName);
    // A `review:pending` PR already has its once-per-episode notice; a `review:human` PR without one has nothing.
    const alwaysExplained = names.includes(ALWAYS_EXPLAINED_LABEL) && !names.includes('review:pending');
    if (!alwaysExplained && plan?.refusals?.some(r => r.prNumber === n
      && (r.kind === 'review-referrals-pending' || r.reviewRefusal?.kind === 'review-referrals-pending')
      && (r.referralHold ?? r.reviewRefusal?.referralHold)?.kind !== 'same-head')) continue;
    const held = (pr?.labels ?? []).map(labelName).filter((l) => EXPLAINED_HOLD_LABELS.includes(l));
    if (held.length === 0) continue;
    const reasons = [];
    if (deferred.has(n)) reasons.push(deferReason ?? (paused ? 'review owed, but dispatch is paused (Claude login)' : 'review owed, but no acquirable lane this tick'));
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
 * The one-line `reconcileError` for a reconcile/read throw. A failed `gh` child (execFileSync: `Command failed:
 * <argv>\n<stderr>`) is described CAUSE-FIRST — `gh pr list failed (exit 1): <redacted stderr>` — instead of the
 * message's first line, which is only the argv. Live 2026-10-09 22:43Z-00:00Z: the drain's self-sync smoke was
 * rejected 3x on "Command failed: gh pr list ... --json <16 fields>" and the real gh error never reached a log
 * (the held-state detail is then cut at 300 chars, so the cause has to come before the command). Any other
 * error keeps its first message line. PURE.
 */
export function describeReconcileError(e) {
  const m = /^Command failed:\s+(\S+(?:\s+[a-z][\w-]*){0,2})/.exec(String((e && e.message) || ''));
  return describeDispatchFailure(e, m ? m[1] : 'reconcile read');
}

const REVIEW_TICK_SHARING_STANDARD = Object.freeze({ reusePlan: true, repoConcurrency: 3, phaseTimings: true });

/** Resolve each sharing setting through the policy cascade; malformed overrides keep the lower layer. */
export function resolveReviewTickSharing(env = process.env) {
  const source = { reusePlan: 'standard', repoConcurrency: 'standard', phaseTimings: 'standard' };
  try {
    const bool = (key) => env?.[key] === '1' ? true : env?.[key] === '0' ? false : undefined;
    const value = env?.WE_REVIEW_REPO_CONCURRENCY;
    const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined;
    const r = cascadePolicy('reviewTickSharing', undefined, {
      env, standard: REVIEW_TICK_SHARING_STANDARD,
      envValues: { reusePlan: bool('WE_REVIEW_REUSE_PLAN'), repoConcurrency: n, phaseTimings: bool('WE_REVIEW_PHASE_TIMINGS') },
      valid: { reusePlan: (v) => typeof v === 'boolean', phaseTimings: (v) => typeof v === 'boolean',
        repoConcurrency: (v) => Number.isInteger(v) && v >= 1 && v <= 8 },
    });
    return { ...REVIEW_TICK_SHARING_STANDARD, ...r.value, source: { ...source, ...r.sources } };
  } catch { return { ...REVIEW_TICK_SHARING_STANDARD, source }; }
}

/**
 * The tick's review-hold sweeps: the human-surface re-park (live #5193 — an accepted PR whose head touches a
 * human-only surface goes back to `review:human`) runs first, then the stray-label reconcile. A re-park failure is
 * its own entry and never stops the reconcile.
 */
export function sweepReviewHolds(opts) {
  let repark;
  try { repark = sweepHumanSurfaceRepark(opts) ?? []; } catch (e) {
    repark = [{ num: 0, repark: 'sweep-failed', error: String((e && e.message) || e).split('\n')[0] }];
  }
  return [...repark, ...(sweepReviewHoldLabels(opts) ?? [])];
}

// Keep the dispatcher's fresh CI/head read authoritative, including when the head moved after listing.
export const headBoundRedTeamCiGate = (gate, head) => input => {
  const facts = gate(input);
  return head && facts?.headSha?.toLowerCase() !== head.toLowerCase()
    ? { ...facts, allowed: false, reason: 'head-changed' } : facts;
};

/**
 * 2026-10-20 — the red team's fair share of a tick's dispatch seats. When the tick has fewer seats than owed rows,
 * at least `min(reserved, seats, red-team rows)` of those seats go to red-team rows (`redTeamRequest` /
 * `carriedAcceptHead`). Each red-team row moved in displaces the LAST non-red-team, non-main-fix row inside the
 * seats, which moves to just after them (no row is dropped; order is otherwise kept). PURE.
 * @returns {{reviews:Array<object>, moved:number[]}}
 */
export function reserveRedTeamSeats(reviews, { seats, reserved }) {
  const isRedTeam = (d) => !!(d?.redTeamRequest || d?.carriedAcceptHead);
  const n = Math.max(0, Math.min(Number(seats) || 0, reviews.length));
  if (!(reserved > 0) || n >= reviews.length || n === 0) return { reviews, moved: [] };
  const inside = reviews.slice(0, n);
  const outside = reviews.slice(n);
  const want = Math.min(reserved, n, reviews.filter(isRedTeam).length) - inside.filter(isRedTeam).length;
  if (want <= 0) return { reviews, moved: [] };
  const victims = [];
  for (let i = inside.length - 1; i >= 0 && victims.length < want; i--) {
    if (!isRedTeam(inside[i]) && !inside[i]?.mainFix) victims.unshift(i);
  }
  const picked = outside.filter(isRedTeam).slice(0, victims.length);
  if (!picked.length) return { reviews, moved: [] };
  const used = victims.slice(victims.length - picked.length);
  const displaced = used.map((i) => inside[i]);
  const keptInside = inside.filter((_, i) => !used.includes(i));
  const keptOutside = outside.filter((d) => !picked.includes(d));
  return { reviews: [...keptInside, ...picked, ...displaced, ...keptOutside], moved: picked.map((d) => Number(d.prNumber)) };
}

/** The red team's reserved dispatch seats, through the policy cascade (env > review-concurrency.json > standard 1). */
export function resolveRedTeamSeatShare({ env = process.env,
  toolPath = join(dirname(fileURLToPath(import.meta.url)), '../../scripts/settings/review-concurrency.json') } = {}) {
  let tool;
  try { tool = JSON.parse(readFileSync(toolPath, 'utf8')); } catch { tool = undefined; }
  const raw = env?.WE_REVIEW_RED_TEAM_RESERVED_SEATS;
  try {
    const r = cascadePolicy('reviewConcurrency', tool && tool.redTeamReservedSeats !== undefined ? { redTeamReservedSeats: tool.redTeamReservedSeats } : undefined, {
      env, standard: { redTeamReservedSeats: 1 },
      envValues: { redTeamReservedSeats: typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : undefined },
      valid: { redTeamReservedSeats: (v) => Number.isSafeInteger(v) && v >= 0 && v <= 8 },
    });
    return { reserved: r.value.redTeamReservedSeats, source: r.sources?.redTeamReservedSeats ?? 'standard' };
  } catch { return { reserved: 1, source: 'standard' }; }
}

/** Pure plan for an otherwise eligible drain request; reason is also its dry-run explanation. */
export function planRedTeamRequestAction({ request, subject, evidence, setting, atRoundCap }) {
  if (!subject || subject.headRefOid?.toLowerCase() !== request.head.toLowerCase())
    return { action: 'skip', reason: 'request head is not current' };
  if (evidence || !setting) return { action: 'job', reason: 'dispatch red-team job' };
  if (atRoundCap) return { action: 'skip', reason: `review round cap reached for #${request.pr}` };
  return { action: 'fresh-review', reason: `would dispatch fresh review for #${request.pr} @${request.head.slice(0, 8)}` };
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
 * @returns {{staleStatusSwept:number[], staleConflictStatusCleared:number[], reviewsOwed:number, dispatched:Array<{prNumber:number, agentId:string|null}>, failed:Array<{prNumber:number, error:string}>, refusals:number, reconcileError:string|null, deferredForLanes:number, holdReconcile:Array<object>, holdReconcileError:string|null, operatorHolds:({observedAt:number, holds:Array<{prNumber:number, kind:string}>}|null)}}
 */
/** Once-per-process memo of the auto-resolve lines already logged (`<repo>#<pr>@<head>:<outcome>[:<why>]`). */
export const AUTO_RESOLVE_SEEN = new Set();

/**
 * stale-hold-resume — act on one plan row's {@link decideReferralHoldAutoResolve} answer. Logs
 * `referral-hold auto-resolved {pr, head, outcome}` once per PR/head/outcome; a `stay` logs why, once per reason.
 * `send-back` sends the PR back to the fixer exactly as a block ruling's follow-up does (skipped when the PR already
 * carries `review:changes`); a failed send is retried next tick. Never accepts, never touches `review:human`.
 * @returns {{resolved?:object, error?:string}|null}
 */
export function handleReferralHoldAutoResolve({ repo, row, auto, rawPrs = null, send = null, seen = AUTO_RESOLVE_SEEN, log = () => {} }) {
  const pr = Number(row?.prNumber);
  const head = auto?.head ?? null;
  const record = { repo, pr, head, outcome: auto?.outcome, ...(auto?.counts ? { counts: auto.counts } : {}) };
  if (auto?.outcome === 'stay') {
    const key = `${repo}#${pr}@${head}:stay:${auto.why}`;
    if (!seen.has(key)) { seen.add(key); log(`review-daemon: referral-hold auto-resolve kept the pause ${JSON.stringify({ ...record, why: auto.why })}`); }
    return null;
  }
  const key = `${repo}#${pr}@${head}:${auto?.outcome}`;
  if (auto?.outcome === 'resume') {
    const resolved = { ...record, next: auto.next ?? 'human-review' };
    if (!seen.has(key)) { seen.add(key); log(`review-daemon: ${REFERRAL_HOLD_AUTO_RESOLVED} ${JSON.stringify(resolved)}`); }
    return { resolved };
  }
  if (auto?.outcome !== 'send-back') return null;
  const live = Array.isArray(rawPrs) ? rawPrs.find(p => Number(p?.number) === pr) : null;
  const labels = (live?.labels ?? row?.labels ?? []).map(l => (typeof l === 'string' ? l : l?.name));
  const blocked = (auto.blocked ?? []).map(b => `${b.file ?? 'no file'}${Number.isInteger(b.line) ? `:${b.line}` : ''}`);
  const resolved = { ...record, blocked };
  // Already sent back by this process (a stale listing can still lack the label): never twice.
  if (seen.has(key)) return { resolved };
  if (labels.includes('review:changes')) {
    if (!seen.has(key)) { seen.add(key); log(`review-daemon: ${REFERRAL_HOLD_AUTO_RESOLVED} ${JSON.stringify({ ...resolved, sentBack: 'already review:changes' })}`); }
    return { resolved };
  }
  if (typeof send !== 'function') {
    const k = `${key}:no-sender`;
    if (!seen.has(k)) { seen.add(k); log(`review-daemon: referral-hold auto-resolve owes a send-back but no sender is wired ${JSON.stringify(resolved)}`); }
    return null;
  }
  const actors = [...new Set((auto.blocked ?? []).map(b => String(b.actor ?? '')))];
  try {
    const out = send({ repo, pr, head, body: referralHoldSendBackBody({ head, blocked: auto.blocked ?? [] }),
      actor: actors.length === 1 && actors[0] && actors[0] !== 'reviewer' ? actors[0] : AUTO_POLICY_ACTOR,
      channel: 'review-daemon referral-hold auto-resolve' });
    seen.add(key);
    log(`review-daemon: ${REFERRAL_HOLD_AUTO_RESOLVED} ${JSON.stringify({ ...resolved, sentBack: out?.sentBack === true })}`);
    return { resolved: { ...resolved, sentBack: out?.sentBack === true } };
  } catch (e) {
    const error = `referral-hold auto-resolve send-back: ${String(e?.message ?? e).split('\n')[0]}`;
    log(`review-daemon: ${repo}#${pr} ${error} (retried next tick)`);
    return { error };
  }
}

/** The real send-back: the SAME follow-up effect `record-referral-ruling` runs for a block ruling
 *  (`record-referral-ruling-io.mjs#createRecordReferralRulingSinks`, head re-check + `review-set-label --to=changes` +
 *  the ledger send-back row). That effect is async and the tick is not, so it runs in a short child process
 *  (`scripts/conveyor/referral-hold-send-back.mjs`, static imports only). */
export function defaultSendBackReferralHold(args, { exec = execFileSync } = {}) {
  const child = join(dirname(fileURLToPath(import.meta.url)), '../../scripts/conveyor/referral-hold-send-back.mjs');
  const out = exec(process.execPath, [child], { encoding: 'utf8', timeout: 180_000,
    env: { ...process.env, WE_AUTO_RESOLVE_SEND_BACK: JSON.stringify(args) }, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(String(out).trim().split('\n').filter(Boolean).at(-1) ?? '{}');
}

export function runReviewTick({
  defaultBranch = 'main',
  reconcile = runReconcilePass,
  dispatch = dispatchReviewByMode,
  redTeamOnSkip = null,
  tagRound = tagReviewRound,
  tagStatus = tagReviewStatus,
  statusCandidates = selectStatusCandidates,
  holdReconcile = sweepReviewHolds,
  notifyReferral = notifyReferralHold,
  // stale-hold-resume — `({repo, pr, head, body, actor, channel}) => {sentBack}`: the send-back a block ruling's own
  // follow-up performs (`review-set-label --to=changes`). `null` (the default) sends nothing and logs that it is owed.
  sendBackReferralHold = null,
  // Once-per-process memo for the auto-resolve log lines (injectable so tests stay independent).
  autoResolveSeen = AUTO_RESOLVE_SEEN,
  // card x29vm8a - `({repo, prNumber, headRefName, headRefOid, defaultBranch}) => {ok, action, error?}`; `null` (the default) never
  // refreshes, so every existing caller of this function is unchanged. The real daemon passes {@link refreshScopeBloatedPr}.
  refreshScopeBloat = null,
  postRefreshMarker = null,
  acquirableLanes = () => Infinity,
  // verify-admission (2026-10-20) — host-level admission for new review sessions: `() => {admitted, reason,
  // maxPerTick?}`. Not admitted ⇒ nothing is dispatched this tick (every review stays owed: queued, never dropped);
  // admitted ⇒ at most `maxPerTick` new sessions. The default admits everything so pure-function callers are unchanged;
  // the real daemon wires {@link defaultReviewHostAdmission} (host load + memory headroom, cascade-sourced).
  hostAdmission = () => ({ admitted: true, reason: 'not checked', maxPerTick: Infinity }),
  // EMERGENCY 2026-10-20 — `{left:number}` shared by every repo of one daemon tick (see
  // {@link liveReviewRoundBudget}); `null` (the default) never caps, so pure-function callers are unchanged.
  liveReviewBudget = null,
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
  // card xemxk3h — `({repo, prNumbers}) => {rows}`: promote this pass's `promote-draft` rows through the fast
  // promoter's guarded step, then re-plan so the review goes out THIS pass. `null` (the default) keeps every
  // existing caller unchanged; the real daemon wires `promoteDraftsGuarded`. `notePromotions` reports the rows.
  promoteDrafts = null,
  notePromotions = null,
  // #5771 — `({repo, pr, headSha}) => {ok, reason}`: execute this pass's `restore-review-label` stale-accept rows through
  // the guarded re-arm, then re-plan so the new head's review goes out THIS pass. `null` (the default) keeps every
  // existing caller unchanged; the real daemon wires `rearmStaleAcceptanceGuarded`. `noteRearms` reports the rows.
  rearmStaleAccepts = null,
  noteRearms = null,
  onPlan = null,
  readRedTeamRequests = null,
  // `({repo, pr}) => {state}` — read only for a request whose PR is absent from the open listing, to expire a
  // merged/closed PR's request. `null` (the default) never expires; the request is held with a logged reason.
  readPrState = null,
  // `{reserved:number, source:string}` — the red team's guaranteed share of this tick's dispatch seats (see
  // {@link reserveRedTeamSeats}). `null` (the default) reserves nothing, so existing callers are unchanged.
  redTeamSeatShare = null,
  readReviewEvidence = null,
  redTeamTimingSetting = readRedTeamTiming,
  // One-line failure causes (status sweep / status tag). The real daemon wires `log.error`; tests inject a spy.
  log = () => {},
  readMainFixPr = readMainFixPriority,
  finishRedTeamRequest = finishDrainRedTeamRequest,
  // Clock for the operator-hold snapshot's `observedAt` (injectable so tests stay deterministic).
  now = Date.now,
} = {}) {
  // #x01u7az — runs FIRST and INDEPENDENTLY of `reconcile`'s own plan: it is a plain `gh pr list` + label read
  // over the whole repo, not scoped to whatever this tick's discovery found owed, so a `reconcile` failure
  // below must never suppress it. Isolated in its own try/catch, same "one bad entry never aborts the rest"
  // discipline as every other step in this tick — a `gh` hiccup here must not cost a review dispatch.
  const sharedReads = typeof readPrs === 'function' && typeof readAgents === 'function';
  let rawPrs = null;
  let rawPrsError = null;
  let rawPrsFailed = false;
  if (sharedReads) {
    try { rawPrs = readPrs({ repo }); } catch (e) { rawPrsError = e; rawPrsFailed = true; }
  }
  let holdReconcileResults = [];
  let holdReconcileError = null;
  try {
    // Both hold sweeps nominate candidates from number/labels; all mutations still use fresh live reads.
    holdReconcileResults = holdReconcile({ repo, ...(sharedReads && !rawPrsFailed ? { listPrs: () => rawPrs } : {}) }) ?? [];
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
  // Shared PRs were read before the hold sweep; agent discovery and any captured PR-read failure
  // are isolated with reconcile here. Its injected readers reuse those same snapshots.
  let plan;
  let rawAgents = null;
  try {
    if (sharedReads) {
      if (rawPrsFailed) throw rawPrsError;
      rawAgents = readAgents({});
      plan = reconcile({ repo, defaultBranch, readPrs: () => rawPrs, readAgents: () => rawAgents });
    } else {
      plan = reconcile({ repo, defaultBranch });
    }
  } catch (e) {
    return {
      reviewsOwed: 0, dispatched: [], failed: [], refusals: 0, deferredForLanes: 0,
      reconcileError: describeReconcileError(e), staleStatusSwept: [], staleConflictStatusCleared: [],
      holdReconcile: holdReconcileResults, holdReconcileError,
    };
  }
  // Refresh stale status labels (including legacy status:awaiting-base) before promotion/dispatch
  // can block the rest of the tick. Still-conflicting PRs stay with the later status pass.
  const staleStatusSwept = [];
  const staleConflictStatusCleared = [];
  const statusTaggedThisTick = new Set();
  const statusPlanRows = [...(plan.dispatch ?? []), ...(plan.refusals ?? []), ...(plan.notes ?? [])];
  rawPrs = Array.isArray(rawPrs) ? rawPrs.map(prState => {
    let pr = '?';
    try {
      const number = Number(prState.number);
      if (Number.isFinite(number)) pr = number;
      const currentLabels = prState.labels === undefined ? [] : prState.labels;
      const labelNames = currentLabels.map(l => typeof l === 'string' ? l : l?.name);
      if (!labelNames.some(name => PR_STATUS_LABEL_RE.test(name))
        || isConflictingPr(prState)) return prState;
      const result = tagStatus({
        pr, repo, agents: rawAgents ?? undefined, defaultBranch, prState, currentLabels,
        isDraft: !!prState.isDraft,
        mergeConflicted: String(prState.mergeStateStatus ?? '').toUpperCase() === 'DIRTY',
        planRows: statusPlanRows.filter(r => Number(r?.prNumber) === pr),
      });
      statusTaggedThisTick.add(pr);
      // The writer returns both label families; carry its result into the shared snapshot.
      const removed = new Set(result?.removed ?? []);
      const labels = currentLabels.filter(l => {
        const name = typeof l === 'string' ? l : l?.name;
        return !removed.has(name) && !(result?.prStatus !== undefined && PR_STATUS_LABEL_RE.test(name));
      });
      for (const label of [result?.label, result?.prStatus]) {
        if (label && !labels.some(l => (typeof l === 'string' ? l : l?.name) === label)) labels.push(label);
      }
      const nextNames = new Set(labels.map(l => typeof l === 'string' ? l : l?.name));
      const previousNames = new Set(labelNames);
      if (nextNames.size !== previousNames.size || labelNames.some(name => !nextNames.has(name))) {
        staleStatusSwept.push(pr);
        if (previousNames.has('status:conflict')) staleConflictStatusCleared.push(pr);
      }
      return { ...prState, labels };
    } catch (e) {
      try {
        log(`review-daemon: ${repo}#${pr} status sweep skipped: ${String(e?.message ?? e).split(/\r?\n/)[0]}`);
      } catch { /* diagnostics must never abort the sweep */ }
      return prState;
    }
  }) : rawPrs;
  // A failed promotion replan keeps the earlier plan, so it is not an authoritative post-promotion snapshot.
  let replanError = null;
  if (typeof promoteDrafts === 'function') {
    const out = promoteDraftsThenReplan({
      plan, rawPrs, repo, promote: promoteDrafts,
      replan: (prs) => (sharedReads && prs
        ? reconcile({ repo, defaultBranch, readPrs: () => prs, readAgents: () => rawAgents })
        : reconcile({ repo, defaultBranch })),
    });
    ({ plan, rawPrs } = out);
    replanError = out.replanError ?? null;
    if (out.promotions.length) { try { notePromotions?.({ repo, promotions: out.promotions, replanError: out.replanError }); } catch { /* report only */ } }
  }
  if (typeof rearmStaleAccepts === 'function') {
    const out = rearmStaleAcceptsThenReplan({
      plan, rawPrs, repo, rearm: rearmStaleAccepts,
      replan: (prs, opts) => (sharedReads && prs
        ? reconcile({ repo, defaultBranch, readPrs: () => prs, readAgents: () => rawAgents, ...opts })
        : reconcile({ repo, defaultBranch, ...opts })),
    });
    ({ plan, rawPrs } = out);
    replanError = replanError ?? out.replanError ?? null;
    if (out.rearms.length) { try { noteRearms?.({ repo, rearms: out.rearms, replanError: out.replanError }); } catch { /* report only */ } }
  }
  try { onPlan?.({ repo, plan, rawPrs }); } catch { /* observation never breaks a tick */ }
  // Captured at plan completion, never at log-read time. Only a plan that survived (re)planning is evidence.
  const operatorHolds = replanError ? null : { observedAt: now(), holds: operatorHoldsFromPlan(plan) };
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
  // Re-use the ordinary lane/auth/CI/live-job guarded dispatch. A refusal always wins over a request.
  if (readRedTeamRequests && Array.isArray(rawPrs)) {
    // A queued accepted PR owes no jury review. That disposition does not discharge its red-team seat.
    // Every actual review hold/refusal and every live dispatch still blocks this branch.
    const blocked = new Set([...(plan.refusals ?? []).filter(d => !(d.kind === 'nothing-owed' && d.phase === 'queued')),
      ...(plan.dispatch ?? [])].map(d => Number(d.prNumber)));
    const setting = readReviewEvidence ? redTeamTimingSetting() : null;
    if (setting) log(`review-daemon: redTeam.carriedAcceptTriggersReview=${setting.value.carriedAcceptTriggersReview} (source: ${setting.sources.carriedAcceptTriggersReview})`);
    let mainFix = null;
    try { mainFix = readMainFixPr(); } catch { /* unreadable priority grants no preference */ }
    const ownsFix = request => !!mainFix && (mainFix.repo ?? 'we') === repoKeyFromSlug(request.repo)
      && [mainFix.pr, ...(mainFix.prs || [])].includes(request.pr);
    const requests = [...readRedTeamRequests()].sort((a, b) => Number(ownsFix(b)) - Number(ownsFix(a)));
    const fixReviews = [];
    // 2026-10-20 — every request this loop does not turn into a dispatch row says why (live: 12 requests sat for
    // hours with no log line at all). `hold` writes the one-line reason; nothing here changes which branch holds.
    const hold = (request, reason) => log(`review-daemon: red-team request #${request.pr} @${request.head.slice(0, 8)} held — ${reason}`);
    for (const request of requests) {
      if (request.repo.toLowerCase() !== repo.toLowerCase()) continue;
      const subject = rawPrs.find(p => Number(p.number) === request.pr);
      if (subject?.headRefOid && subject.headRefOid.toLowerCase() !== request.head.toLowerCase()) {
        finishRedTeamRequest(request, { status: 'stale' });
        hold(request, `head moved to ${subject.headRefOid.slice(0, 8)}; request finished as stale`);
        continue;
      }
      if (!subject) {
        // Not in the open-PR listing: a merged/closed PR owes no red team, so its request is finished (expired)
        // rather than read again every tick. Only a confirmed MERGED/CLOSED state expires it.
        let state = null;
        try { state = readPrState ? readPrState({ repo, pr: request.pr }) : null; } catch (e) {
          hold(request, `absent from the open-PR listing; state read failed (${String(e?.message ?? e).split('\n')[0]})`);
          continue;
        }
        const st = String(state?.state ?? '').toUpperCase();
        if (st === 'MERGED' || st === 'CLOSED') {
          try {
            finishRedTeamRequest(request, { status: 'expired' });
            hold(request, `PR is ${st}; request finished as expired`);
          } catch (e) { hold(request, `PR is ${st}; expiring the request failed (${String(e?.message ?? e).split('\n')[0]})`); }
        } else hold(request, `absent from the open-PR listing (state ${st || 'unknown'})`);
        continue;
      }
      if (blocked.has(request.pr)) {
        const rows = [...(plan.refusals ?? []), ...(plan.dispatch ?? [])].filter(d => Number(d.prNumber) === request.pr
          && !(d.kind === 'nothing-owed' && d.phase === 'queued'));
        hold(request, `the review plan holds this PR (${rows.map(d => `${d.kind}${d.why ? `: ${String(d.why).slice(0, 160)}` : ''}`).join('; ') || 'already has a dispatch row this tick'})`);
        continue;
      }
      if (!redTeamEnabled()) { hold(request, 'the red team is disabled (review-red-team-policy)'); continue; }
      const labels = (subject?.labels ?? []).map(l => typeof l === 'string' ? l : l.name);
      const missing = ['review:accepted', 'ready-to-merge'].filter(l => !labels.includes(l));
      const blocking = labels.filter(l => ['review:changes', 'review:human', 'review:pending'].includes(l));
      const headKnown = subject.headRefOid?.toLowerCase() === request.head.toLowerCase();
      if (!headKnown || subject.isDraft || missing.length || blocking.length) {
        hold(request, [headKnown ? null : 'the listing carries no head for this PR', subject.isDraft ? 'PR is a draft' : null, missing.length ? `missing ${missing.join(', ')}` : null,
          blocking.length ? `carries ${blocking.join(', ')}` : null].filter(Boolean).join('; '));
        continue;
      }
      let freshReview = false;
      let attempts = 0;
      if (readReviewEvidence) {
        // Only the reconciler knows the exact shared count and effective cap (including
        // operator verdicts, mechanical rounds and extensions). Never reconstruct them here.
        const planned = (plan.refusals ?? []).find(d => Number(d.prNumber) === request.pr);
        const budgetKnown = Number.isInteger(planned?.attempts) && planned.attempts >= 0
          && Number.isInteger(planned?.cap) && planned.cap > 0;
        attempts = budgetKnown ? Math.max(planned.attempts, planned.operatorFixBudget?.attempts ?? 0) : 0;
        const action = planRedTeamRequestAction({ request, subject,
          evidence: readReviewEvidence({ repo, pr: request.pr, head: request.head }),
          setting: setting.value.carriedAcceptTriggersReview, atRoundCap: budgetKnown && attempts >= planned.cap });
        if (action.action === 'skip') {
          log(`review-daemon: ${action.reason}`);
          hold(request, action.reason);
          continue;
        }
        freshReview = action.action === 'fresh-review';
        if (freshReview && !budgetKnown) {
          log(`review-daemon: skipping fresh review for #${request.pr}: exact reconcile attempts/cap unavailable`);
          const seen = [...(plan.refusals ?? []), ...(plan.dispatch ?? [])].filter(d => Number(d.prNumber) === request.pr)
            .map(d => `${String(d.kind).slice(0, 40)}${d.variant ? `/${String(d.variant).slice(0, 20)}` : ''} attempts=${d.attempts ?? '-'} cap=${d.cap ?? '-'}`).join('; ');
          hold(request, `fresh review needs the exact reconcile attempts/cap, which the plan did not carry (plan rows for this PR: ${seen || 'none'})`);
          continue;
        }
      }
      (ownsFix(request) ? fixReviews : reviews).push(freshReview
        ? { kind: 'review', prNumber: request.pr, attempts, carriedAcceptHead: request.head }
        : { kind: 'review', prNumber: request.pr, redTeamRequest: request });
      blocked.add(request.pr);
    }
    reviews.unshift(...fixReviews);
  }
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
  // 2026-10-20 — when this tick can dispatch fewer reviews than are owed, the scarce seats go in priority
  // order (see orderReviewsForDispatch): main-fix first, then PRs a human or the merge queue waits on, oldest first.
  reviews.splice(0, reviews.length, ...orderReviewsForDispatch(reviews, { labelsByPr, plan }));
  const lanes = paused ? 0 : acquirableLanes({ repo });
  const acquirable = Math.max(0, (Array.isArray(lanes) ? lanes.length : Number(lanes)) || 0);
  let host = { admitted: true, maxPerTick: Infinity };
  if (!paused && (reviews.length || typeof redTeamOnSkip === 'function')) {
    try { host = hostAdmission() ?? host; } catch (e) { host = { admitted: false, reason: `host admission unknown: ${String(e?.message ?? e).split('\n')[0]}` }; }
  }
  const hostLimit = !host.admitted ? 0 : Number.isFinite(host.maxPerTick) ? Math.max(0, host.maxPerTick) : Infinity;
  const remainingReviewCapacity = () => liveReviewBudget && Number.isFinite(liveReviewBudget.left)
    ? Math.max(0, liveReviewBudget.left) : Infinity;
  const initialLiveCap = remainingReviewCapacity();
  const seats = Math.min(reviews.length, acquirable, initialLiveCap, hostLimit);
  // 2026-10-20 — red-team rows were appended after every owed review, so under the live-review cap (3 seats,
  // ~17 owed) they never reached a seat. They now get a reserved share of whatever seats this tick has.
  if (redTeamSeatShare && redTeamSeatShare.reserved > 0) {
    const share = reserveRedTeamSeats(reviews, { seats, reserved: redTeamSeatShare.reserved });
    if (share.moved.length) {
      reviews.splice(0, reviews.length, ...share.reviews);
      log(`review-daemon: red-team seat share — moved #${share.moved.join(', #')} into this tick's ${seats} seat(s): redTeamReservedSeats=${redTeamSeatShare.reserved} (${redTeamSeatShare.source ?? 'standard'})`);
    }
  }
  const dispatchable = [];
  let occupiedLanes = 0;
  const dispatched = [];
  const failed = [];
  const referralHoldAutoResolved = [];
  // A pause the plan itself lifted (its head's one finished review left no advisory): the advisory review goes out.
  for (const n of plan.notes ?? []) {
    if (n?.kind !== 'referral-hold-auto-resolved') continue;
    const resolved = { repo, pr: n.prNumber, head: n.head, outcome: n.outcome, ...(n.counts ? { counts: n.counts } : {}), next: n.next };
    const key = `${repo}#${n.prNumber}@${n.head}:${n.outcome}:${n.next}`;
    if (!autoResolveSeen.has(key)) { autoResolveSeen.add(key); log(`review-daemon: ${REFERRAL_HOLD_AUTO_RESOLVED} ${JSON.stringify(resolved)}`); }
    referralHoldAutoResolved.push(resolved);
  }
  for (const row of plan.refusals ?? []) {
    // stale-hold-resume — a pause whose every live-head finding already carries a ruling resolves itself.
    const auto = row.referralHoldAutoResolve ?? row.reviewRefusal?.referralHoldAutoResolve;
    if (auto) {
      const r = handleReferralHoldAutoResolve({ repo, row, auto, rawPrs, send: sendBackReferralHold, seen: autoResolveSeen, log });
      if (r?.resolved) referralHoldAutoResolved.push(r.resolved);
      if (r?.error) failed.push({ prNumber: row.prNumber, error: r.error });
      // A resolved pause owes no "waiting on your ruling" notice: every finding is ruled.
      if (auto.outcome !== 'stay') continue;
    }
    const hold = row.referralHold ?? row.reviewRefusal?.referralHold;
    if (!hold) continue;
    try {
      notifyReferral({ repo, prNumber: row.prNumber, hold,
        pr: (rawPrs ?? []).find(p => Number(p.number) === row.prNumber),
        comments: (rawPrs ?? []).find(p => Number(p.number) === row.prNumber)?.comments ?? [] });
    } catch (e) {
      failed.push({ prNumber: row.prNumber, error: `pause notice: ${String(e.message ?? e).split('\n')[0]}` });
    }
  }
  // card x29vm8a - a PR held `scope-bloat` because of a stale base gets ONE mechanical refresh onto main per head. The
  // answer is remembered, so the next tick's plan either sees a clean (smaller) head, or sees the refresh did not help
  // and routes the PR to a fixer to rebase. No review is dispatched for it meanwhile (the plan refused it).
  const scopeBloatRefreshed = [];
  if (typeof refreshScopeBloat === 'function') {
    for (const row of plan.refusals ?? []) {
      if (row.kind !== 'scope-bloat' || !row.scopeBloat?.stale || row.scopeBloat.refresh || !row.headRefName || !row.headRefOid) continue;
      // A refresh that THROWS is normalized into a failed result and goes down the same path as one that returns: it is
      // remembered in this process AND gets the durable per-head marker, because the fix daemon (another process) reads
      // only the thread and would otherwise wait forever on a refresh it cannot see was tried.
      const oneLine = (e) => String((e && e.message) || e).split('\n')[0];
      let result;
      try {
        result = refreshScopeBloat({ repo, prNumber: row.prNumber, headRefName: row.headRefName, headRefOid: row.headRefOid, defaultBranch });
      } catch (e) {
        result = { ok: false, action: 'error', error: oneLine(e) };
        failed.push({ prNumber: row.prNumber, error: `scope-bloat refresh: ${result.error}` });
      }
      recordScopeBloatRefresh(row.prNumber, row.headRefOid, result);
      if (typeof postRefreshMarker === 'function') {
        try { postRefreshMarker(row.prNumber, { repo, headRefName: row.headRefName, headSha: row.headRefOid, ok: result?.ok === true, action: result?.action ?? 'error', error: result?.error ?? null }); }
        catch (e) {
          failed.push({ prNumber: row.prNumber, error: `scope-bloat marker: ${oneLine(e)}` });
          // The thread never saw the attempt: owe the refresh + marker again next tick (bounded per head).
          noteScopeBloatMarkerFailure(row.prNumber, row.headRefOid);
        }
      }
      scopeBloatRefreshed.push({ prNumber: row.prNumber, ok: result?.ok === true, action: result?.action ?? null });
    }
  }
  // x26lw6u — NOT named `skipped`: `withSelfSync` already returns `{skipped: true}` for a whole skipped tick,
  // and `onTick` reads both shapes.
  const notStarted = [];
  for (const d of reviews) {
    if (paused || !host.admitted || occupiedLanes >= hostLimit || occupiedLanes >= acquirable || remainingReviewCapacity() <= 0) break;
    dispatchable.push(d);
    // Reserve only this start. A confirmed refusal releases the seat for the next PR (including later
    // repos). A throw may follow a successful spawn, so its reservation must remain until the next ps read.
    const reserved = Number.isFinite(remainingReviewCapacity());
    if (reserved) liveReviewBudget.left--;
    try {
      const subject = (Array.isArray(rawPrs) ? rawPrs : []).find(p => Number(p?.number) === Number(d.prNumber));
      if (d.carriedAcceptHead) log(`review-daemon: dispatching fresh review for #${d.prNumber} @${d.carriedAcceptHead.slice(0, 8)} (carried accept, no review evidence)`);
      const result = dispatch({ pr: d.prNumber, repo,
        ...(d.redTeamRequest ? { expectedRedTeamHead: d.redTeamRequest.head, drainRedTeamRequest: d.redTeamRequest } : {}),
        ...(d.advisoryReview?.ciWaived === true ? { advisoryCiWaiver: { head: d.advisoryReview.head, reason: d.advisoryReview.reason } } : {}),
        ...(Array.isArray(lanes) ? { preferLane: lanes[occupiedLanes] } : {}),
        escalationReason: parseEscalationReason(subject?.body ?? ''),
        scopePaths: (subject?.files ?? []).map(f => typeof f === 'string' ? f : f.path),
      });
      // x26lw6u — a job dispatch that declined to start (a live job already on this PR, or the lane cool-off)
      // did not advance the round, so it gets no round tag — same rule as a failed dispatch.
      if (result?.skipped) {
        // A refusal that started nothing frees its seat. A live-job skip names a job that may have appeared after this
        // tick's ps read: it refunds only when that job's pid was already counted (when in doubt, overcount).
        const counted = liveReviewBudget?.countedJobPids;
        const refundable = result.skipped !== 'live-job'
          || (Number.isInteger(result.jobPid) && counted instanceof Set && counted.has(result.jobPid));
        if (reserved && refundable) liveReviewBudget.left++;
        notStarted.push({ prNumber: d.prNumber, reason: result.skipped });
        continue;
      }
      dispatched.push({
        prNumber: d.prNumber, agentId: result?.agentId ?? null,
        ...(result?.mode ? { mode: result.mode } : {}), ...(Number.isInteger(result?.jobPid) ? { jobPid: result.jobPid } : {}),
      });
      occupiedLanes++;
      if (typeof host.take === 'function') host.take(1);
    } catch (e) {
      occupiedLanes++;
      if (typeof host.take === 'function') host.take(1);
      failed.push({ prNumber: d.prNumber, error: String((e && e.message) || e).split('\n')[0] });
      continue; // no round tag when the dispatch result is unknown
    }
    if (d.redTeamRequest) continue; // A red-team retry does not spend another jury round.
    try { tagRound({ pr: d.prNumber, repo, round: (d.attempts ?? 0) + 1, currentLabels: labelsByPr.get(Number(d.prNumber)) }); }
    catch { /* cosmetic — a failed tag never fails the tick, see review-round-tag.mjs's own header */ }
  }
  let redTeamOnSkipResult;
  if (!paused && host.admitted && typeof redTeamOnSkip === 'function') {
    try {
      let hostStartsTaken = 0;
      redTeamOnSkipResult = redTeamOnSkip({ repo, plan, rawPrs,
        capacity: { lanes: Math.max(0, Math.min(acquirable - occupiedLanes, hostLimit - occupiedLanes)), budget: liveReviewBudget,
          ...(Number.isFinite(hostLimit) ? { remainingStarts: Math.max(0, hostLimit - occupiedLanes) } : {}),
          ...(typeof host.take === 'function' ? { take: () => { host.take(1); hostStartsTaken++; } } : {}),
        }, paused });
      // Production recovery consumes the shared allowance at dispatch time. Hooks returning
      // starts without using take still owe those seats, including uncertain spawns.
      const starts = (redTeamOnSkipResult?.dispatched?.length ?? 0) + (redTeamOnSkipResult?.uncertain?.length ?? 0);
      for (let i = hostStartsTaken; i < starts; i++) host.take?.(1);
    } catch { log(`review-daemon: ${repo} red-team recovery failed`); }
  }
  if (!paused && !host.admitted && typeof redTeamOnSkip === 'function') {
    const rows = (plan.refusals ?? []).filter(row => row?.kind === 'already-reviewed-head')
      .map(row => ({ prNumber: row.prNumber,
        head: rawPrs?.find(pr => Number(pr.number) === Number(row.prNumber))?.headRefOid ?? null,
        action: 'skip', why: 'no review capacity left' }));
    if (rows.length) redTeamOnSkipResult = { rows, dispatched: [], uncertain: [],
      notStarted: rows.map(row => ({ prNumber: row.prNumber, reason: row.why })), applied: [] };
  }
  // Compute deferrals after confirmed starts, so skipped attempts neither spend capacity nor leave later
  // eligible PRs outside a preselected batch. Only an actual lane shortfall uses the starvation diagnostic.
  // Keep the original tick-start capacity in diagnostics; use refunded capacity for admission.
  const liveCap = initialLiveCap;
  // Main compares the host allowance with post-dispatch remaining capacity, not tick-start diagnostics.
  const hostBound = !paused && (!host.admitted || (hostLimit < acquirable && hostLimit - occupiedLanes <= remainingReviewCapacity()));
  const capBound = !paused && !hostBound && remainingReviewCapacity() < acquirable - occupiedLanes;
  const deferredTotal = reviews.length - dispatchable.length;
  const deferredForHost = hostBound ? deferredTotal : 0;
  const deferredForCap = capBound ? deferredTotal : 0;
  const deferredForLanes = paused || hostBound || capBound ? 0 : deferredTotal;
  const deferredForAuth = paused ? deferredTotal : 0;
  const deferReason = paused ? 'review owed, but dispatch is paused (Claude login)'
    : hostBound ? `review owed, but held by host admission (${host.reason ?? 'per-tick dispatch budget exhausted'})`
    : capBound ? `review owed, but held by the live-review cap (${liveReviewBudget?.reason ?? `maxLiveReviewRounds, ${liveCap} left`}; ${acquirable} lane(s) acquirable)`
      : `review owed, but no acquirable lane this tick (${acquirable} acquirable)`;
  if (deferredTotal && liveCap < reviews.length && liveReviewBudget?.reason) process.stderr.write(`review-daemon: ${deferredTotal} owed review(s) queued — ${liveReviewBudget.reason}\n`);
  // A queued red-team row has no hold label, so `explainPendingNotDispatched` never names it — say it here.
  for (const d of reviews.slice(dispatchable.length)) {
    const head = d.redTeamRequest?.head ?? d.carriedAcceptHead;
    if (!head) continue;
    try { log(`review-daemon: red-team request #${d.prNumber} @${head.slice(0, 8)} held — no dispatch seat this tick: ${deferReason}${redTeamSeatShare ? `; redTeamReservedSeats=${redTeamSeatShare.reserved} (${redTeamSeatShare.source ?? 'standard'})` : ''}`); }
    catch { /* diagnostics never abort the tick */ }
  }
  if (deferredForHost) process.stderr.write(`review-daemon: ${deferredForHost} owed review(s) queued — ${deferReason}\n`);
  if (poolExhaustion && !paused) {
    try {
      if (acquirable === 0 && deferredForLanes > 0) poolExhaustion.exhausted({ repo, lanePoolRepo: poolExhaustionLanePoolRepo(repo), deferred: deferredForLanes });
      else if (acquirable > 0) poolExhaustion.recovered(repo);
    } catch { /* reporting only — never fails the tick */ }
  }
  // A PR dispatched THIS tick is absent from the pre-dispatch `rawAgents` snapshot, yet its review job record
  // already exists (`dispatchReviewJob` writes it before returning) — reusing the snapshot would tag it "nothing
  // live" and strip its `review-status:reviewing` until the next tick. Those PRs read fresh (`undefined`).
  const dispatchedThisTick = new Set([...dispatched, ...(redTeamOnSkipResult?.dispatched ?? [])].map((d) => Number(d.prNumber)));
  // Waiting stacks can have only a surfaced note; they still need their draft status label.
  // Every PR of this tick's shared listing is tagged too: the `status:*` label is ONE per open PR, so a PR the plan
  // gave no row this tick (accepted, parked with a person) still gets its label set and any stale one removed. The
  // writer is idempotent and reads the shared snapshot, so a PR with nothing to change costs no `gh` call.
  const candidates = [...statusCandidates(reviews, plan.refusals ?? [], fixes, ciHeals),
    ...(plan.notes ?? []).filter(n => ['stacked-awaiting-base', 'stacked-base-orphaned'].includes(n.kind)),
    ...(Array.isArray(rawPrs) ? rawPrs : []).filter(p => Number.isInteger(Number(p?.number)) && Number(p.number) > 0).map(p => ({ prNumber: Number(p.number) }))];
  // Every planner row per PR (dispatch rows, refusals, notes): the `status:*` label renders all of them, not just the
  // last one the de-duplication below keeps.
  const rowsByPr = new Map();
  for (const r of [...(plan.dispatch ?? []), ...(plan.refusals ?? []), ...(plan.notes ?? [])]) {
    const n = Number(r?.prNumber);
    if (Number.isInteger(n)) rowsByPr.set(n, [...(rowsByPr.get(n) ?? []), r]);
  }
  for (const c of new Map(candidates.map(c => [Number(c.prNumber), c])).values()) {
    // Swept this tick and not dispatched since: the sweep tag is still current, so skip the repeat.
    if (statusTaggedThisTick.has(Number(c.prNumber)) && !dispatchedThisTick.has(Number(c.prNumber))) continue;
    const rawPr = (rawPrs ?? []).find(p => Number(p?.number) === Number(c.prNumber));
    if (rawPr && rawPr.labels === null) continue; // malformed listing entry: nothing safe to tag
    const agents = dispatchedThisTick.has(Number(c.prNumber)) ? undefined : (rawAgents ?? undefined);
    try {
      tagStatus({
        pr: c.prNumber, repo, agents, defaultBranch, prState: (rawPrs ?? []).find(p => Number(p?.number) === Number(c.prNumber)), currentLabels: labelsByPr.get(Number(c.prNumber)),
        isDraft: isDraftByPr.get(Number(c.prNumber)), mergeConflicted: mergeConflictedByPr.get(Number(c.prNumber)),
        planRows: rowsByPr.get(Number(c.prNumber)) ?? [],
      });
    }
    catch (e) {
      log(`review-daemon: ${repo}#${c.prNumber} status tag failed: ${String(e?.message ?? e).split(/\r?\n/)[0]}`);
    }
  }
  return {
    ...(redTeamOnSkipResult !== undefined ? { redTeamOnSkip: redTeamOnSkipResult } : {}),
    reviewsOwed: reviews.length, dispatched, failed, notStarted, refusals: (plan.refusals ?? []).length,
    pendingNotDispatched: explainPendingNotDispatched({
      prs: rawPrs, plan, dispatchable, deferredForLanes: reviews.slice(dispatchable.length), paused, deferReason,
    }),
    reconcileError: null, deferredForLanes, deferredForCap, deferredForCapReason: deferredForCap ? (liveReviewBudget?.reason ?? null) : null,
    deferredForAuth, deferredForHost, operatorHolds, staleStatusSwept, staleConflictStatusCleared,
    authPaused: paused, authPauseReason: paused ? pauseReason : null,
    holdReconcile: holdReconcileResults, holdReconcileError,
    ...(scopeBloatRefreshed.length ? { scopeBloatRefreshed } : {}),
    ...(referralHoldAutoResolved.length ? { referralHoldAutoResolved } : {}),
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

/** card x29vm8a - the real refresh: the shared mechanical rebase onto `origin/<default>`, run in this daemon's own clone. */
export function refreshScopeBloatedPr({ headRefName, defaultBranch = 'main', refresh = refreshOntoMain } = {}) {
  return refresh(headRefName, { base: `origin/${defaultBranch}` });
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
/** Wrap a host admission so it is evaluated once and its `maxPerTick` is a budget shared by every caller: each
 *  call returns the SAME verdict with what is left, and `take(n)` spends it. A throwing check fails closed. */
export function sharedHostBudget(hostAdmission) {
  let verdict = null;
  let left = 0;
  return () => {
    if (!verdict) {
      try { verdict = hostAdmission() ?? { admitted: false, reason: 'host admission returned nothing' }; }
      catch (e) { verdict = { admitted: false, reason: `host admission unknown: ${String(e?.message ?? e).split('\n')[0]}` }; }
      left = verdict.admitted ? (Number.isFinite(verdict.maxPerTick) && verdict.maxPerTick >= 1 ? verdict.maxPerTick : Infinity) : 0;
    }
    return { ...verdict, maxPerTick: left, take: (n) => { left = Math.max(0, left - n); } };
  };
}

export function runReviewTickAllRepos({ repos = REVIEW_DAEMON_REPOS, tick = runReviewTick, authGateOverride, ...tickOpts } = {}) {
  // card x5kagse (epic #4075/#3383) — computed ONCE per tick (the login is a host-global fact, not per-repo),
  // then forwarded into every repo's own `runReviewTick` call below. Real IO runs only for a genuine production
  // tick (`tick` left at its real default) — mirrors `runTickAllRepos`'s own identical rule in
  // `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs`: a test that injects a fake `tick` never wants
  // this file to shell out for a gate decision it did not ask about, unless it explicitly injects
  // `authGateOverride` to test the gate itself.
  const authGate = authGateOverride ? authGateOverride()
    : (tick === runReviewTick ? planClaudeAuthDispatchGate() : { paused: false, reason: null });
  const perRepoMs = {};
  // verify-admission (audit) — ONE host verdict and ONE dispatch budget per daemon tick, shared by every repo, so
  // the per-tick cap is host-wide (never cap × repos).
  if (typeof tickOpts.hostAdmission === 'function') tickOpts.hostAdmission = sharedHostBudget(tickOpts.hostAdmission);
  const perRepo = forEachRepo(repos, (repo) => {
    const started = Date.now();
    try { return tick({ ...tickOpts, repo, paused: authGate.paused, pauseReason: authGate.reason }); }
    finally { perRepoMs[repo] = Date.now() - started; }
  });
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
  let deferredForCap = 0;
  let deferredForCapReason = null;
  let deferredForAuth = 0;
  const liveProcessPrs = [];
  const operatorHoldSnapshots = [];
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
    deferredForCap += result.deferredForCap ?? 0;
    if (result.deferredForCapReason) deferredForCapReason = result.deferredForCapReason;
    deferredForAuth += result.deferredForAuth ?? 0;
    for (const d of result.dispatched) dispatched.push({ ...d, repo });
    for (const k of (result.notStarted ?? [])) notStarted.push({ ...k, repo });
    for (const p of (result.pendingNotDispatched ?? [])) pendingNotDispatched.push({ ...p, repo });
    for (const f of result.failed) failed.push({ ...f, repo });
    for (const prNumber of (result.liveProcessPrs ?? [])) liveProcessPrs.push({ repo, prNumber });
    if (result.operatorHolds) operatorHoldSnapshots.push({ repo, ...result.operatorHolds });
  }
  return {
    repos: perRepo, perRepoMs, reviewsOwed, dispatched, failed, notStarted, pendingNotDispatched, refusals, reconcileFailed, deferredForLanes, deferredForCap, deferredForCapReason,
    deferredForAuth, authPaused: authGate.paused, authPauseReason: authGate.reason,
    holdReconcile: holdReconcileRemoved, holdReconcileFailed,
    operatorHoldSnapshots,
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
  readPrs = null, readAgents = null, dryRun = false, plans = null,
} = {}) {
  const sharedReads = typeof readPrs === 'function' && typeof readAgents === 'function';
  let plan;
  let rawPrs = null;
  try {
    if (plans?.has(repo)) {
      ({ plan, rawPrs } = plans.get(repo));
    } else if (sharedReads) {
      rawPrs = readPrs({ repo });
      const rawAgents = readAgents({});
      plan = reconcile({ repo, readPrs: () => rawPrs, readAgents: () => rawAgents });
    } else {
      plan = reconcile({ repo });
    }
  } catch (e) {
    return {
      convertAdvisoriesOwed: 0, posted: [], skipped: [], failed: [],
      reconcileError: describeReconcileError(e),
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
 * using a bounded promise pool rather than a reuse of `forEachRepo` (that helper is deliberately synchronous —
 * `fn(repo)`'s return value is captured inline, so an async `fn`'s REJECTION would surface after the loop's own
 * try/catch already returned, as an unhandled rejection rather than a captured `{repo, error}` entry).
 * @param {{repos?:string[], tick?:Function, concurrency?:number}} [o] - every other option forwards to `tick` for every repo.
 * @returns {Promise<{repos:Array<{repo:string, result?:object, error?:string}>, convertAdvisoriesOwed:number,
 *   posted:Array<object>, skipped:Array<object>, failed:Array<object>, reconcileFailed:Array<{repo:string, error:string}>}>}
 */
export async function runConvertAdvisoryTickAllRepos({
  repos = REVIEW_DAEMON_REPOS, tick = runConvertAdvisoryTick,
  concurrency = resolveReviewTickSharing().repoConcurrency, ...tickOpts
} = {}) {
  const perRepo = new Array(repos.length);
  const limit = Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8
    ? concurrency : resolveReviewTickSharing().repoConcurrency;
  let next = 0;
  const worker = async () => {
    while (next < repos.length) {
      const index = next++;
      const repo = repos[index];
      try { perRepo[index] = { repo, result: await tick({ ...tickOpts, repo }) }; }
      catch (e) { perRepo[index] = { repo, error: String((e && e.message) || e).split('\n')[0] }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, repos.length) }, worker));
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
 * card x5f2daz — the light PREP REVIEW stage: a single-reviewer pass on card-only prepare PRs (see
 * `we:scripts/conveyor/prep-review.mjs`). A SEPARATE, ADDITIVE stage like {@link runConvertAdvisoryTick}: it needs no
 * lane and no session, and `runReviewTick`'s return shape stays pinned. WE only (prepare PRs carry WE backlog cards).
 * `prepReview.mode` is `off | advise | block` (env `WE_PREP_REVIEW_MODE`, default `advise`); `off` reviews nothing (it only removes a stale `review:prep`).
 * Never throws: a failure here is reported and never costs the tick's real job.
 * @param {{repo?:string, readPrs?:Function, tick?:Function, makeDeps?:Function, env?:object, root?:string}} [o]
 */
export async function runPrepReviewStage({
  repo = WE_SLUG, readPrs = defaultReadPrs, tick = runPrepReviewTick, env = process.env,
  root = resolve(fileURLToPath(import.meta.url), '..', '..', '..'), makeDeps = makePrepReviewDeps,
} = {}) {
  const mode = resolvePrepReviewMode(env);
  // `off` still runs the tick: it reviews nothing, but it removes a stale `review:prep` from a PR that has grown past its
  // card, which would otherwise hide the normal review from every `review:*` consumer.
  try {
    return await tick({ repo, readPrs, deps: makeDeps({ root, env }) });
  } catch (e) {
    return { mode, reviewed: [], skipped: [], failed: [], readError: String((e && e.message) || e).split('\n')[0] };
  }
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
/**
 * The ledger OUTBOX BACKSTOP (live 2026-10-21, `we:scripts/lib/verdict-ledger-outbox.mjs`). Every append already
 * flushes the queue it joins; this pushes what a crashed or failed flusher left behind when no new append comes.
 * The tick does no git and no board discovery: at most once per interval it starts ONE detached flusher process.
 */
export function defaultFlushLedgerOutboxes({ repos = REVIEW_DAEMON_REPOS, spawnBackstop = spawnLedgerOutboxBackstop } = {}) {
  return [spawnBackstop({ repos })];
}

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
 * Convert-advisory is default ON; env beats the product setting; malformed settings keep the default.
 */
export function resolveConvertAdvisoryEnabled(env = process.env, {
  path = resolve(fileURLToPath(import.meta.url), '../../../scripts/lib/review-fix-policy-settings.json'),
} = {}) {
  const e = String(env?.REVIEW_DAEMON_CONVERT_ADVISORY ?? '').trim().toLowerCase();
  if (e === '0' || e === 'false') return false;
  if (e === '1' || e === 'true') return true;
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'))?.convertAdvisory?.enabled;
    if (typeof v === 'boolean') return v;
  } catch { /* missing/corrupt file = default */ }
  return true;
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

/** verify-admission (2026-10-20) — the real daemon's review host admission: the shared background-work check
 *  (we:scripts/lib/host-load.mjs — host load per core, then free memory + swap headroom) plus the per-tick
 *  dispatch cap, all from the host-overload cascade (sources logged by the loader). Fails closed: an unreadable
 *  policy or host reading admits nothing, so owed reviews wait for the next tick. */
export function defaultReviewHostAdmission({ env = process.env, admission = hostLoadAdmission, loadPolicy = loadHostOverloadSettings } = {}) {
  let policy;
  try { policy = loadPolicy({ env }); } catch (e) { return { admitted: false, reason: `host policy unreadable: ${String(e?.message ?? e).split('\n')[0]}` }; }
  const verdict = admission({ policy, env, interactive: false });
  return { ...verdict, maxPerTick: policy.settings.host.maxReviewDispatchPerTick };
}

/** The real effects the CLI daemon's review pass runs with (the default `runReview` of {@link buildCliDaemonEffects}
 *  spreads these under its per-tick opts). Builds nothing that does IO until a tick calls it. */
export function cliReviewTickOpts({ log = console } = {}) {
  const factsProvider = withFactsLabels(createGhProvider());
  return {
    readRedTeamRequests: readDrainRedTeamRequests,
    readPrState: ({ repo, pr }) => JSON.parse(execFileSyncThrottled('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', 'state'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, killSignal: 'SIGKILL' })),
    redTeamSeatShare: resolveRedTeamSeatShare(),
    readReviewEvidence: readReviewEvidenceAtHead,
    log: line => log.error(line),
    acquirableLanes: defaultAcquirableLaneNumbers, readPrs: defaultReadPrs, readAgents: defaultReadAgents,
    hostAdmission: defaultReviewHostAdmission,
    liveReviewBudget: liveReviewRoundBudget(),
    redTeamOnSkip: o => runRedTeamOnSkip({ ...o, dispatch: d => dispatchReviewJob(d), log: line => log.error(line) }),
    poolExhaustion: DAEMON_POOL_EXHAUSTION,
    refreshScopeBloat: refreshScopeBloatedPr,
    sendBackReferralHold: defaultSendBackReferralHold,
    postRefreshMarker: defaultPostRebaseComment,
    promoteDrafts: promoteDraftsGuarded,
    rearmStaleAccepts: rearmStaleAcceptanceGuarded,
    noteRearms: ({ repo, rearms, replanError }) => {
      for (const r of rearms) log.error(`review-daemon: ${repo}#${r.pr} stale-accept re-arm ${r.ok ? 'done' : r.released ? 'released' : 'refused'} — ${String(r.why ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
      if (replanError) log.error(`review-daemon: ${repo} post-re-arm re-plan failed (review goes out next pass): ${replanError}`);
    },
    notePromotions: ({ repo, promotions, replanError }) => {
      for (const r of promotions) log.error(`review-daemon: ${repo}#${r.pr} same-pass promote ${r.action} — ${String(r.why ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
      if (replanError) log.error(`review-daemon: ${repo} same-pass re-plan failed (review goes out next pass): ${replanError}`);
    },
    dispatch: ({ expectedRedTeamHead, ...o }) => dispatchReviewByMode({ ...o, ...(o.drainRedTeamRequest ? { mode: 'job' } : {}), ciGate: headBoundRedTeamCiGate(readReviewCiGateFactsFirst, expectedRedTeamHead) }),
    tagRound: (o) => tagReviewRound({ ...o, provider: factsProvider }),
    tagStatus: (o) => tagReviewStatus({ ...o, provider: factsProvider }),
  };
}

/**
 * How many review rounds are live in a `ps -A -o pid=,ppid=,command=` listing. A line counts only when the script node RUNS
 * is the review script itself — never when the name merely appears in an argument. Live-caught 2026-10-20: two
 * `verify-lane.mjs` runs whose changed-file list named `review-job.mjs` counted as 2 of the 3 allowed rounds, so
 * the daemon dispatched nothing with 1 real round live. A round is one job or one bare loop (a job runs a loop).
 * Command-only lines are accepted conservatively: without ancestry every matching process is a round.
 * @param {string[]} lines
 * @param {{isScriptFile?: function(string): boolean}} options Optional absolute-path classifier. Ambiguous
 *   or unreadable candidates throw; the live budget holds dispatch. Relative suffix boundaries remain
 *   uncertain when multiple paths fit the flattened argv; uncertainty must not classify a review as absent.
 *   isOptionPath additionally recognizes directories used as runtime option values.
 */
export function countLiveReviewRounds(lines, { isScriptFile = null, isOptionPath = isScriptFile, countedJobPids = null } = {}) {
  // Runtimes that run a script file, and the runtime flags that take their value as the NEXT word (a preload,
  // a loader): those values are not the script. An unknown runtime still counts when its argv[0] is the script.
  const RUNTIME = /(^|\/)(node|nodejs|bun|electron)(\.exe)?$/;
  const VALUE_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--env-file',
    '-C', '--conditions', '--title', '--input-type', '--experimental-config-file',
    '--openssl-config', '--icu-data-dir', '--redirect-warnings', '--diagnostic-dir',
    '--env-file-if-exists', '--allow-fs-read', '--allow-fs-write', '--build-snapshot-config',
    '--cpu-prof-dir', '--cpu-prof-interval', '--cpu-prof-name', '--disable-proto', '--disable-warning',
    '--dns-result-order', '--experimental-default-type', '--experimental-policy', '--experimental-sea-config',
    '--experimental-specifier-resolution',
    '--heap-prof-dir', '--heap-prof-interval', '--heap-prof-name', '--heapsnapshot-near-heap-limit',
    '--heapsnapshot-signal', '--debug-port', '--inspect-port', '--inspect-publish-uid', '--max-http-header-size',
    '--network-family-autoselection-attempt-timeout', '--policy-integrity', '--report-directory', '--report-dir',
    '--report-filename', '--report-signal', '--secure-heap', '--secure-heap-min', '--snapshot-blob',
    '--test-concurrency', '--test-name-pattern', '--test-reporter', '--test-reporter-destination',
    '--test-shard', '--test-skip-pattern', '--test-timeout', '--tls-cipher-list', '--tls-keylog',
    '--trace-event-categories', '--trace-event-file-pattern', '--unhandled-rejections', '--use-largepages',
    '--v8-pool-size', '--watch-path', '--max-old-space-size', '--max-semi-space-size', '--stack-size']);
  // Only known switches can safely be skipped without consuming a value. New Node/V8 or alternate-runtime
  // options must not silently turn their value into an entrypoint and hide a review. Unknown arity holds
  // the budget when the remaining command mentions a review; ordinary unrelated processes stay irrelevant.
  const SWITCH_FLAGS = new Set(['--no-warnings', '--trace-warnings', '--trace-deprecation', '--no-deprecation',
    '--throw-deprecation', '--pending-deprecation', '--enable-source-maps', '--preserve-symlinks',
    '--preserve-symlinks-main', '--experimental-strip-types', '--experimental-transform-types',
    '--experimental-vm-modules', '--experimental-wasm-modules',
    '--experimental-require-module', '--experimental-detect-module', '--experimental-permission',
    '--openssl-legacy-provider', '--openssl-shared-config', '--enable-fips', '--force-fips',
    '--use-bundled-ca', '--use-openssl-ca', '--use-system-ca', '--watch', '--watch-preserve-output',
    '--inspect', '--inspect-brk', '--inspect-wait', '--cpu-prof', '--heap-prof', '--prof', '--test',
    '--test-only', '--test-force-exit', '--experimental-test-coverage', '--no-addons', '--no-global-search-paths',
    '--expose-gc', '--jitless', '--abort-on-uncaught-exception', '--zero-fill-buffers', '--trace-gc', '--trace-gc-nvp']);
  // Numeric and enum options cannot contain a second script-looking word in their value. Paths and free
  // text can: ps would print --openssl-config '/tmp/config dir/openssl.js' without the quotes.
  const SCALAR_FLAGS = new Set(['--input-type', '--cpu-prof-interval', '--disable-proto', '--dns-result-order',
    '--experimental-default-type', '--experimental-specifier-resolution', '--heap-prof-interval',
    '--heapsnapshot-near-heap-limit', '--heapsnapshot-signal', '--debug-port', '--inspect-port',
    '--inspect-publish-uid', '--max-http-header-size', '--network-family-autoselection-attempt-timeout',
    '--report-signal', '--secure-heap', '--secure-heap-min', '--test-concurrency', '--test-shard', '--test-timeout',
    '--unhandled-rejections', '--use-largepages', '--v8-pool-size', '--max-old-space-size', '--max-semi-space-size', '--stack-size']);
  const INPUT_PATH_FLAGS = new Set(['--openssl-config', '--env-file', '--experimental-config-file',
    '--experimental-policy', '--experimental-sea-config', '--build-snapshot-config', '--snapshot-blob']);
  const DIRECTORY_FLAGS = new Set(['--icu-data-dir', '--watch-path']);
  const PRELOAD_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader']);
  const word = (text) => {
    const match = /^(?:"([^"]*)"|'([^']*)'|(\S+))\s*/.exec(text);
    return match ? { value: match[1] ?? match[2] ?? match[3], rest: text.slice(match[0].length) } : { value: '', rest: '' };
  };
  const verifierFileList = (text) => {
    const entry = word(text);
    if (!/^(?:\.\/)?scripts\/verify-lane\.mjs$/.test(entry.value)) return false;
    let rest = entry.rest;
    const mode = word(rest);
    if (/^(?:verify|request|check|reset|run)$/.test(mode.value)) rest = mode.rest;
    let files = false;
    while (rest) {
      const flag = /^--([a-z][a-z0-9-]*)(?==|\s|$)/.exec(rest);
      if (!flag) return false;
      rest = rest.slice(flag[0].length);
      const equals = rest.startsWith('=');
      if (equals || flag[1] === 'files') {
        rest = (equals ? rest.slice(1) : rest).trimStart();
        // Values in ps are flattened too: a changed-file path or --repo value may contain spaces.
        // Within this recognized utility signature, retain the value through the next flag.
        const boundary = rest.search(/\s+(?=--[a-z][a-z0-9-]*(?:=|\s|$))/);
        const value = boundary < 0 ? rest : rest.slice(0, boundary);
        if (!value || value.startsWith('--')) return false;
        rest = boundary < 0 ? '' : rest.slice(boundary).trimStart();
      } else rest = rest.trimStart();
      files ||= flag[1] === 'files';
    }
    return files;
  };
  const verifierAfterOptions = (text) => {
    while (text) {
      if (verifierFileList(text)) return true;
      const option = word(text);
      if (option.value === '--') return verifierFileList(option.rest);
      const flag = option.value.split('=')[0].replaceAll('_', '-');
      if (SWITCH_FLAGS.has(flag)) { text = option.rest; continue; }
      if (!VALUE_FLAGS.has(flag)) return false;
      const equals = text.indexOf('=');
      const value = word(option.value.includes('=') ? text.slice(equals + 1) : option.rest);
      if (!value.value || value.value.startsWith('-')) return false;
      text = value.rest;
    }
    return false;
  };
  const path = (text, { preload = false } = {}) => {
    if (/^["']/.test(text)) return word(text);
    const first = word(text);
    // ps discards argv boundaries, so arbitrary spaced relative paths cannot be proved from text.
    // Recognize the canonical repository verifier + file-list signature as an explicit command
    // boundary convention. Its --files payload names scripts as DATA. Do not generalize this to
    // arbitrary *.mjs prefixes or --files fragments: those can still be spaced review directories.
    if (!preload && verifierFileList(text)) return first;
    // require() accepts JSON and native addons too. Use their suffix
    // as a preload boundary so a relative preload cannot swallow the following review script.
    const extension = preload ? '\\.(?:mjs|cjs|js|json|node)' : '\\.(?:mjs|cjs|js)';
    // An extensionless require (including directory/index resolution), or a custom suffix, can precede
    // a review entrypoint directly. Do not concatenate those two relative argv values into one path.
    const unknownRelativePreload = preload && !first.value.startsWith('/') && !new RegExp(`${extension}$`).test(first.value);
    if (unknownRelativePreload && /(?:^|\/)review-(?:job|loop-cli)\.mjs$/.test(word(first.rest).value)) return first;
    // ps prints argv joined by spaces, without shell quoting. Retain the whole path up to its script
    // extension instead of treating a checkout directory's first space as the end of the script.
    // Flattened ps text can lose a path's boundaries, including extensionless prefixes and option-like
    // directory fragments. Check every plausible absolute candidate before applying lexical conventions.
    const candidates = [];
    const mentionsReview = /review-(?:job|loop-cli)\.mjs(?:\s|$)/.test(text);
    const boundary = text.search(/\s+(?=(?:--?[A-Za-z0-9]|\/|\.{1,2}\/))/);
    const span = boundary < 0 ? text : text.slice(0, boundary);
    if (unknownRelativePreload) {
      const review = /(?:^|\s)(\S*review-(?:job|loop-cli)\.mjs)(?=\s|$)/.exec(span);
      // Without a suffix before a spaced review path, flattened relative argv cannot distinguish
      // a spaced preload from an extensionless preload followed by the actual review entrypoint.
      if (review && !new RegExp(`${extension}(?=\\s|$)`).test(span.slice(0, review.index))) {
        throw new Error('ambiguous preload path in process listing');
      }
    }
    for (const match of text.matchAll(new RegExp(`${extension}(?=\\s|$)`, 'g'))) {
      const candidate = text.slice(0, match.index + match[0].length);
      // No script opened by these POSIX runtimes can exceed Linux's 4096-byte pathname bound (macOS is
      // tighter). Long changed-file argv must not turn impossible concatenated paths into a cap hold.
      if (Buffer.byteLength(candidate) >= 4096) break;
      candidates.push(candidate);
      // No review filename anywhere in this span: later argument boundaries cannot change its count.
      if (!mentionsReview) break;
    }
    let resolved;
    if (isScriptFile && mentionsReview && first.value.startsWith('/')) {
      const files = [...new Set([first.value, ...candidates])].filter(candidate => isScriptFile(candidate));
      if (files.length > 1) throw new Error('ambiguous script path in process listing');
      [resolved] = files;
      const lexicalCandidates = candidates.filter(candidate => candidate.length <= span.length);
      if (!resolved && lexicalCandidates.length !== 1) throw new Error('ambiguous script path in process listing');
    }
    // Relative paths belong to the other process's cwd. A suffix can end either an argument or a
    // directory fragment (./Review.mjs Work/review-loop-cli.mjs). Preserve that uncertainty through
    // preload parsing too: treating ./Boot.json as complete can hide the real entrypoint behind boot.cjs.
    if (!first.value.includes('/') && !new RegExp(`${extension}$`).test(first.value)) {
      if (isScriptFile && mentionsReview) throw new Error('ambiguous script path in process listing');
      return first;
    }
    // Bare '-' / '--' may be directory fragments. A normal option or a rooted path starts a new argument
    // in the lexical fallback; an existing absolute path above takes precedence over that convention.
    const match = new RegExp(`^(.*?${extension})(?=\\s|$)`).exec(span);
    const value = resolved ?? match?.[1] ?? first.value;
    // Include candidates beyond lexical option/root boundaries: '-Work', '--files=Work', and './Work'
    // can all be directory fragments after the space. Only filesystem resolution can rule them out.
    // Even a single suffix is uncertain if the lexical boundary truncated its path before that suffix.
    const ambiguous = !first.value.startsWith('/') && mentionsReview
      && (candidates.length > 1 || candidates.some(candidate => candidate.length > span.length));
    return { value, rest: text.slice(value.length).trimStart(), ambiguous };
  };
  const optionValue = (text, flag) => {
    const first = word(text);
    if (/^["']/.test(text) || SCALAR_FLAGS.has(flag)) return first;
    const classify = INPUT_PATH_FLAGS.has(flag) ? isScriptFile : DIRECTORY_FLAGS.has(flag) ? isOptionPath : null;
    if (classify && first.value.startsWith('/')) {
      const candidates = [];
      // Check complete absolute values, including custom suffixes and directory values. The bound also
      // prevents a long verifier file list from causing unbounded filesystem probes.
      for (const match of text.matchAll(/\s+|$/g)) {
        const value = text.slice(0, match.index);
        if (Buffer.byteLength(value) >= 4096) break;
        if (value && classify(value)) candidates.push(value);
      }
      if (candidates.length > 1) throw new Error('ambiguous runtime option value in process listing');
      if (candidates.length === 1) return { value: candidates[0], rest: text.slice(candidates[0].length).trimStart() };
    }
    // Relative paths and arbitrary text cannot be resolved against this cwd. Keep the uncertainty until
    // the entrypoint is classified: a tail such as "-e" or "--require" might itself belong to the value.
    return { ...first, ambiguous: /review-(?:job|loop-cli)\.mjs/.test(first.rest) };
  };
  const script = (command) => {
    // Ambiguous options in an unrelated process cannot conceal a review entrypoint.
    if (!/review-(?:job|loop-cli)\.mjs/.test(command)) return '';
    let runtime = word(command);
    if (!/^["']/.test(command)) {
      // argv[0] also loses its space boundaries in ps. A later /node (or another runtime) can
      // complete the executable path rather than name a utility's argument. Resolve absolute
      // candidates on disk; relative paths belong to another cwd and must hold on uncertainty.
      // The first fragment can itself end in /node: /Applications/node -e Tools/bin/node.
      const candidates = [];
      for (const match of command.matchAll(/\/(?:node|nodejs|bun|electron)(?:\.exe)?(?=\s|$)/g)) {
        const candidate = command.slice(0, match.index + match[0].length);
        if (Buffer.byteLength(candidate) >= 4096) break;
        if (candidate !== runtime.value) candidates.push(candidate);
      }
      if (candidates.length) {
        const files = isScriptFile && runtime.value.startsWith('/')
          ? [runtime.value, ...candidates].filter(candidate => isScriptFile(candidate)) : [];
        if (files.length !== 1) throw new Error('ambiguous runtime path in process listing');
        runtime = { value: files[0], rest: command.slice(files[0].length).trimStart() };
      }
    }
    if (!RUNTIME.test(runtime.value)) {
      // Only argv[0] can be a direct script; never consume a utility's arguments. Node shebang execution
      // appears as interpreter + script in ps, so its spaced paths use the runtime branch below.
      return runtime.value.split('/').pop();
    }
    // Recognize the whole utility signature once, including understood preload/switch chains.
    // Otherwise each preload would retain ambiguity from the verifier's file-list data (and
    // rescanning every remaining option chain would add quadratic work).
    if (verifierAfterOptions(runtime.rest)) return 'verify-lane.mjs';
    let rest = runtime.rest;
    let ambiguousValue = false;
    const finish = (name) => {
      // A value can itself contain a review filename. Misclassifying a job as a loop would let ancestry
      // deduplication absorb it, so multiple possible review entrypoints must hold too.
      const possibleReviews = runtime.rest.matchAll(/review-(?:job|loop-cli)\.mjs/g);
      const multiple = !possibleReviews.next().done && !possibleReviews.next().done;
      if (ambiguousValue && (!/^review-(?:job|loop-cli)\.mjs$/.test(name)
        || multiple)) {
        throw new Error('ambiguous runtime option value in process listing');
      }
      return name;
    };
    const finishPath = (text) => {
      const entry = path(text);
      ambiguousValue ||= Boolean(entry.ambiguous);
      return finish(entry.value.split('/').pop());
    };
    while (rest) {
      const t = word(rest);
      const flag = t.value.replaceAll('_', '-');
      if (t.value === '--') return finishPath(t.rest);
      // Evaluation modes never execute a script from the remaining argv.
      if (/^(?:-[ep]|--(?:eval|print)(?:=|$))/.test(t.value)) return finish('');
      const equals = rest.indexOf('=');
      if (equals > 0 && PRELOAD_FLAGS.has(rest.slice(0, equals).replaceAll('_', '-'))) {
        const value = path(rest.slice(equals + 1), { preload: true });
        ambiguousValue ||= Boolean(value.ambiguous);
        rest = value.rest;
        continue;
      }
      if (VALUE_FLAGS.has(flag)) {
        const value = PRELOAD_FLAGS.has(flag)
          ? path(t.rest, { preload: true })
          : optionValue(t.rest, flag);
        ambiguousValue ||= Boolean(value.ambiguous);
        rest = value.rest;
        continue;
      }
      if (equals > 0 && VALUE_FLAGS.has(rest.slice(0, equals).replaceAll('_', '-'))) {
        const value = optionValue(rest.slice(equals + 1), rest.slice(0, equals).replaceAll('_', '-'));
        ambiguousValue ||= Boolean(value.ambiguous);
        rest = value.rest;
        continue;
      }
      if (t.value.startsWith('-')) {
        const name = flag.split('=')[0];
        if (!SWITCH_FLAGS.has(name) && /review-(?:job|loop-cli)\.mjs/.test(t.rest)) {
          throw new Error('ambiguous runtime option in process listing');
        }
        rest = t.rest;
        continue;
      }
      return finishPath(rest);
    }
    return finish('');
  };
  const processes = lines.map((line) => {
    const text = String(line).trim();
    const ids = /^(\d+)\s+(\d+)\s+([\s\S]+)$/.exec(text);
    return { pid: ids?.[1], ppid: ids?.[2], name: script(ids ? ids[3] : text) };
  });
  const byPid = new Map(processes.filter(p => p.pid).map(p => [p.pid, p]));
  const jobAncestorOf = (process) => {
    const seen = new Set([process.pid]);
    let pid = process.ppid;
    while (pid && !seen.has(pid)) {
      seen.add(pid);
      const parent = byPid.get(pid);
      if (!parent) break;
      if (parent.name === 'review-job.mjs') return parent.pid;
      pid = parent.ppid;
    }
    return null;
  };
  const jobs = processes.filter(p => p.name === 'review-job.mjs');
  const loops = processes.filter(p => p.name === 'review-loop-cli.mjs');
  // A job's own loop is the same round, so each job absorbs AT MOST ONE descendant loop; any further loop under
  // the same job is counted as its own round (when in doubt, overcount). Never below running HEAD's floor
  // max(jobs, loops).
  const absorbed = new Set();
  let extraLoops = 0;
  for (const loop of loops) {
    const job = jobAncestorOf(loop);
    if (job && !absorbed.has(job)) absorbed.add(job);
    else extraLoops += 1;
  }
  const count = Math.max(jobs.length + extraLoops, jobs.length, loops.length);
  if (countedJobPids) for (const job of jobs) if (job.pid) countedJobPids.add(Number(job.pid));
  return count;
}

/** EMERGENCY 2026-10-20 — the host-wide cap on live review rounds, from the tool layer
 *  (`scripts/settings/review-concurrency.json`, source logged by the cascade). Counts live `review-job.mjs` /
 *  `review-loop-cli.mjs` processes (a round is one job, or one bare loop). An unreadable `ps` fails closed (no new
 *  review this tick). Revert condition: see the settings file's comment. */
export function liveReviewRoundBudget({ env = process.env, listCommands = () => execFileSync('ps', ['-Aww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024 }),
  toolPath = join(dirname(fileURLToPath(import.meta.url)), '../../scripts/settings/review-concurrency.json') } = {}) {
  let tool;
  try { tool = JSON.parse(readFileSync(toolPath, 'utf8')); } catch { tool = undefined; }
  const raw = env?.WE_REVIEW_MAX_LIVE_ROUNDS;
  const r = cascadePolicy('reviewConcurrency', tool && { maxLiveReviewRounds: tool.maxLiveReviewRounds }, {
    env, standard: { maxLiveReviewRounds: null },
    envValues: { maxLiveReviewRounds: typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : undefined },
    valid: { maxLiveReviewRounds: (v) => v === null || (Number.isSafeInteger(v) && v >= 1) },
  });
  const max = r.value.maxLiveReviewRounds;
  if (max == null) return null;
  const src = r.sources?.maxLiveReviewRounds ?? 'standard';
  let lines;
  try { lines = String(listCommands()).split('\n'); } catch (e) { return { left: 0, reason: `live review rounds unknown (${String(e?.message ?? e).split('\n')[0]}); maxLiveReviewRounds=${max} (${src})` }; }
  let live;
  const countedJobPids = new Set();
  try {
    const statPath = (path, directories = false) => {
      // Another process's relative paths must never be resolved against the daemon's cwd.
      if (!path.startsWith('/')) return false;
      try { const stat = statSync(path); return stat.isFile() || (directories && stat.isDirectory()); }
      catch (error) {
        if (['ENOENT', 'ENOTDIR', 'ENAMETOOLONG'].includes(error?.code)) return false;
        throw error;
      }
    };
    live = countLiveReviewRounds(lines, { countedJobPids, isScriptFile: statPath,
      isOptionPath: path => statPath(path, true) });
  } catch {
    return { left: 0, reason: `live review rounds unknown (ambiguous script path or runtime option); maxLiveReviewRounds=${max} (${src})` };
  }
  return { left: Math.max(0, max - live), live, max, countedJobPids, reason: `live review rounds ${live} of maxLiveReviewRounds=${max} (${src})` };
}

export function buildCliDaemonEffects({
  owner, intervalMs = DEFAULT_INTERVAL_MS, log = console,
  reapSessions = defaultReapSessions,
  // Keep the production runReview closure testable without replacing its executor bindings.
  tick = runReviewTick,
  // #3383 bug 3 — the real daemon wires the real `acquirableLanes` effect through by default, so production
  // dispatch is bounded by lane reality; `runReviewTick`'s OWN default stays unbounded (`() => Infinity`) so
  // every pre-existing test of it (which fakes reconcile/dispatch directly, never this) is unaffected.
  // #4133 — likewise, the real daemon opts INTO the shared-reads optimization by wiring the real
  // `defaultReadPrs`/`defaultReadAgents` through; `runReviewTick`'s own default stays `null` (see that
  // function's own doc for why) so every pre-existing test of it is unaffected here too.
  // C1c — PR facts (head SHA, labels, completed checks) come from the shared store first (`WE_REVIEW_FACTS=0`
  // turns that off). The dispatch gate re-reads the live head after its checks and falls back to GitHub when the
  // store is stale or partial; label READS try the store, label WRITES and the drain/merge path never do.
  // The real review-pass effects ({@link cliReviewTickOpts}); injectable so a test can drive this default `runReview`.
  reviewTickOpts = cliReviewTickOpts,
  runReview = (opts) => runReviewTickAllRepos({ tick, ...reviewTickOpts({ log }), ...opts }),
  // #xconv1 — the SAME shared-reads optimization `runReview` above opts into, wired the same way for its own
  // separate, additive async stage (see `runConvertAdvisoryTick`'s own doc for why this is not folded into
  // `runReview`/`runReviewTick`).
  runConvertAdvisories = (opts) => runConvertAdvisoryTickAllRepos({
    readPrs: defaultReadPrs, readAgents: defaultReadAgents, ...opts,
  }),
  // ON by default: the planner withholds a normal review from a convert-advisory-owed PR, so leaving
  // its executor off strands the PR forever (live #5020, 2026-10-12). The committed product knob is
  // convertAdvisory.enabled in scripts/lib/review-fix-policy-settings.json;
  // REVIEW_DAEMON_CONVERT_ADVISORY=0 is the emergency off switch.
  convertAdvisoryEnabled = resolveConvertAdvisoryEnabled(),
  // card x5f2daz — the light prep review. ON by default in `advise` (it only ever posts a note + `review:prep`);
  // `WE_PREP_REVIEW_MODE=off` turns it off. Injectable so the daemon tests never spawn a model.
  runPrepReview = () => runPrepReviewStage(),
  // The ledger outbox backstop (we:scripts/lib/verdict-ledger-outbox.mjs): injectable so tests never spawn.
  flushLedgerOutboxes = defaultFlushLedgerOutboxes,
} = {}) {
  // #3383 follow-up (live-caught 2026-09-26) — carries the LAST tick's own `liveProcessPrs` across the
  // `await`/closure boundary into the NEXT tick's `reapSessions()` call, below. A plain closure variable is
  // correct here (never a race): `runDaemonLoop` awaits ONE `tickOnce()` to completion before ever calling it
  // again — see that function's own `for (;;) { await tickOnce(); ... }` shape — so there is never a second,
  // concurrent tick reading or writing this while one is in flight.
  let priorityNames = new Set();
  return {
    intervalMs,
    tickOnce: () => withReviewFetchTick(async () => {
      const started = Date.now();
      const sharing = resolveReviewTickSharing();
      const plans = new Map();
      const onPlan = sharing.reusePlan ? ({ repo, plan, rawPrs }) => plans.set(repo, { plan, rawPrs }) : null;
      let phaseStarted = Date.now();
      const phaseMs = {};
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
      phaseMs.reap = Date.now() - phaseStarted;
      phaseStarted = Date.now();
      // Best-effort like the reap: a ledger-outbox backstop failure is logged (the flush itself logs a stale
      // outbox as ledger-write-miss) and never takes down the tick.
      try {
        for (const f of flushLedgerOutboxes() ?? []) {
          if (f?.spawned) log.error(`review-daemon: ledger outbox backstop started flusher pid ${f.pid ?? '?'}${f.pending ? ` for ${f.pending} queued entr${f.pending === 1 ? 'y' : 'ies'}` : ''}${f.dir ? ` (${f.dir})` : ''}`);
          else if (f && (f.flushed || f.ok === false)) log.error(`review-daemon: ledger outbox backstop ${f.ok === false ? 'FAILED' : 'flushed'} ${f.flushed ?? 0} entr${f.flushed === 1 ? 'y' : 'ies'} (${f.dir ?? '?'})${f.error ? `: ${f.error}` : ''}`);
        }
      } catch (e) {
        log.error(`review-daemon: ledger outbox backstop failed (non-fatal): ${String((e && e.message) || e).split('\n')[0]}`);
      }
      phaseMs.ledgerOutbox = Date.now() - phaseStarted;
      phaseStarted = Date.now();
      const warm = await warmReviewFacts(REVIEW_DAEMON_REPOS); // once a tick: refresh the facts mirror from the Worker (not GitHub)
      log.error(`review-daemon: pr-facts ${warm.skipped ? `off (${warm.skipped})` : (warm.warmed ?? []).map((w) => `${w.repo.split('/')[1]}=${w.ok ? 'store' : `github (${w.reason})`}`).join(' ')}`);
      phaseMs.facts = Date.now() - phaseStarted;
      phaseStarted = Date.now();
      const result = await runReview({ plans, onPlan });
      phaseMs.review = Date.now() - phaseStarted;
      // Refreshed for the NEXT tick's own reap call, above — always recomputed from THIS tick's fresh
      // discovery, never accumulated, so a PR that frees up (or a new one that blocks) is reflected within
      // one 120s cycle either way.
      priorityNames = priorityNamesForLiveProcessPrs(result?.liveProcessPrs);
      // #xconv1 — its OWN best-effort try/catch, mirroring the session-reap discipline immediately above: a
      // convert-advisory failure (a `gh`/judge hiccup) must never take down the tick's real job (dispatching/
      // tagging reviews), which has already completed by the time this runs.
      phaseStarted = Date.now();
      let convertAdvisory = null;
      if (convertAdvisoryEnabled) {
        try {
          convertAdvisory = await runConvertAdvisories({ plans: sharing.reusePlan ? plans : null, concurrency: sharing.repoConcurrency });
        } catch (e) {
          log.error(`review-daemon: convert-advisory tick failed (non-fatal): ${String((e && e.message) || e).split('\n')[0]}`);
        }
      } else {
        log.error('review-daemon: convert-advisory stage disabled (convertAdvisory.enabled=false) — any PR owed a convert-advisory is stranded');
      }
      // card x5f2daz — its OWN best-effort stage, same discipline as convert-advisory above.
      phaseMs.convert = Date.now() - phaseStarted;
      phaseStarted = Date.now();
      let prepReview = null;
      try {
        prepReview = await runPrepReview();
      } catch (e) {
        log.error(`review-daemon: prep-review stage failed (non-fatal): ${String((e && e.message) || e).split('\n')[0]}`);
      }
      phaseMs.prep = Date.now() - phaseStarted;
      if (sharing.phaseTimings) {
        const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
        const repos = Object.entries(result?.perRepoMs ?? {}).map(([repo, ms]) => `${repo.split('/').at(-1)} ${seconds(ms)}`).join(', ');
        log.error(`review-daemon: pass timings total ${seconds(Date.now() - started)} — reap ${seconds(phaseMs.reap)}, facts ${seconds(phaseMs.facts)}, review ${seconds(phaseMs.review)} (${repos}), convert ${seconds(phaseMs.convert)}, prep ${seconds(phaseMs.prep)} · reusePlan=${sharing.reusePlan} (source ${sharing.source.reusePlan}) repoConcurrency=${sharing.repoConcurrency} (source ${sharing.source.repoConcurrency})`);
      }
      return { ...result, sessionReap, convertAdvisory, prepReview };
    }),
    sleep: realSleep,
    heartbeat: () => heartbeatRunnerLease(RUNNER_LOCK_ROOT, owner, { key: REVIEW_DAEMON_LEASE_KEY }),
    onTick: (result) => {
      // A `withSelfSync`-skipped tick (`skippedTick`: `repos: []`) used to print as "tick () — 0 owed", which read
      // like discovery had watched NO repo. Say what actually happened.
      if (result?.skipped) { log.error(`review-daemon: tick skipped (${result.reason ?? 'unknown'}) — no repo was read this tick`); return; }
      log.error(`review-daemon: tick (${result.repos.map((r) => r.repo).join(', ')}) — ${result.reviewsOwed} owed, dispatched ${result.dispatched.length}, failed ${result.failed.length}${result.deferredForLanes ? `, deferred ${result.deferredForLanes} (no acquirable lane this tick, #3383)` : ''}${result.deferredForCap ? `, queued ${result.deferredForCap} (live-review cap: ${result.deferredForCapReason ?? 'maxLiveReviewRounds'})` : ''}`);
      // card x5kagse (epic #4075/#3383) — logged EVERY tick review dispatch stays paused, exact wording
      // required by the card and matched by the soak scenario/live-proof read.
      // One structured record per successfully planned repository; the health watch's `operator-hold-aged` smell reads
      // these, never the human-readable lines below.
      for (const snap of (Array.isArray(result.operatorHoldSnapshots) ? result.operatorHoldSnapshots : [])) {
        log.error(formatOperatorHoldsRecord({ repo: snap.repo, observedAt: snap.observedAt, intervalMs, holds: snap.holds }));
      }
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
        if (h.repark) log.error(`review-daemon: ${h.repo}#${h.num} human-surface re-park ${h.repark} at ${String(h.head||'').slice(0,9)} (${(h.files||[]).join(',')})${h.error ? ` (FAILED: ${h.error})` : ''}`);
        if (h.remove?.length) log.error(`review-daemon: ${h.repo}#${h.num} hold-reconcile removed ${h.remove.join(',')}${h.error ? ` (FAILED: ${h.error})` : ''}`);
        if (h.healed?.length) log.error(`review-daemon: ${h.repo}#${h.num} hold-reconcile HEALED — removed ${h.healed.join(',')}${h.commentPosted ? ', comment posted' : ''}${h.error ? ` (FAILED: ${h.error})` : ''}`);
        if (h.carry) log.error(`review-daemon: ${h.repo}#${h.num} accept carry-forward ${h.carry}${h.detail ? ` — ${h.detail}` : ''}${h.error ? ` (FAILED: ${h.error})` : ''}`); // card xu7kxtt
        if (h.ruling) log.error(`review-daemon: ${h.repo}#${h.num} ruling-needed label ${h.ruling}${h.error ? ` (FAILED: ${h.error})` : ''}`);
        if (h.flagged?.length) log.error(`review-daemon: ${h.repo}#${h.num} hold-reconcile FLAGGED contradictory ${h.flagged.join(',')} — not auto-resolved (${h.flagReason || 'unresolved'}${h.fetchError ? `, fetch error: ${h.fetchError}` : ''})`);
      }
      for (const hf of (result.holdReconcileFailed ?? [])) log.error(`review-daemon: ${hf.repo} hold-reconcile failed (non-fatal, other repos unaffected): ${hf.error}`);
      if (result.sessionReap && !result.sessionReap.unreadable) {
        const sr = result.sessionReap;
        log.error(`review-daemon: session-reap — ${sr.scanned} scanned, ${sr.stopped} stopped${sr.alreadyGone ? `, ${sr.alreadyGone} already gone` : ''}${sr.failures ? `, ${sr.failures} failed` : ''}${sr.anomalies ? `, ${sr.anomalies} anomalies` : ''}${sr.previouslyReaped ? `, ${sr.previouslyReaped} already reaped earlier (skipped)` : ''}, ${sr.kept} kept${sr.deferred ? `, ${sr.deferred} deferred to next tick (reap budget: ${sr.reapBudget?.maxStops} stops / ${sr.reapBudget?.maxDurationMs}ms, #3383)` : ''}`);
      }
      const pr = result.prepReview;
      if (pr) {
        for (const r of (pr.reviewed ?? [])) log.error(`review-daemon: ${WE_SLUG}#${r.prNumber} prep-review (${pr.mode}) ${r.outcome}${r.findings?.length ? `: ${r.findings.join(',')}` : ''}${r.addLabels?.length ? `; labelled ${r.addLabels.join(',')}` : ''}`);
        for (const f of (pr.failed ?? [])) log.error(`review-daemon: ${WE_SLUG}#${f.prNumber ?? '?'} prep-review failed (non-fatal): ${f.error}`);
        for (const x of (pr.stripped ?? [])) log.error(`review-daemon: ${WE_SLUG}#${x.prNumber} prep-review: removed a stale review:prep (the PR now carries more than the card)`);
        if (pr.readError) log.error(`review-daemon: prep-review could not list PRs (non-fatal): ${pr.readError}`);
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
  installDaemonLog(); // item 68a: ISO-stamp every log line (WE_DAEMON_LOG_TIMESTAMPS=0 turns it off)
  const intervalMs = resolveReviewIntervalMs();
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
  console.error(`review-daemon: started on ${hostname()}:${process.pid}, tick every ${intervalMs}ms.`);
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
    withPrEvents(withSelfSync(withGithubAppAuth(buildCliDaemonEffects({ owner, intervalMs }), REVIEW_DAEMON_APP_AUTH_OPTS), {
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
