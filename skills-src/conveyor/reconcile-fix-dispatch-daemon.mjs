#!/usr/bin/env node
/**
 * @file skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs
 * @description #3870 (epic #3383) — the FIRST daemon pulled out of the single conveyor runner.mjs: a
 *   long-lived process that runs {@link ../../scripts/conveyor/reconcile-fix-dispatch.mjs}'s
 *   `runReconcileFixDispatch` on its own interval, standalone, instead of as one of runner.mjs's own
 *   sequential mechanical passes.
 *
 * WHY THIS PASS, FIRST — AND A CORRECTION (#x0jphk5, 2026-09-25). This paragraph previously claimed, by
 * direct read (see #3860's split analysis, reports/2026-09-22-backlog-split-analysis.md), that
 * `runReconcileFixDispatch` already fenced its own resume-or-dispatch decision per PR through
 * `we:scripts/operations/action-store.mjs`'s durable, atomic per-resource claim ledger. THAT WAS FALSE ON
 * `main`: no `scripts/conveyor/action-store.mjs` exists at all, `action-store.mjs` (at
 * `we:scripts/operations/action-store.mjs`) was never imported by the fix-dispatch path, and
 * `reconcile-fix-dispatch.mjs`'s own header said the opposite in plain words ("NAME-BASED LIVENESS, NOT A
 * SEPARATE LEDGER"). The only real guard was a session-name match against a `claude agents --json --all`
 * listing measured (`we:scripts/operations/dispatch-lane-io.mjs`) to lag the CLI's real state by 26+ SECONDS —
 * so running TWO copies of this daemon (or this daemon alongside `runner.mjs`'s own mechanical pass, see
 * ROLLING CUTOVER below) was NOT safe by construction; a second dispatcher reading that stale listing within
 * the lag window could double-dispatch the same `fix-<pr>`.
 *
 * FIXED, NOT JUST DOCUMENTED: `reconcile-fix-dispatch.mjs`'s `dispatchFix`, `tryResumeFix`, and
 * `we:scripts/operations/ci-heal-pr-dispatch.mjs`'s `dispatchCiHeal` now each take a REAL atomic
 * `(repo, pr, headRefOid)` claim — `we:scripts/conveyor/fix-dispatch-claim.mjs`, an `O_EXCL` file under the
 * shared coordination sidecar with a TTL-bounded dead-holder reclaim, reusing
 * `we:scripts/readiness/file-locks.mjs`'s existing lock primitives — before ever spawning or resuming. With
 * that in place, running TWO copies of this daemon at once (or this daemon alongside the mechanical pass) IS
 * now safe: the second dispatcher inside the listing-lag window is refused (`held`) rather than merely
 * unaware. The keyed runner-lock lease below is still taken, purely as an efficiency measure (never launch a
 * second copy that would just watch every claim get refused), not a correctness requirement — unlike the
 * Verify daemon (#3878), which genuinely needs its own lease before it is safe to run standalone at all.
 *
 * ROLLING CUTOVER (per #3860's plan): this daemon runs ALONGSIDE runner.mjs's own
 * `reconcile-fix-dispatch.mjs` mechanical pass for a bake period — safe to run concurrently now for the real
 * reason above (the claim), not the ledger this header used to (wrongly) describe. Dropping the pass from
 * runner.mjs's own `makeCliMechanicalPasses` list is a separate, later step once this daemon has baked; this
 * item does not do it.
 *
 * PURE-CORE / IO-SHELL SPLIT (mirrored from runner.mjs's own header): {@link runDaemonLoop} has no
 * `setTimeout`/`setInterval`, no real lease, no real dispatch — every effect (stepping one tick, sleeping,
 * heartbeating, logging) is injected, so the whole loop/backoff/stop-condition decision is unit-tested with
 * fakes. The IO shell (`main()`, gated on the direct-invocation check) wires the real
 * `runReconcileFixDispatch`, a real interval sleep, and the real keyed runner-lock lease.
 */

import { createFixHandoffSleep, createFixHandoffProbe } from '../../scripts/lib/fix-handoff.mjs';
import { publishAttention } from '../../scripts/operations/needs-you-feed.mjs';
import { autoRoundGrant as defaultAutoRoundGrant, firstLine as redactedFirstLine, stuckAfterGrant as defaultStuckAfterGrant } from '../../scripts/conveyor/auto-round-grant-io.mjs';
import { resolveFixSafety } from '../../scripts/conveyor/repeated-finding-reset.mjs';
import { execFileSync } from 'node:child_process';
import { resolveChildTimeoutMs } from '../../scripts/lib/bounded-child.mjs';
import { decideParkToHuman } from '../../scripts/lib/review-escalation.mjs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RUNNER_LOCK_ROOT, makeOwner,
  acquireRunnerLease, heartbeatRunnerLease, releaseRunnerLeaseIfOwned,
} from './runner-lock.mjs';
import { runReconcileFixDispatch, writePrivateBorrowedPrompt, routeFixExecutor } from '../../scripts/conveyor/reconcile-fix-dispatch.mjs';
import { runAwaitVerifyPassDefault, formatAwaitVerifyLines } from '../../scripts/conveyor/await-verify-pass.mjs';
// xn025gx (fixer proposal A1 + A2 part 1, rulings P1/P2) — the fast push-on-green loop and the active-only fix slot.
import { runTickAwaitVerify, defaultSlotCountedFixClaims, superviseAwaitVerifyLoop, formatReleaseLines } from '../../scripts/conveyor/await-verify-loop.mjs';
import { runFixerStuckReclaimPass, formatFixerStuckReclaimLines } from '../../scripts/conveyor/fixer-stuck-reclaim.mjs'; // card xccgzu5
import { runReconcileCiHealDispatch, dispatchCiHeal } from '../../scripts/operations/ci-heal-pr-dispatch.mjs';
import { runReconcilePromoteDraftDispatch } from '../../scripts/operations/promote-draft-pr-dispatch.mjs'; // draft-first PRs, operator-approved 2026-09-27 — see runPromoteDraftDispatchAllRepos below
import { resolveLiveQueueBaseline } from '../../scripts/readiness/heavy-admission.mjs'; // card xkyw1x4
import { createQueueBudget } from '../../scripts/readiness/heavy-queue-projection.mjs'; // card xkyw1x4
import { execFileSyncThrottled } from '../../scripts/lib/gh-throttle.mjs';
import { readStacksForPass } from '../../scripts/conveyor/pr-stack.mjs';
import { applyNetScopeToReconcile } from '../../scripts/conveyor/net-scope.mjs';
import { runReconcilePass, defaultReadPrs, defaultReadAgents, enrichAgents, enrichPrsWithCodeQL, PR_LIST_LIMIT } from '../../scripts/conveyor/reconcile-pass.mjs'; // #4191
import { createResourceFixThrottle } from '../../scripts/lib/resource-gate.mjs'; // x6nuodj: dynamic fixer cap + host gate via admit()
import { createDispatchSinks } from '../../scripts/operations/dispatch-lane-io.mjs';
import { repoProfile } from '../../scripts/lib/repo-profile.mjs';
import { resolveFixSettings, resolveFixDispatchSettings } from '../../scripts/conveyor/fix-takeover.mjs';
import { unlinkSync, readFileSync } from 'node:fs';
import { resolveCascade } from '../../scripts/lib/policy-cascade.mjs';
import { stopSession } from '../../scripts/operations/dispatch-abort.mjs';
import { runOrphanFixRoundPass } from '../../scripts/conveyor/orphan-fix-round.mjs';
import { createStaleBaseGate } from '../../scripts/conveyor/stale-base-refresh.mjs';
import { resolveFixExecutorChain } from '../../scripts/lib/fix-executor-chain.mjs';
import { criticalWorkVerdict } from '../../scripts/lib/critical-work.mjs';
import { createFixBorrowGate, resolveFixExecutorSetting, createRoutedCiHealDispatch } from '../../scripts/lib/fix-slot-borrow.mjs'; // card 87: borrow a free builder slot
import { listBuildDispatchClaims } from '../../scripts/conveyor/build-dispatch-claim.mjs';
import { fixLauncherAvailable, fixDetachedProvider } from '../../scripts/operations/dispatch-providers/fix.mjs';
import { listFixDispatchClaims } from '../../scripts/conveyor/fix-claim-store.mjs';
import { refreshLiveFixDispatchClaims } from '../../scripts/conveyor/fix-dispatch-claim.mjs'; // dup-heal-dispatch
import { planNoteComment, postNoteComment } from '../../scripts/conveyor/reconcile-note-comment.mjs'; // #4191
import { applyReviewStatus } from '../../scripts/conveyor/review-status-tag.mjs'; // #3383 follow-up — tag at dispatch, see runTickAllRepos
import { planClaudeAuthDispatchGate } from '../../scripts/conveyor/claude-auth-health.mjs'; // card x5kagse
import { runSupersedeWatch, formatSupersedeLines } from '../../scripts/conveyor/supersede-watch.mjs'; // card xiqtf7w
import { readCompletePrComments } from '../../scripts/conveyor/pr-comments-complete.mjs';
import { excusePrMergeGateHolds } from '../../scripts/lib/merge-gate-hold-class.mjs';
import { ciGreenForEscalation, contradictingChecks, resolveCiHealVerdictSettings } from '../../scripts/conveyor/ci-heal-verdict-recheck.mjs'; // card x9zznl9
import { buildCiHealVerdictVoidComment, notCiBreakVerdictVoidState, needsHumanVoidState, latestCiHealEscalationForHead } from '../../scripts/conveyor/ci-heal-escalation-mark.mjs'; // card x9zznl9
import { getRequiredStatusChecks } from '../../scripts/lib/required-status-checks.mjs'; // card x9zznl9

/** The checkout this daemon runs from — its heavy-admission root is the host-wide `<workspace>/.lanes` one. */
const DAEMON_REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
import { sweepHungCiRecovery, sweepCiRedRecovery, sweepMissingRunRecovery, defaultReadOpenPrs, createFileApplyLedger } from '../../scripts/conveyor/ci-red-recovery-watch.mjs';
import { runRulingResolvesStandDownPass } from '../../scripts/conveyor/ruling-resolved-stand-down.mjs';
import { resolveReviewSettings, resolveReviewSettingSource } from '../../scripts/lib/review-settings.mjs';
import { CONSTELLATION_REPOS, repoKeyForSlug } from '../../scripts/lib/constellation-repos.mjs';
import { forEachRepo } from '../../scripts/lib/for-each-repo.mjs';
import { withGithubAppAuth, FLEET_APP_AUTH_OPTS } from '../../scripts/lib/github-app-auth-env.mjs';
/** Per-owner App auth: this daemon fixes PRs in every org (live 2026-10-04: plateau-app calls failed with the
 *  web-everything token pinned). */
export const FIX_DISPATCH_APP_AUTH_OPTS = FLEET_APP_AUTH_OPTS;
import { withSelfSync } from '../../scripts/lib/daemon-self-sync.mjs';
import { withPrEvents } from '../../scripts/lib/pr-events.mjs';
import { isStaleMainRefusalMessage } from '../../scripts/lib/main-staleness.mjs';
import { installDaemonLog } from './daemon-log.mjs';
import { logDaemonHeap } from '../../scripts/lib/daemon-heap-log.mjs'; // R368 per-pass heap line (`WE_DAEMON_HEAP_LOG=0` = off)
import { warmFixFacts, takeFixReadStats, formatFixReadStats } from '../../scripts/lib/fix-facts.mjs'; // perf C1d (`WE_FIX_FACTS=0` = off)

/** This daemon's own lease key — distinct from the Dispatcher's default sentinel and from the Verify
 *  daemon's own key (#3878), so none of the three ever contend on the same lock dir (#3877). */
export const RECONCILE_FIX_DISPATCH_LEASE_KEY = '<conveyor:reconcile-fix-dispatch-daemon-lease>';

/** Matches runner.mjs's own tick cadence (DEFAULT_TICK_INTERVAL_MS) — this pass ran at that rate as one of
 *  runner.mjs's mechanical passes; standing alone, there is no reason to run it faster or slower. */
export const DEFAULT_INTERVAL_MS = 120_000;

// ── PURE CORE (no IO — every effect is injected; unit-tested directly) ─────────────────────────────────────

/**
 * The daemon's whole control flow. Ticks `tickOnce` forever (or until `maxTicks`/`shouldStop`), isolating a
 * single tick's failure (logged via `onTickError`, never fatal — the same "one bad tick never kills the
 * loop" discipline runner.mjs's own `makeCliMechanicalPasses` wrapper already applies to every pass it
 * shells) so a transient `gh`/lane-pool hiccup degrades to "try again next tick", not a dead daemon. Stops
 * immediately (before sleeping) if a tick's own heartbeat reports the lease was lost — continuing to dispatch
 * without the lease would be pure waste (the ledger still refuses a stolen claim, but nothing is gained by
 * trying).
 * @param {{
 *   tickOnce: () => Promise<object>|object,
 *   sleep: (ms:number) => Promise<void>,
 *   heartbeat?: () => Promise<boolean>|boolean,
 *   onTick?: (result:object, tick:number) => void,
 *   onTickError?: (error:Error, tick:number) => void,
 *   intervalMs?: number,
 *   maxTicks?: number,
 * }} o
 * @returns {Promise<{ticks:number, stoppedReason:string}>}
 */
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

/** The repos this daemon watches each tick — mirrors we:skills-src/conveyor/review-daemon.mjs's own
 *  `REVIEW_DAEMON_REPOS`. Multi-repo slice 2 (#x1rr9rh, the ratified `#conveyor-multi-repo-model` rule, see
 *  we:reports/2026-09-23-conveyor-multi-repo-gap-map.md): before this, `tickOnce` called
 *  `runReconcileFixDispatch({})` with no repo, so a PR owed a fix in frontierui/plateau-app was never even
 *  recorded as unsupported — the daemon only ever looked at WE. Fix/CI-heal dispatch itself stays WE-only
 *  today ({@link ../../scripts/lib/repo-profile.mjs}'s `capabilities.fix`/`ciHeal` — turning them on for the
 *  couple repos is a later slice), but every repo is now actually TICKED, so the existing `unsupported-repo`
 *  refusal + ledger write run and are recorded for them instead of being skipped silently. */
export const FIX_DISPATCH_DAEMON_REPOS = Object.values(CONSTELLATION_REPOS).map((r) => r.slug);

/**
 * Run {@link runReconcileFixDispatch} once per watched repo via the shared {@link forEachRepo} helper,
 * isolating one repo's failure from the rest — the same discipline
 * we:skills-src/conveyor/review-daemon.mjs's own `runReviewTickAllRepos` already applies, extracted into
 * `forEachRepo` so both daemons share one loop.
 * @param {{repos?:string[], tick?:Function}} [o] - `tick` is injectable (defaults to the real
 *   `runReconcileFixDispatch`); every other option is forwarded to it for EVERY repo except `repo` itself,
 *   which this loop supplies per-iteration.
 * @returns {{repos:Array<{repo:string, result?:object, error?:string}>, dispatched:Array<object>,
 *   refusals:Array<object>, reconcileRefusals:Array<object>}} `reconcileRefusals` here (unlike the
 *   SAME-NAMED, differently-shaped field on a single {@link runReconcileFixDispatch} result, which is a bare
 *   count) is the per-repo-tagged ARRAY of `we:scripts/conveyor/reconcile-core.mjs#planReconcile`'s own
 *   outright refusals — a PR reconcile never even offered as a `fix`/`ci-heal` dispatch entry (#x0mn6x0, epic
 *   #4075/#3383; see `runReconcileFixDispatch`'s own `reconcileRefusalDetails` docblock for the full why).
 */
export function runReconcileFixDispatchAllRepos({ repos = FIX_DISPATCH_DAEMON_REPOS, tick = runReconcileFixDispatch,
  allowStandDownAutoProceed = resolveFixSettings().standDownAutoProceed, ...tickOpts } = {}) {
  const perRepo = forEachRepo(repos, (repo) => tick({ ...tickOpts, repo, allowStandDownAutoProceed }));
  const dispatched = [];
  const refusals = [];
  const reconcileRefusals = [];
  for (const entry of perRepo) {
    if (entry.error) {
      refusals.push({ repo: entry.repo, prNumber: null, kind: 'tick-failed', why: entry.error });
      continue;
    }
    const { repo, result } = entry;
    for (const d of (result.dispatched ?? [])) dispatched.push({ ...d, repo });
    for (const r of (result.refusals ?? [])) refusals.push({ ...r, repo });
    for (const r of (result.reconcileRefusalDetails ?? [])) reconcileRefusals.push({ ...r, repo });
  }
  return {
    repos: perRepo, dispatched, refusals, reconcileRefusals,
  };
}

/**
 * we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs#runReconcileCiHealDispatchAllRepos — #xngv3vn (epic
 * #3383/#4075): CI-HEAL HAD NO CALLER IN ANY RUNNING DAEMON. `we:scripts/operations/ci-heal-pr-dispatch.mjs
 * #runReconcileCiHealDispatch` already existed (#2666, repo-tagged in #3967 multi-repo slice 7) and already
 * reads the SAME `reconcile-core.mjs` plan this daemon's `fix` half reads (`runReconcilePass`), with its OWN
 * repo-capability gate and the SAME durable retry cap (`reconcile-core.mjs#planReconcile`'s own `ciHealCap`) —
 * but an adversarial review found nothing in the tree ever called it: a red PR opened by hand, by a sibling
 * process, or orphaned by a runner restart never got healed. This is that caller, per repo, with every existing
 * cap left exactly as `runReconcileCiHealDispatch` already enforces it (never re-derived here).
 *
 * Mirrors {@link runReconcileFixDispatchAllRepos}'s own per-repo fan-out and per-repo failure isolation, with
 * ONE necessary difference: {@link runReconcileCiHealDispatch} is `async` ({@link dispatchCiHeal} awaits its
 * dispatch sink), and the shared {@link forEachRepo} helper does not await a per-repo promise — reusing it here
 * unchanged would race every repo's dispatch concurrently and silently swallow a rejected promise as a
 * "successful" `{repo, result: <pending Promise>}` entry. So this loop awaits each repo SEQUENTIALLY instead,
 * giving the identical "one repo's failure never blocks the rest" isolation `forEachRepo` gives synchronously.
 * @param {{repos?:string[], tick?:Function}} [o] - `tick` is injectable (defaults to the real
 *   `runReconcileCiHealDispatch`); every other option is forwarded to it for EVERY repo except `repo` itself.
 * @returns {Promise<{repos:Array<{repo:string, result?:object, error?:string}>, dispatched:Array<object>,
 *   refusals:Array<object>, reconcileRefusals:Array<object>}>} `reconcileRefusals` — see
 *   {@link runReconcileFixDispatchAllRepos}'s own identical field for the shape and the why (#x0mn6x0, epic
 *   #4075/#3383).
 */
export async function runReconcileCiHealDispatchAllRepos({ repos = FIX_DISPATCH_DAEMON_REPOS, tick = runReconcileCiHealDispatch, ...tickOpts } = {}) {
  const perRepo = [];
  for (const repo of repos) {
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential by design (see this fn's own docblock): one
      // repo's ci-heal tick must finish (or fail) before the next repo's is attempted, so a rejection is
      // captured per repo instead of racing every repo's dispatch concurrently.
      const result = await tick({ ...tickOpts, repo });
      perRepo.push({ repo, result });
    } catch (e) {
      perRepo.push({ repo, error: String((e && e.message) || e).split('\n')[0] });
    }
  }
  const dispatched = [];
  const refusals = [];
  const reconcileRefusals = [];
  for (const entry of perRepo) {
    if (entry.error) {
      refusals.push({ repo: entry.repo, prNumber: null, kind: 'tick-failed', why: entry.error });
      continue;
    }
    const { repo, result } = entry;
    for (const d of (result.dispatched ?? [])) dispatched.push({ ...d, repo });
    for (const r of (result.refusals ?? [])) refusals.push({ ...r, repo });
    for (const r of (result.reconcileRefusalDetails ?? [])) reconcileRefusals.push({ ...r, repo });
  }
  return {
    repos: perRepo, dispatched, refusals, reconcileRefusals,
  };
}

/**
 * we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs#runPromoteDraftDispatchAllRepos — draft-first PRs
 * (operator-approved 2026-09-27): `we:scripts/operations/promote-draft-pr-dispatch.mjs#runReconcilePromoteDraftDispatch`
 * (`gh pr ready` on a draft whose required checks are all green) was originally wired ONLY into
 * `we:skills-src/conveyor/runner.mjs` — the headless conveyor runner. A same-day review caught that runner has
 * NO LIVE SINGLETON LEASE on this host today (confirmed by a separate trial worker) — live are only THIS
 * daemon, the Review daemon, and the drain — so, as first shipped, every agent PR would open draft, get its
 * review refused while draft ({@link runReconcileCiHealDispatch}'s own sibling
 * `we:scripts/conveyor/reconcile-core.mjs#dispatchReviewRow` isDraft gate), and then sit forever: nothing live
 * ever called the ONE thing that un-drafts it. This rides THIS daemon instead — mirrors
 * {@link runHungCiRecoveryAllRepos}'s own precedent exactly (that docblock's own words: "this pass rides the
 * ONE daemon already confirmed live and ticking… rather than touch launchd (a separate operational action, not
 * a code change)"), for the identical reason.
 *
 * UNPAUSED BY THE CLAUDE-AUTH GATE, DELIBERATELY (see {@link runTickAllRepos}'s own call site) — `gh pr ready`
 * spawns no Claude session at all, so a broken operator login (card x5kagse) must never hold a green draft
 * hostage the way it correctly holds `fix`/`ci-heal` (which DO spawn a session) — same reasoning
 * `hungCi`/`mainRedRebase`/`missingRun` already document for themselves.
 *
 * The runner.mjs wiring is LEFT IN PLACE (harmless — if that runner's lease is ever live again, both sides are
 * simply idempotent no-ops on whatever the other already promoted).
 * @param {{repos?:string[], tick?:Function}} [o] - `tick` is injectable (defaults to the real
 *   `runReconcilePromoteDraftDispatch`); every other option is forwarded to it for EVERY repo except `repo` itself.
 * @returns {{repos:Array<{repo:string, result?:object, error?:string}>, dispatched:Array<object>,
 *   refusals:Array<object>, reconcileRefusals:Array<object>}} same shape as
 *   {@link runReconcileCiHealDispatchAllRepos}'s own return, repo-tagged the same way.
 */
export function runPromoteDraftDispatchAllRepos({ repos = FIX_DISPATCH_DAEMON_REPOS, tick = runReconcilePromoteDraftDispatch, ...tickOpts } = {}) {
  const perRepo = forEachRepo(repos, (repo) => tick({ ...tickOpts, repo }));
  const dispatched = [];
  const refusals = [];
  const reconcileRefusals = [];
  for (const entry of perRepo) {
    if (entry.error) {
      // Prefixed so the whole-pass tick-failed line names THIS half (the fix half's own per-repo error line
      // would otherwise read identically and hide that the promote half failed too).
      refusals.push({ repo: entry.repo, prNumber: null, kind: 'tick-failed', why: `promote-draft half: ${entry.error}` });
      continue;
    }
    const { repo, result } = entry;
    for (const d of (result.dispatched ?? [])) dispatched.push({ ...d, repo });
    for (const r of (result.refusals ?? [])) refusals.push({ ...r, repo });
    for (const r of (result.reconcileRefusalDetails ?? [])) reconcileRefusals.push({ ...r, repo });
  }
  return {
    repos: perRepo, dispatched, refusals, reconcileRefusals,
  };
}

/**
 * we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs#defaultReadNotesForRepo — #4191 (epic #4075/#3383):
 * "reconcile-core.mjs#planReconcile emits `notes` (`ci-heal-exhausted`, `awaiting-permission`) that nothing
 * downstream reads" — NEITHER `runReconcileFixDispatch` (`we:scripts/conveyor/reconcile-fix-dispatch.mjs`) NOR
 * `runReconcileCiHealDispatch` (`we:scripts/operations/ci-heal-pr-dispatch.mjs`) forwards its own
 * `reconciled.notes` out of their return shape (both already forward `reconciled.refusals` as
 * `reconcileRefusalDetails` — see either one's own docblock — `notes` was simply never added alongside it). This
 * card's own file scope deliberately does NOT touch either of those two files (both are actively owned by other
 * in-flight cards this same epic runs concurrently — see the delivery plan's file-ownership table), so rather
 * than thread a new field through either one's return shape, this is a THIRD, independent, per-repo call to
 * {@link runReconcilePass} — the SAME pure `planReconcile` plan both of those files already read, unchanged, no
 * new export. The only addition here is capturing the raw PR list `readPrs` already fetches, keyed by PR
 * number, so the comment-episode dedup below (`we:scripts/conveyor/reconcile-note-comment.mjs#planNoteComment`)
 * can read each note's own PR's `comments` without a FOURTH gh round-trip.
 * @param {{repo:string, reconcile?:Function, readPrs?:Function}} o
 * @returns {{notes:Array<object>, prsByNumber:Map<number,object>}}
 */
export function defaultReadNotesForRepo({ repo, reconcile = runReconcilePass, readPrs = defaultReadPrs, excuseMergeGateHolds = excusePrMergeGateHolds, enrichCodeQL = enrichPrsWithCodeQL } = {}) {
  let capturedPrs = [];
  const result = reconcile({
    repo,
    readPrs: (o) => { capturedPrs = readPrs(o); return capturedPrs; },
    // Retain hydrated, excused rows: the original read remains red for candidacy/freeze holds.
    excuseMergeGateHolds: (prs, options) => {
      capturedPrs = excuseMergeGateHolds(prs, options);
      return capturedPrs;
    },
    // CodeQL is enriched after the rollup: keep its non-required drain hold for the void recheck too.
    enrichCodeQL: (prs, options) => {
      capturedPrs = enrichCodeQL(prs, options);
      return capturedPrs;
    },
  });
  return {
    notes: Array.isArray(result?.notes) ? result.notes : [],
    prsByNumber: new Map((Array.isArray(capturedPrs) ? capturedPrs : []).map((pr) => [pr.number, pr])),
  };
}

/**
 * Notes are the visible explanation for a refused PR, so production posts by default.
 * An explicit WE_CONVEYOR_POST_NOTE_COMMENTS=0 retains the diagnostic dry-run mode.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function defaultNoteCommentDryRun(env = process.env) {
  return env?.WE_CONVEYOR_POST_NOTE_COMMENTS === '0';
}

/** Apply the shared park decision through gh, resolving a constellation key to its slug. */
export function defaultParkToHuman({ repo, pr, addLabel, removeLabels, exec = execFileSync }) {
  const args = ['pr', 'edit', String(pr), '--repo', CONSTELLATION_REPOS[repo]?.slug ?? repo, '--add-label', addLabel];
  for (const label of removeLabels) args.push('--remove-label', label);
  try {
    exec('gh', args, {
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).split('\n')[0] };
  }
}

/**
 * we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs#runReconcileNotesAllRepos — fan out
 * {@link defaultReadNotesForRepo} over every watched repo (mirrors {@link runReconcileFixDispatchAllRepos}'s own
 * per-repo isolation via {@link forEachRepo}), then plan — and, unless `dryRun`, actually post — exactly ONE
 * durable PR comment per note episode ({@link planNoteComment}, `we:scripts/conveyor/reconcile-note-comment.mjs`)
 * that a trusted principal has not already posted. `dryRun` defaults to {@link defaultNoteCommentDryRun}'s own
 * env-gated answer. Parking retries even after the comment was posted; diagnostic callers may pass `dryRun: true` explicitly.
 * @param {{repos?:string[], tick?:Function, postComment?:Function, parkToHuman?:Function, dryRun?:boolean}} [o]
 * @returns {{repos:Array<object>, notes:Array<object>, refusals:Array<object>, comments:Array<object>}}
 *   `comments` — one row per note this tick saw, `{repo, prNumber, kind, key, body?, alreadyPosted, posted,
 *   dryRun, error?, parked?, parkError?}` (`body` is present only when a comment was newly planned — omitted once `alreadyPosted`,
 *   nothing new to show).
 */
let loggedNeedsHumanVoidSetting = false;

export function runReconcileNotesAllRepos({
  repos = FIX_DISPATCH_DAEMON_REPOS, tick = defaultReadNotesForRepo, postComment = postNoteComment, parkToHuman = defaultParkToHuman,
  publish = publishAttention, safety = resolveFixSafety(), autoRoundGrant = defaultAutoRoundGrant, stuckAfterGrant = defaultStuckAfterGrant,
  dryRun = defaultNoteCommentDryRun(), verdictSettings = resolveCiHealVerdictSettings(), readRequiredChecks = defaultReadRequiredChecks,
  deadlineAt, cursor, now = Date.now,
  ...tickOpts
} = {}) {
  process.stderr.write(`policy · fix.alertAtRoundCap=${safety.value.alertAtRoundCap} (${safety.sources.alertAtRoundCap})\n`);
  if (!loggedNeedsHumanVoidSetting) {
    process.stderr.write(`ciHealVerdict.voidNeedsHumanWhenCiGreen=${verdictSettings.voidNeedsHumanWhenCiGreen ? 'on' : 'off'} source=${verdictSettings.voidNeedsHumanSource ?? 'caller'}\n`);
    loggedNeedsHumanVoidSetting = true;
  }
  const perRepo = [];
  let handled = 0, deferred = [], deadlineSkipped = false;
  const pastDeadline = () => deadlineAt != null && now() > deadlineAt;
  // Discover one repo at a time: an overrun must not start the next blocking read.
  function* readRepos() {
    for (const repo of repos) {
      if (pastDeadline()) {
        deferred = cursor == null ? [] : [cursor];
        deadlineSkipped = true;
        return;
      }
      const [entry] = forEachRepo([repo], repo => tick({ ...tickOpts, repo,
        ...(deadlineAt != null || cursor != null ? { deadlineAt, cursor, now } : {}) }));
      perRepo.push(entry);
      yield entry;
    }
  }
  const notes = [];
  const refusals = [];
  const comments = [];
  const autoGrants = [];
  for (const entry of readRepos()) {
    if (entry.error) {
      refusals.push({ repo: entry.repo, prNumber: null, kind: 'tick-failed', why: entry.error });
      continue;
    }
    const { repo, result } = entry;
    const prsByNumber = result?.prsByNumber ?? new Map();
    if (result?.deadlineSkipped) deadlineSkipped = true;
    let repoNotes = result?.notes ?? [];
    if (cursor != null) {
      const start = repoNotes.findIndex(note => note.prNumber === cursor);
      if (start > 0) repoNotes = [...repoNotes.slice(start), ...repoNotes.slice(0, start)];
    }
    let repoHandled = 0;
    // PRs whose cap note a grant made moot (this pass's own, another worker's, or one being decided right now).
    const graceNotes = new Set();
    for (const n of repoNotes) {
      if (pastDeadline()) {
        deferred = repoNotes.slice(repoHandled).map(note => note.prNumber);
        break;
      }
      repoHandled += 1;
      handled += 1;
      const tagged = { ...n, repo };
      notes.push(tagged);
      const pr = prsByNumber.get(n.prNumber);
      // The operator's standing ruling (2026-10-19, confirmed 2026-10-20): a card-only PR at its round cap gets +1
      // round automatically, capped per PR (we:scripts/conveyor/auto-round-grant.mjs). A grant raises the cap, so
      // this note, its comment, its parking and its needs-you event are all moot; anything else falls through.
      let autoGrant = null;
      if (!dryRun && pr && n.kind === 'round-cap-exhausted') {
        try { autoGrant = autoRoundGrant({ repo, note: n, pr }); }
        catch (e) { autoGrant = { action: 'failed', why: redactedFirstLine(e) }; }
        if (autoGrant) {
          autoGrants.push({ repo, prNumber: n.prNumber, ...autoGrant });
          process.stderr.write(`auto-round-grant ${repo}#${n.prNumber}: ${autoGrant.action}${autoGrant.why ? ` — ${redactedFirstLine(autoGrant.why)}` : ''}${autoGrant.count ? ` (${autoGrant.count}/${autoGrant.max})` : ''}\n`);
          // A stale note (another worker already granted this limit hit, or is deciding it now) parks and alerts nothing.
          if (['granted', 'already-granted', 'deferred'].includes(autoGrant.action)) { graceNotes.add(n.prNumber); continue; }
        }
      }
      if (!dryRun && safety.value.alertAtRoundCap && ['round-cap-exhausted', 'ci-heal-exhausted', 'ruling-dispute', 'ci-heal-escalated'].includes(n.kind)) {
        try { publish({ repo: CONSTELLATION_REPOS[repo]?.slug ?? repo, pr: n.prNumber,
          head: pr?.headRefOid ?? '', kind: ['round-cap-exhausted', 'ci-heal-exhausted'].includes(n.kind) ? 'at-round-limit' : 'escalated',
          reason: autoGrant?.action === 'cap-reached' ? autoGrant.reason : n.text }); }
        catch (e) { process.stderr.write(`needs-you publication failed: ${e.message}\n`); }
      }
      // card x9zznl9 (live #4535) — a `not-a-ci-break` verdict a required check has since contradicted is voided
      // (once per VERDICT — a later verdict on the same head owes its own void, up to MAX_VERDICT_VOIDS_PER_HEAD) instead
      // of telling the operator it needs a decision; the ordinary ci-heal path resumes.
      const voidRow = n.kind === 'ci-heal-escalation-moot'
        ? planNeedsHumanVoid({ note: n, pr, repo, verdictSettings, readRequiredChecks })
        : planVerdictVoid({ note: n, pr, repo, verdictSettings, readRequiredChecks });
      if (voidRow) {
        if (voidRow.alreadyPosted || dryRun) { comments.push({ ...voidRow, posted: false, dryRun }); continue; }
        const outcome = postComment({ repo, pr: n.prNumber, body: voidRow.body });
        comments.push({ ...voidRow, posted: !!outcome.ok, dryRun: false, ...(outcome.ok ? {} : { error: outcome.error }) });
        continue;
      }
      if (n.kind === 'ci-heal-escalation-moot') continue; // internal signal, never an operator note
      const plan = planNoteComment(tagged, pr?.comments);
      // Parking retries independently of the one-comment-per-episode dedup.
      const parking = n.parkToHuman ? { parked: false } : {};
      const labels = (pr?.labels ?? []).map((label) => typeof label === 'string' ? label : label.name);
      if (n.parkToHuman && pr && !dryRun && !labels.includes('review:human')) {
        const decision = decideParkToHuman({ currentLabels: labels });
        try {
          const outcome = parkToHuman({ repo, pr: n.prNumber, addLabel: decision.addLabel,
            removeLabels: decision.removeLabels.filter((label) => labels.includes(label)) });
          parking.parked = !!outcome.ok;
          if (!outcome.ok) parking.parkError = outcome.error;
        } catch (e) {
          parking.parkError = String(e?.message ?? e).split('\n')[0];
        }
      }
      if (plan.alreadyPosted) {
        comments.push({
          repo, prNumber: n.prNumber, kind: n.kind, key: plan.key, ...parking, alreadyPosted: true, posted: false, dryRun,
        });
        continue;
      }
      if (dryRun) {
        comments.push({
          repo, prNumber: n.prNumber, kind: n.kind, key: plan.key, ...parking, body: plan.body, alreadyPosted: false, posted: false, dryRun: true,
        });
        continue;
      }
      const outcome = postComment({ repo, pr: n.prNumber, body: plan.body });
      comments.push({
        repo,
        prNumber: n.prNumber,
        kind: n.kind,
        key: plan.key,
        ...parking,
        body: plan.body,
        alreadyPosted: false,
        posted: !!outcome.ok,
        dryRun: false,
        ...(outcome.ok ? {} : { error: outcome.error }),
      });
    }
    // Never silently stuck after an automatic grant: a PR still at its round limit well after one gets its
    // needs-you event (published even though the grant's own pass suppressed it; the feed dedups per head). A PR
    // whose note a grant made moot is checked too, so a suppressed stale note can never hide a stuck PR.
    if (deferred.length) break;
    if (!dryRun && safety.value.alertAtRoundCap) {
      const noted = new Set((result?.notes ?? []).map((n) => n.prNumber).filter((number) => !graceNotes.has(number)));
      for (const pr of prsByNumber.values()) {
        if (noted.has(pr?.number)) continue;
        let reason = null;
        try { reason = stuckAfterGrant({ repo, pr }); } catch (e) { reason = null; process.stderr.write(`auto-round-grant stuck check ${repo}#${pr?.number}: ${redactedFirstLine(e)}\n`); }
        if (!reason) continue;
        autoGrants.push({ repo, prNumber: pr.number, action: 'stuck', why: reason });
        process.stderr.write(`auto-round-grant ${repo}#${pr.number}: stuck — ${reason}\n`);
        try { publish({ repo: CONSTELLATION_REPOS[repo]?.slug ?? repo, pr: pr.number, head: pr.headRefOid ?? '', kind: 'at-round-limit', reason }); }
        catch (e) { process.stderr.write(`needs-you publication failed: ${redactedFirstLine(e)}\n`); }
      }
    }
  }
  return { handled, deferred, nextCursor: deferred[0] ?? null, ...(deadlineSkipped ? { deadlineSkipped: true } : {}),
    repos: perRepo, notes, refusals, comments, autoGrants };
}

/** The repo's live required-check set (branch protection, cached) — the SAME reader `reconcile-pass.mjs` uses. */
export function defaultReadRequiredChecks({ repo }) {
  return getRequiredStatusChecks({ repo: CONSTELLATION_REPOS[repo]?.slug ?? repo }).checks;
}

/** card x9zznl9 — most verdicts one head may have voided before the verdict stands for an operator to decide. */
export const MAX_VERDICT_VOIDS_PER_HEAD = 3;

/**
 * card x9zznl9 — should this note's `not-a-ci-break` verdict be voided? Returns the comment row to post (or already
 * posted for this head), or `null` to handle the note normally. Pure apart from the injected required-check read.
 */
export function planVerdictVoid({ note, pr, repo, verdictSettings, readRequiredChecks }) {
  if (!verdictSettings?.recheckNotCiBreak || note?.kind !== 'ci-heal-escalated' || note?.outcome !== 'not-a-ci-break' || !pr) return null;
  // Cheap pre-filter first: with no failing run other than review-gate on the PR at all, nothing can contradict the
  // verdict, so the required-check set is never read.
  const anyRed = contradictingChecks({
    escalation: { outcome: note.outcome, headSha: note.headSha }, headSha: pr.headRefOid, rollup: pr.statusCheckRollup,
    requiredChecks: [...new Set((pr.statusCheckRollup ?? []).map((r) => r?.name ?? r?.context).filter(Boolean))],
  });
  if (!anyRed.length) return null;
  let requiredChecks = [];
  try { requiredChecks = readRequiredChecks({ repo }) ?? []; } catch { return null; }
  const red = contradictingChecks({
    escalation: { outcome: note.outcome, headSha: note.headSha }, headSha: pr.headRefOid, rollup: pr.statusCheckRollup, requiredChecks,
  });
  if (!red.length) return null;
  const head = String(note.headSha).toLowerCase();
  // A head can carry several verdicts (ci-heal records a new one after a re-run): owed once per VERDICT, not per head.
  const { verdictIndex, voided, voidCount } = notCiBreakVerdictVoidState(pr.comments, head);
  const row = { repo, prNumber: note.prNumber, kind: 'ci-heal-verdict-void', key: `ci-heal-verdict-void:${note.prNumber}:${head}:${verdictIndex}` };
  if (voided) return { ...row, alreadyPosted: true };
  // A check that flips green/red forever would grow the thread by two comments a cycle: past the cap the verdict
  // stands, and the ordinary note tells the operator this head needs a decision.
  if (voidCount >= MAX_VERDICT_VOIDS_PER_HEAD) return null;
  return { ...row, alreadyPosted: false, body: buildCiHealVerdictVoidComment({ headSha: head, red }) };
}

/** Reverify a green-head retirement and plan its durable void, once per escalation and bounded per head. */
export function planNeedsHumanVoid({ note, pr, repo, verdictSettings, readRequiredChecks }) {
  if (!verdictSettings?.voidNeedsHumanWhenCiGreen || note?.kind !== 'ci-heal-escalation-moot'
      || note.outcome !== 'needs-human' || !pr || pr.codeqlFailure) return null;
  const head = String(note.headSha ?? '').trim().toLowerCase();
  if (!head || head !== String(pr.headRefOid ?? '').trim().toLowerCase()
      || String(pr.state ?? 'OPEN').toUpperCase() !== 'OPEN'
      || String(pr.mergeStateStatus ?? '').toUpperCase() === 'DIRTY') return null;
  // Read the underlying escalation even after a void, so retries report alreadyPosted.
  const escalation = latestCiHealEscalationForHead(pr.comments, head, {
    baseHead: pr.escalationBaseHead ?? null, recheck: verdictSettings.recheckNotCiBreak, voidNeedsHuman: false,
  });
  if (escalation?.outcome !== 'needs-human') return null;
  const { escalationIndex, voided, voidCount } = needsHumanVoidState(pr.comments, head);
  const row = { repo, prNumber: note.prNumber, kind: 'ci-heal-needs-human-void',
    key: `ci-heal-needs-human-void:${note.prNumber}:${head}:${escalationIndex}` };
  if (voided) return { ...row, alreadyPosted: true };
  if (voidCount >= MAX_VERDICT_VOIDS_PER_HEAD) return null;
  let requiredChecks;
  try { requiredChecks = readRequiredChecks({ repo }); } catch { return null; }
  if (!ciGreenForEscalation({ rollup: pr.statusCheckRollup, requiredChecks })) return null;
  return { ...row, alreadyPosted: false,
    body: buildCiHealVerdictVoidComment({ headSha: head, voids: 'needs-human', cause: 'required-ci-green' }) };
}

/**
 * card xiqtf7w — the supersede half: per repo, hold (stand down + label) every open PR a merged PR declares it
 * supersedes. Runs BEFORE the fix/ci-heal halves so the hold is on the thread before they plan. Never throws.
 */
export function runSupersedeAllRepos({ repos = FIX_DISPATCH_DAEMON_REPOS, tick = runSupersedeWatch, ...tickOpts } = {}) {
  return { repos: repos.map((repo) => {
    try { return tick({ ...tickOpts, repo }); } catch (e) { return { repo, holds: [], applied: [], error: String(e?.message || e).split('\n')[0] }; }
  }) };
}

/**
 * #3383 bug 1 — did this tick's own result show it hit `assertMainNotStale`'s refusal for at least one repo?
 * (see `runReconcileFixDispatchAllRepos`: a whole-repo tick failure — including the stale-main refusal thrown
 * near the top of `runReconcileFixDispatch` — lands in `refusals` as `{repo, prNumber:null, kind:'tick-failed',
 * why:<message>}`.) Wired into `withSelfSync`'s `hasStaleRefusal` option so the daemon re-syncs immediately
 * instead of wasting the full interval on a race it will otherwise keep losing. Pure — takes the tick result,
 * no IO of its own.
 * @param {{refusals?:Array<{kind?:string, why?:string}>}} tickResult
 * @returns {boolean}
 */
export function hasStaleMainRefusal(tickResult) {
  return (tickResult?.refusals ?? []).some((r) => r && r.kind === 'tick-failed' && isStaleMainRefusalMessage(r.why));
}

// ── IO SHELL (runs only as a CLI — owns the real lease + the real dispatch pass) ─────────────────────────────

// #3870 LIVE-CAUGHT BUG: `.unref()`-ing this timer told Node it was fine to exit before it fired — with
// nothing else keeping the event loop alive between ticks (the spawned agent's own stdio is `ignore`d, no
// other ref'd handle exists), the daemon exited right after its FIRST tick instead of waiting and looping.
// A REF'd timer (Node's default — no `.unref()`) is exactly what a resident daemon needs: the sleep IS the
// reason this process stays alive between ticks, not incidental background bookkeeping safe to drop on exit.
export function realSleep(ms) { return new Promise((resolve) => { setTimeout(resolve, ms); }); }

/**
 * we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs#runHungCiRecoveryAllRepos — xd1sfms (epic
 * #4075/#3383): `we:scripts/conveyor/ci-red-recovery-watch.mjs#sweepHungCiRecovery` (the hung-CI-run
 * cancel+rerun pass — see that file's own header, and `we:scripts/conveyor/main-red-recovery.mjs`'s "HUNG-CI-
 * RUN RECOVERY" section, for the #2636 incident this exists to fix) IS already registered per-repo in
 * `we:skills-src/conveyor/daemon-manifest.mjs` (`ci-red-recovery-watch-<repo>`, wired onto `pass-daemon.mjs`)
 * — but, LIVE-CONFIRMED 2026-09-25, NO launchd job installs `pass-daemon.mjs` for that entry (only an
 * `.example` plist exists under `we:skills-src/conveyor/launchd/`), so nothing has ever actually invoked it.
 * Rather than touch launchd (out of scope for this card, and a separate operational action, not a code
 * change), this pass rides the ONE daemon already confirmed live and ticking on every watched repo —
 * `reconcile-fix-dispatch-daemon.mjs` itself, the exact daemon whose own tick logged `nothing-owed` for #2636
 * throughout its 3h+ hang. Mirrors {@link runReconcileFixDispatchAllRepos}'s own per-repo fan-out and
 * per-repo failure isolation (via {@link forEachRepo}) — one repo's sweep failure never blocks the rest.
 * `apply: true` always (a daemon's whole point is to actually act once a candidate clears the pass's own
 * idempotent cap — the durable per-sha comment-count floor `sweepHungCiRecovery` already enforces makes this
 * safe to run unconditionally on the default cadence, the same "efficiency no-op, not a safety refusal" trade
 * every sibling pass-daemon entry in `daemon-manifest.mjs` already documents for itself).
 * @param {{repos?:string[], tick?:Function}} [o] - `tick` is injectable (defaults to the real
 *   `sweepHungCiRecovery`); every other option is forwarded to it for EVERY repo except `repo` itself.
 * @returns {{repos:Array<{repo:string, result?:object, error?:string}>, dispatched:Array<object>,
 *   refusals:Array<object>}} `dispatched`/`refusals` here are the pass's own `applied`/`dispatch`+`refusals`
 *   rows, repo-tagged the same way {@link runReconcileFixDispatchAllRepos} tags its own.
 */
export function runHungCiRecoveryAllRepos({ repos = FIX_DISPATCH_DAEMON_REPOS, tick = sweepHungCiRecovery, ...tickOpts } = {}) {
  const perRepo = forEachRepo(repos, (repo) => tick({ ...tickOpts, repo, apply: true }));
  const dispatched = [];
  const refusals = [];
  for (const entry of perRepo) {
    if (entry.error) {
      refusals.push({ repo: entry.repo, prNumber: null, kind: 'tick-failed', why: entry.error });
      continue;
    }
    const { repo, result } = entry;
    // a hung candidate this tick actually acted on (cancel+rerun OR cancel-only attempted, whether or not it
    // succeeded) — `applied` rows carry their own `ok`, so a failed attempt still shows up (never silently
    // dropped). Prefers the row's OWN `kind` (the plan's real classification — `hung-cancel-rerun` or
    // `repeat-hang`, xd1sfms follow-up) over the old ok/action heuristic, which a fixture supplying no `kind`
    // (an older test double) still falls back to.
    for (const a of (result.applied ?? [])) dispatched.push({ ...a, repo, kind: a.kind ?? (a.ok ? 'hung-cancel-rerun' : `hung-${a.action}`) });
    for (const r of (result.refusals ?? [])) if (r.kind !== 'not-hung') refusals.push({ ...r, repo });
  }
  return { repos: perRepo, dispatched, refusals };
}

/**
 * we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs#runMainRedRebaseAllRepos — x5uqim1 follow-up (epic
 * #4075/#3383), 2026-09-25 18:52 ET LIVE INCIDENT: PR #2685 logged `reconcile-refused owed-ci-rerun` on EVERY
 * tick of THIS daemon ("owed a mechanical rebase onto main … once main has recovered") while nothing in any
 * running process ever performed that rebase. `we:scripts/conveyor/ci-red-recovery-watch.mjs#sweepCiRedRecovery`
 * already implements the real write (via `we:scripts/lib/rebase-drop-manifest.mjs#rebaseDropManifest`, the SAME
 * proven, no-checkout plumbing the drain itself uses) and is already registered per-repo in
 * `we:skills-src/conveyor/daemon-manifest.mjs` (`ci-red-recovery-watch-<repo>`) — but, live-confirmed exactly
 * like {@link runHungCiRecoveryAllRepos}'s own docblock found for the hung-CI half of this same file, NO
 * launchd job installs `pass-daemon.mjs` for that entry (only an `.example` plist exists under
 * `we:skills-src/conveyor/launchd/`). Rather than touch launchd (out of scope for this card — an operational
 * action, not a code change), this rides the SAME already-live daemon the hung-CI half already rides. Mirrors
 * {@link runHungCiRecoveryAllRepos}'s own per-repo fan-out, failure isolation, and `apply: true` always
 * (`sweepCiRedRecovery`'s own idempotent `already-current` short-circuit, plus the new
 * `we:scripts/conveyor/main-red-recovery.mjs#DEFAULT_MAX_REBASE_RETRIES_PER_SHA` cap, make this safe to run
 * unconditionally on the default cadence — the same "efficiency no-op, not a safety refusal" trade every
 * sibling pass-daemon entry in `daemon-manifest.mjs` already documents for itself).
 * @param {{repos?:string[], tick?:Function}} [o] - `tick` is injectable (defaults to the real
 *   `sweepCiRedRecovery`); every other option is forwarded to it for EVERY repo except `repo` itself.
 * @returns {{repos:Array<{repo:string, result?:object, error?:string}>, dispatched:Array<object>,
 *   refusals:Array<object>}} `dispatched`/`refusals` here are the pass's own `applied`/`dispatch`+`refusals`
 *   rows, repo-tagged the same way {@link runHungCiRecoveryAllRepos} tags its own.
 */
export function runMainRedRebaseAllRepos({ repos = FIX_DISPATCH_DAEMON_REPOS, tick = sweepCiRedRecovery, createLedger = createFileApplyLedger, ...tickOpts } = {}) {
  // This daemon is the only live caller: without a per-repo file-backed fairness ledger the budget-capped apply
  // loop restarts at the head of the queue every tick and slow/deferred PRs starve later recoverable ones.
  // Built inside the per-repo callback so a ledger construction failure is isolated to that repo (tick-failed).
  const perRepo = forEachRepo(repos, (repo) => tick({ ...tickOpts, repo, apply: true, applyLedger: tickOpts.applyLedger ?? createLedger({ repo }) }));
  const dispatched = [];
  const refusals = [];
  for (const entry of perRepo) {
    if (entry.error) {
      refusals.push({ repo: entry.repo, prNumber: null, kind: 'tick-failed', why: entry.error });
      continue;
    }
    const { repo, result } = entry;
    for (const a of (result.applied ?? [])) dispatched.push({ ...a, repo, kind: 'rebase-onto-main' });
    for (const r of (result.refusals ?? [])) refusals.push({ ...r, repo });
  }
  return { repos: perRepo, dispatched, refusals };
}

/**
 * we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs#runMissingRunRecoveryAllRepos — xi4od2p (epic
 * #4075/#3383), LIVE INCIDENT 2026-09-26: PR web-everything/web-everything#2729 sat `review:accepted` + `MERGEABLE`
 * but `BLOCKED`, labelled `checking`, because its head never got a required-check run queued AT ALL — a THIRD,
 * disjoint population from the `hungCi`/`mainRedRebase` halves below (see
 * `we:scripts/conveyor/main-red-recovery.mjs`'s own "MISSING-CI-RUN RECOVERY" section for the full incident and
 * why neither existing pass sees it). `we:scripts/conveyor/ci-red-recovery-watch.mjs#sweepMissingRunRecovery`
 * implements the real writes (prefer a `rebaseDropManifest` refresh onto `main` when behind it, else `gh workflow
 * run`, plus clearing the stale `checking` label once a trigger actually succeeded) and is already registered per-repo in
 * `we:skills-src/conveyor/daemon-manifest.mjs` (`ci-red-recovery-watch-<repo>`, same CLI entry point as its two
 * siblings, per that file's own "same sweep invocation" comment) — but, mirroring EXACTLY the reason
 * {@link runHungCiRecoveryAllRepos}/{@link runMainRedRebaseAllRepos} both ride THIS daemon instead of that
 * `daemon-manifest.mjs` entry (no launchd job installs `pass-daemon.mjs` for it — only an `.example` plist
 * exists), this rides the SAME already-live daemon too. Mirrors {@link runMainRedRebaseAllRepos}'s own per-repo
 * fan-out, failure isolation, and `apply: true` always (`sweepMissingRunRecovery`'s own idempotent per-sha
 * comment-count cap, `we:scripts/conveyor/main-red-recovery.mjs#DEFAULT_MAX_MISSING_RUN_RETRIES_PER_SHA`, makes
 * this safe to run unconditionally on the default cadence — the same "efficiency no-op, not a safety refusal"
 * trade every sibling pass-daemon entry in `daemon-manifest.mjs` already documents for itself).
 * @param {{repos?:string[], tick?:Function}} [o] - `tick` is injectable (defaults to the real
 *   `sweepMissingRunRecovery`); every other option is forwarded to it for EVERY repo except `repo` itself.
 * @returns {{repos:Array<{repo:string, result?:object, error?:string}>, dispatched:Array<object>,
 *   refusals:Array<object>}} `dispatched`/`refusals` here are the pass's own `applied`/`dispatch`+`refusals`
 *   rows, repo-tagged the same way {@link runMainRedRebaseAllRepos} tags its own.
 */
export function runMissingRunRecoveryAllRepos({ repos = FIX_DISPATCH_DAEMON_REPOS, tick = sweepMissingRunRecovery, ...tickOpts } = {}) {
  const perRepo = forEachRepo(repos, (repo) => tick({ ...tickOpts, repo, apply: true }));
  const dispatched = [];
  const refusals = [];
  for (const entry of perRepo) {
    if (entry.error) {
      refusals.push({ repo: entry.repo, prNumber: null, kind: 'tick-failed', why: entry.error });
      continue;
    }
    const { repo, result } = entry;
    for (const a of (result.applied ?? [])) dispatched.push({ ...a, repo, kind: 'trigger-ci' });
    for (const r of (result.refusals ?? [])) if (r.kind !== 'not-overdue') refusals.push({ ...r, repo });
  }
  return { repos: perRepo, dispatched, refusals };
}

/** How long (ms) a pass-local reconcile plan may be reused. Older than this, the next phase recomputes. */
export const RECONCILE_PLAN_MAX_AGE_MS = 15 * 60 * 1000;

/** Key (not a PR number) under which the probe records main's CI state. */
const MAIN_STATE_KEY = 'main-ci-state';

/** Stable per-PR fingerprint of everything a phase's decision reads live: head, draft, merge state, labels, check state, last activity. */
function prFingerprint(pr) {
  const checks = (pr.statusCheckRollup ?? []).map((c) => [c?.name ?? c?.context ?? null, c?.workflowName ?? null, c?.status ?? c?.state ?? null,
    c?.conclusion ?? null, c?.completedAt ?? c?.startedAt ?? null]).map((row) => JSON.stringify(row)).sort();
  return JSON.stringify([pr.headRefOid, pr.isDraft, pr.mergeStateStatus ?? null, (pr.labels ?? []).map((l) => l?.name ?? l).sort(), checks, pr.updatedAt]);
}

/**
 * The planner's OWN discovery read: it must be taken AFTER the baseline probe, so it may not use the host-shared PR snapshot
 * (valid ~75 s). It used to force that with a WRAPPER `exec`, which also knocked it off the production path and made it run
 * the heavy 200-row `gh pr list` (HTTP 504, 23 failed ticks, ci-heals unplanned, 2026-11-03). `fresh: true` skips the snapshot
 * but keeps the small-page read, the 5xx retry and the fail-closed / deferred contract.
 */
export const planFreshReadPrs = (read) => (o = {}) => read({ ...o, fresh: true, attributionRepo: o.attributionRepo ?? o.repo });

/**
 * Default live probe for plan reuse: one light open-PR list per repo, read DIRECTLY from GitHub. It must never use the
 * host-shared PR snapshot (valid for ~75 s): that could hide a stand-down comment posted after the plan was made.
 * Throws when a row lacks `updatedAt`, so the cache fails closed to a full recompute.
 */
export function readPlanFingerprints(repo, { exec = (...args) => execFileSyncThrottled(...args) } = {}) {
  // A wrapper `exec` (not the throttled function itself) makes defaultReadOpenPrs skip the shared snapshot.
  const rows = defaultReadOpenPrs({ exec, repo: CONSTELLATION_REPOS[repo]?.slug ?? repo, extraFields: ['isDraft', 'labels', 'updatedAt', 'mergeStateStatus'] });
  if (!Array.isArray(rows) || rows.some((pr) => !pr || typeof pr.updatedAt !== 'string')) throw new Error('plan fingerprint unreadable');
  const map = new Map(rows.map((pr) => [pr.number, prFingerprint(pr)]));
  // Main's own CI state feeds the planner's main-red attribution (ci-heal authorization): any change drops every row.
  const slug = CONSTELLATION_REPOS[repo]?.slug ?? repo;
  const runs = JSON.parse(String(exec('gh', ['run', 'list', '--branch', 'main', '--limit', '20', '--repo', slug,
    '--json', 'databaseId,status,conclusion,headSha,attempt,updatedAt'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60e3 }) || 'null'));
  if (!Array.isArray(runs)) throw new Error('plan main-state unreadable');
  map.set(MAIN_STATE_KEY, JSON.stringify(runs));
  return map;
}

/**
 * Default live probe for claims and sessions: `claim:<repo>:<pr>` for every live fix/ci-heal claim, and
 * `agent:<id>` for every live agent session (the planner's liveness gate reads these).
 */
export function readPlanClaims({ readAgents = () => enrichAgents(defaultReadAgents()) } = {}) {
  const out = new Set(listFixDispatchClaims(undefined, { liveOnly: true }).map((c) => `claim:${c.meta.repo}:${c.meta.pr}`));
  const agents = readAgents();
  if (!Array.isArray(agents)) throw new Error('plan agent probe unreadable');
  // The WHOLE enriched session record is the key (identity, cwd, lane HEAD, pid liveness, hung / idle / self-reported
  // flags, wait state): any change means the planner's liveness reading would differ. Only a growing counter
  // (`hungAgeMs`) and, for a plain chat session outside a lane clone, its busy/idle flip are left out.
  for (const a of agents) {
    const { hungAgeMs: _age, ...record } = a ?? {};
    const laneBound = a?.kind !== 'interactive' || /[\\/]\.lanes[\\/]/.test(String(a?.cwd ?? ''));
    if (!laneBound) delete record.status;
    out.add(`agent:${a?.sessionId ?? a?.pid ?? a?.name}:${JSON.stringify(Object.entries(record).sort(([x], [y]) => (x < y ? -1 : 1)))}`);
  }
  return out;
}

/**
 * One reconcile plan per repo and compatible planner input per pass, reused by fix, ci-heal, promote-draft and notes.
 * A READ CACHE only: it lives inside one `runTickAllRepos` call and dies with it. It never authorizes an action, and it fails closed:
 *  - Every reuse re-probes the repo live (one light PR list plus the live claim set) and compares with the probe taken
 *    just BEFORE the plan was computed. A PR whose head, draft state, labels or last activity (comments, stand-downs,
 *    pushes) changed, or that gained a live claim, loses its dispatch/notes/owed rows from the reused plan; refusal
 *    rows are kept (they only explain). Anything an earlier phase acted on is dropped the same way.
 *  - A new, changed or removed session discards the cached plan and recomputes liveness. Merely dropping every
 *    dispatch row would starve later phases whenever fix launches a session, including after auth recovery.
 *  - A failed probe, a plan older than `maxAgeMs`, or one that cannot be cloned is recomputed in full.
 *  - Each reader gets its own deep copy.
 *  - Auto-proceed permission must match. Other planner overrides bypass reuse; their effects cannot be inferred
 *    from the live fingerprint. `readPrs` alone is ignored because planning always replaces it with a direct read.
 * Each phase still runs its own live gates (fix claim, fresh per-sha check read, stale-main guard) on top.
 * @param {{reconcile?:Function, now?:Function, maxAgeMs?:number, readFingerprints?:Function, readClaims?:Function}} [o]
 */
export function createReconcilePlanCache({ reconcile = (input) => runReconcilePass(input), now = Date.now,
  maxAgeMs = RECONCILE_PLAN_MAX_AGE_MS, readFingerprints = readPlanFingerprints, readClaims = readPlanClaims } = {}) {
  const entries = new Map();
  const touched = new Map();
  const probe = (repo) => ({ prs: readFingerprints(repo), claims: readClaims() });
  const filterRows = (plan, stale) => {
    for (const key of ['dispatch', 'notes', 'owedTriggers']) if (Array.isArray(plan[key])) {
      plan[key] = plan[key].filter(row => stale !== 'all' && !stale.has(row?.prNumber ?? row?.pr));
    }
    return plan;
  };
  // PRs whose live state differs from what the plan saw (or that an earlier phase acted on).
  const staleSet = (repo, baseline) => {
    const live = probe(repo);
    const stale = new Set(touched.get(repo) ?? []);
    // A session can bind by name or lane HEAD to any PR. Re-plan from live evidence rather than returning an
    // empty plan: otherwise an unrelated fix session can suppress CI-heal on every pass, even after /login.
    for (const key of new Set([...live.claims, ...baseline.claims])) {
      if (key.startsWith('agent:') && live.claims.has(key) !== baseline.claims.has(key)) return 'recompute';
    }
    if (live.prs.get(MAIN_STATE_KEY) !== baseline.prs.get(MAIN_STATE_KEY)) return 'all';
    for (const [pr, fp] of baseline.prs) if (live.prs.get(pr) !== fp) stale.add(pr);
    for (const [pr] of live.prs) if (!baseline.prs.has(pr)) stale.add(pr);
    for (const key of live.claims) {
      if (baseline.claims.has(key)) continue;
      stale.add(Number(key.split(':').pop()));
    }
    return stale;
  };
  const read = (repo, allowStandDownAutoProceed = false) => {
    const entry = entries.get(repo);
    if (!entry || entry.allowStandDownAutoProceed !== allowStandDownAutoProceed || now() - entry.at > maxAgeMs) return null;
    try {
      const stale = staleSet(repo, entry.baseline);
      if (stale === 'recompute') { entries.delete(repo); return null; }
      const plan = filterRows(structuredClone(entry.plan), stale);
      const captured = structuredClone(entry.captured).filter((pr) => stale !== 'all' && !stale.has(pr?.number));
      return { plan, captured };
    } catch { entries.delete(repo); return null; }
  };
  return {
    /** Same shape as `runReconcilePass`. Reuses only matching planner inputs, with live-validated copies. */
    reconcile(input = {}) {
      const repo = input.repo ?? null;
      const allowStandDownAutoProceed = input.allowStandDownAutoProceed === true;
      const cacheable = Object.entries(input).every(([key, value]) => value === undefined
        || ['repo', 'readPrs', 'allowStandDownAutoProceed'].includes(key));
      const hit = cacheable ? read(repo, allowStandDownAutoProceed) : null;
      if (hit) return hit.plan;
      // Do not let notes reuse the preceding plan if an override or a failed recompute replaces it.
      entries.delete(repo);
      let baseline = null;
      try { baseline = probe(repo); } catch { baseline = null; }
      let captured = [];
      const tap = (fn, fallback) => (...args) => { captured = (fn ?? fallback)(...args); return captured; };
      // Always plan from a DIRECT read taken AFTER the baseline probe. A caller-supplied `readPrs` (the pass's earlier
      // discovery snapshot) and the host-shared PR snapshot (valid ~75 s) can both predate the baseline, which would let
      // a newer probe certify older evidence. A wrapper `exec` makes the default reader skip the shared snapshot; the
      // attribution repo it would otherwise get by identity is passed explicitly. Later stages capture the hydrated
      // rows for notes.
      const { readPrs: _discovery, ...fresh } = input;
      const plan = filterRows(reconcile({ ...fresh,
        readPrs: tap(planFreshReadPrs(defaultReadPrs)),
        excuseMergeGateHolds: tap(input.excuseMergeGateHolds, excusePrMergeGateHolds),
        enrichCodeQL: tap(input.enrichCodeQL, enrichPrsWithCodeQL) }), touched.get(repo) ?? new Set());
      try { if (baseline && cacheable) entries.set(repo, { at: now(), baseline, allowStandDownAutoProceed,
        plan: structuredClone(plan), captured: structuredClone(captured) }); }
      catch { entries.delete(repo); }
      return plan;
    },
    /** Read-only notes view of a live-validated plan; never reuse an auto-proceed-enabled plan here. */
    notes(repo) {
      const hit = read(repo);
      if (!hit) return null;
      return { notes: Array.isArray(hit.plan.notes) ? hit.plan.notes : [],
        prsByNumber: new Map((Array.isArray(hit.captured) ? hit.captured : []).map((pr) => [pr.number, pr])) };
    },
    /** Record PRs a phase acted on this pass; later phases will not reuse plan rows for them. */
    markTouched(results) {
      for (const d of results?.dispatched ?? results?.dispatch ?? []) {
        const pr = d?.pr ?? d?.prNumber;
        if (pr == null) continue;
        const repos = d.repo == null ? [...entries.keys()] : [d.repo];
        for (const key of repos) {
          if (!touched.has(key)) touched.set(key, new Set());
          touched.get(key).add(pr);
        }
      }
    },
  };
}

// R812: settings can narrow these bounds; only code can enlarge the outer limit.
const FIX_PASS_LIMITS = {
  fixMs: { defaultMs: 300000, maxMs: 1800000, env: 'WE_FIX_BUDGET_FIX_MS', phase: 'fix' },
  notesMs: { defaultMs: 300000, maxMs: 1800000, env: 'WE_FIX_BUDGET_NOTES_MS', phase: 'notes' },
  orphanGuardMs: { defaultMs: 300000, maxMs: 1800000, env: 'WE_FIX_BUDGET_ORPHAN_GUARD_MS', phase: 'orphan-guard' },
  stuckFixersMs: { defaultMs: 120000, maxMs: 600000, env: 'WE_FIX_BUDGET_STUCK_FIXERS_MS', phase: 'stuck-fixers' },
  ciHealMs: { defaultMs: 180000, maxMs: 900000, env: 'WE_FIX_BUDGET_CI_HEAL_MS', phase: 'ci-heal' },
  promoteDraftMs: { defaultMs: 120000, maxMs: 600000, env: 'WE_FIX_BUDGET_PROMOTE_DRAFT_MS', phase: 'promote-draft' },
};

/** `file` accepts a settings path or injected parsed data. Invalid overrides reset to standard,
 * rather than inheriting a possibly larger lower-layer value. Unreadable files use standard. */
export function resolveFixPassBudgets({ env = process.env,
  file = resolve(DAEMON_REPO_ROOT, 'scripts/settings/fix-pass-budget.json'), readFile = readFileSync,
} = {}) {
  let raw;
  try { raw = typeof file === 'string' || file instanceof URL ? JSON.parse(readFile(file, 'utf8')) : file; }
  catch { raw = null; }
  const standard = {}, tool = {}, envValues = {};
  const parse = (v, maxMs, fromEnv = false) => {
    if (fromEnv && typeof v === 'string' && /^\d+$/.test(v)) v = Number(v);
    return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
      ? Math.min(maxMs, Math.max(1000, v)) : null;
  };
  for (const [key, rule] of Object.entries(FIX_PASS_LIMITS)) {
    standard[key] = rule.defaultMs;
    if (Object.hasOwn(raw?.fixPassBudget ?? {}, key)) {
      const value = parse(raw.fixPassBudget[key], rule.maxMs);
      if (value !== null) tool[key] = value;
    }
    if (Object.hasOwn(env, rule.env)) {
      const value = parse(env[rule.env], rule.maxMs, true);
      if (value === null) delete tool[key];
      else envValues[key] = value;
    }
  }
  const resolved = resolveCascade({ standard, tool, envValues });
  return Object.fromEntries(Object.keys(FIX_PASS_LIMITS).map(key => [key,
    { value: resolved.value[key], source: resolved.sources[key] }]));
}

// One cursor per bounded repo phase; callers can inject isolated daemon state.
const fixPassRotation = {};
const fixPassPrCursors = {};

/**
 * we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs#runTickAllRepos — #xngv3vn (epic #3383/#4075): the
 * daemon's WHOLE per-tick unit of work, composing BOTH halves this daemon now owns — the pre-existing `fix`
 * dispatch ({@link runReconcileFixDispatchAllRepos}) and the previously-uncalled `ci-heal` dispatch
 * ({@link runReconcileCiHealDispatchAllRepos}, per this daemon's own docblock above: nothing in the tree ever
 * invoked it) — into ONE merged result. `onTick`'s log line and `hasStaleMainRefusal`'s scan (wired against
 * `withSelfSync`, below) both read `result.refusals`, so merging here — rather than bolting ci-heal on as a
 * SEPARATE, unobserved side effect — is what makes a ci-heal-side stale-main refusal trigger the SAME
 * self-resync `fix` already gets, and what makes ci-heal's own dispatch/refusal counts show up in the ordinary
 * tick log at all. Each half keeps its OWN per-repo isolation internally; a `fix`-side failure for one repo
 * never skips that SAME repo's `ci-heal` attempt, and vice versa — two independent per-repo ticks, merged only
 * for reporting.
 * @param {{repos?:string[], fixTick?:Function, ciHealTick?:Function, notesTick?:Function, notesDryRun?:boolean,
 *   authGateOverride?:Function}} [o]
 *   - every tick defaults to the real dispatch function; injecting one is for tests only. `notesDryRun`
 *   forwards to {@link runReconcileNotesAllRepos}'s own `dryRun` (omit to use ITS OWN default). `authGateOverride`
 *   (card x5kagse) is a test-only injection point for {@link planClaudeAuthDispatchGate}'s own real IO decision —
 *   see the block below for when the real one runs instead.
 * @returns {Promise<{repos:Array<object>, dispatched:Array<object>, refusals:Array<object>,
 *   reconcileRefusals:Array<object>, ciHeal:object, hungCi:object, notes:Array<object>,
 *   noteComments:Array<object>, authPaused:boolean, authPauseReason:(string|null)}>} `reconcileRefusals`
 *   (#x0mn6x0, epic #4075/#3383) merges both halves' own reconcile-layer refusal arrays — see
 *   {@link runReconcileFixDispatchAllRepos}'s own field for the shape/why. `onTick` (below) logs these
 *   SEPARATELY from `refusals`: they are a different population (a PR reconcile refused outright, never even
 *   offered to `fix`/`ci-heal`), not a duplicate count of the same thing. `hungCi` (xd1sfms, epic #4075/#3383)
 *   is the THIRD half this daemon now owns — see {@link runHungCiRecoveryAllRepos}'s own docblock for why this
 *   daemon, specifically, is where it lives (it is the one daemon confirmed live and ticking; the pass's own
 *   `daemon-manifest.mjs` entry has no launchd job installed). `notes`/`noteComments` (#4191, epic #4075/#3383)
 *   are the FIFTH half — see {@link runReconcileNotesAllRepos}'s own docblock. `authPaused`/`authPauseReason`
 *   (card x5kagse, epic #4075/#3383) — while the operator's Claude login is broken
 *   (`we:scripts/conveyor/claude-auth-health.mjs`), `fix` and `ci-heal` — the two halves that actually dispatch
 *   a fresh Claude session — are SKIPPED OUTRIGHT this tick, never merely attempted-and-failed: nothing is
 *   dispatched, so no fix/ci-heal attempt and no round-cap comment marker is ever spent on a login that cannot
 *   work. `hungCi`/`mainRedRebase`/`notes` (mechanical git/gh passes, no Claude session involved) keep running
 *   unpaused — the login break does not touch them.
 */
export async function runTickAllRepos({
  repos = FIX_DISPATCH_DAEMON_REPOS, fixTick, ciHealTick, hungCiTick, mainRedRebaseTick, missingRunTick, promoteDraftTick, rulingStandDownTick, notesTick, notesDryRun,
  authGateOverride,
  fixSettings = resolveFixSettings(),
  // Opt-in IO for injected ticks; historical fixtures never acquire a live snapshot.
  readPrs,
  // R123: resolve once per daemon pass, then carry permission through the fan-out and reconciliation.
  // An explicit boolean overrides policy for tests and read-only callers.
  allowStandDownAutoProceed = fixSettings.standDownAutoProceed,
  // #5137 slices 2+3 — the verify-verdict pass (we:scripts/conveyor/await-verify-pass.mjs). Injectable like every
  // other half; a test tick (fixTick/ciHealTick injected) never runs the real one.
  awaitVerifyTick,
  // card xccgzu5 — the consumer of the session watchdog's fixer-stuck events (we:scripts/conveyor/fixer-stuck-reclaim.mjs).
  // Injectable like every other half; a test tick never runs the real one.
  stuckFixerTick,
  // card xiqtf7w — the supersede-hold half. Injectable like every other half; a test tick never runs the real one.
  supersedeTick,
  // #3383 follow-up (live-caught 2026-09-26, PR #2771) — apply this daemon's OWN `review-status:*` tag the
  // instant it dispatches a fix/ci-heal session, never waiting on the SEPARATE Review daemon's own tick to
  // notice (see `we:scripts/conveyor/review-status-tag.mjs#applyReviewStatus`'s own docblock for the full
  // incident and why a fresh `claude agents --json` read right after dispatch would race and often no-op).
  // `null` (the default) is DELIBERATELY OPT-IN, mirroring `we:skills-src/conveyor/review-daemon.mjs#runReviewTick`'s
  // own `readPrs`/`readAgents` convention: every pre-existing test of this function injects a fake
  // `fixTick`/`ciHealTick` and never expects a real `gh`/label-provider call to fire underneath it — a non-null
  // default here would spend one for every dispatched row those fakes produce. The real daemon
  // (`buildCliDaemonEffects`, below) opts in via {@link defaultTagDispatchStatus}.
  tagDispatchStatus = null,
  // Share compatible plans across fix/ci-heal/promote-draft/notes within this pass (see createReconcilePlanCache).
  // Default on for the real daemon; injected-tick fixtures keep their historical arguments unless they opt in.
  reuseReconcilePlan,
  // Injectable planner under the cache (tests count invocations).
  reconcilePass = (input) => runReconcilePass(input),
  // Injectable live probes behind plan reuse (default: one light PR list per repo + the live claim set).
  readPlanFingerprint = readPlanFingerprints, readPlanClaimSet = readPlanClaims,
  // Injectable clock for the per-phase timing (live 2026-10-09: an untimed 15.7-min pass delayed PR #4624's fix).
  now = Date.now,
  passBudgets = resolveFixPassBudgets(),
  budgetRotation = fixPassRotation,
  prCursors = fixPassPrCursors,
  // Off under a test run unless injected (the real pass reads GitHub).
  orphanGuardTick = process.env.VITEST ? null : runOrphanFixRoundPass,
} = {}) {
  const passStart = now();
  const anyTickInjected = [fixTick, ciHealTick, hungCiTick, mainRedRebaseTick, missingRunTick,
    promoteDraftTick, notesTick, awaitVerifyTick, stuckFixerTick, supersedeTick, rulingStandDownTick].some(Boolean);
  const planCache = (reuseReconcilePlan ?? !anyTickInjected)
    ? createReconcilePlanCache({ reconcile: reconcilePass, now, readFingerprints: readPlanFingerprint, readClaims: readPlanClaimSet }) : null;
  const budgets = Object.fromEntries(Object.entries(FIX_PASS_LIMITS).map(([key, rule]) =>
    [rule.phase, { budgetMs: passBudgets[key].value, hit: false, skipped: [] }]));
  // A generator lets the existing sequential fan-outs yield only BETWEEN complete repo ticks.
  function* budgetRepos(phase, candidates) {
    const start = now();
    const budget = budgets[phase];
    const cursor = candidates.indexOf(budgetRotation[phase]);
    const ordered = cursor > 0 ? [...candidates.slice(cursor), ...candidates.slice(0, cursor)] : [...candidates];
    for (let i = 0; i < ordered.length; i += 1) {
      if (now() - start > budget.budgetMs) {
        budget.hit = true;
        budget.skipped.push(...ordered.slice(i));
        budgetRotation[phase] = ordered[i];
        return;
      }
      yield ordered[i];
    }
    delete budgetRotation[phase];
  }
  const phaseMs = {}, phaseStarts = {}, phasePrCounts = {};
  // Wrap both sync and async ticks without changing the synchronous fan-outs.
  const boundedPrTick = (phase, tick) => options => {
    const cursors = prCursors[phase] ??= {};
    const record = result => {
      const counts = phasePrCounts[phase] ??= { handled: 0, deferred: 0 };
      counts.handled += result?.handled ?? 0;
      counts.deferred += result?.deferred?.length ?? 0;
      if (result?.nextCursor != null) {
        cursors[options.repo] = result.nextCursor;
        budgets[phase].hit = true;
        budgets[phase].skipped.push(...(result.deferred ?? []));
      } else delete cursors[options.repo];
      if (result?.deadlineSkipped) budgets[phase].hit = true;
      return result;
    };
    const result = tick({ ...options, deadlineAt: phaseStarts[phase] + budgets[phase].budgetMs,
      cursor: cursors[options.repo], now });
    return result && typeof result.then === 'function' ? result.then(record) : record(result);
  };
  const finishPhase = (name, start) => {
    phaseMs[name] = now() - start;
    if (budgets[name] && phaseMs[name] > budgets[name].budgetMs) budgets[name].hit = true;
  };
  const timed = (name, fn) => { const t = phaseStarts[name] = now(); try { return fn(); } finally { finishPhase(name, t); } };
  const timedAsync = async (name, fn) => { const t = phaseStarts[name] = now(); try { return await fn(); } finally { finishPhase(name, t); } };
  // card x5kagse (epic #4075/#3383) — computed ONCE per tick, shared by both dispatching halves below. Real IO
  // (`planClaudeAuthDispatchGate`'s own `claude agents --json --all` read + health read + cheap probe) runs
  // ONLY for a genuine production tick — mirrors `queueAdmission`'s own "only read when a real tick runs" rule
  // just below: a test that injects EITHER `fixTick` or `ciHealTick` never wants this file to shell out for a
  // gate decision it did not ask about, unless it explicitly injects `authGateOverride` to test the gate itself.
  // perf C1d — once a real tick: refresh the PR-facts mirror from the Worker (NOT a GitHub call). Best-effort; the
  // timeout-evidence reads then try the store first and fall back to GitHub on stale/partial (see `fix-facts.mjs`).
  const realTick = !fixTick && !ciHealTick;
  const factsWarm = realTick ? await timedAsync('facts', () => warmFixFacts(repos)) : null;
  const authGate = timed('auth-gate', () => (authGateOverride ? authGateOverride()
    : ((fixTick || ciHealTick) ? { paused: false, reason: null } : planClaudeAuthDispatchGate())));
  // #5137 — FIRST, before any fresh dispatch: a fixer that ended its turn awaiting a verdict is pushed (green,
  // exact sha) or resumed (red) here, so the model never holds a turn open on `check --wait`. Pushing needs no
  // Claude login; resuming does, so a paused login only defers the resume (the record keeps it pending).
  // xn025gx (R4 push-wake-cadence): with all three fixDispatch push-on-green settings off (loop seconds 0, the two switches off) this is exactly the pass above; with the fast loop
  // alive the loop owns the pass and this tick skips it; otherwise the tick runs the same R3/R5 cycle under the cycle lock.
  const awaitVerify = await timedAsync('await-verify', async () => (awaitVerifyTick ? awaitVerifyTick({ allowResume: !authGate.paused })
    : (realTick ? buildAwaitVerifyStep()({ allowResume: !authGate.paused }) : { rows: [] })));
  // card xiqtf7w — before any fresh dispatch: a PR a merged PR declares it supersedes gets its terminal
  // stand-down now, so this tick's fix/ci-heal halves (and the review daemon) already read it as stood down.
  // No Claude session is spawned, so the auth gate never pauses it.
  const supersede = timed('supersede', () => (supersedeTick ? runSupersedeAllRepos({ repos, tick: supersedeTick })
    : (realTick ? runSupersedeAllRepos({ repos }) : { repos: [] })));
  const rulingStandDown = await timedAsync('ruling-stand-down', async () => {
    const setting = resolveReviewSettings().rulingResolvesStandDown;
    const settingSource = resolveReviewSettingSource('rulingResolvesStandDown');
    if (!repos.includes(CONSTELLATION_REPOS.we.slug) || (anyTickInjected && !rulingStandDownTick)) {
      return { rows: [], setting, settingSource };
    }
    try {
      return await (rulingStandDownTick ?? runRulingResolvesStandDownPass)({
        repo: CONSTELLATION_REPOS.we.slug, setting, settingSource, log: () => {},
      });
    } catch (e) {
      return { rows: [{ repo: CONSTELLATION_REPOS.we.slug, pr: null, action: 'error', why: String(e?.message ?? e) }], setting, settingSource };
    }
  });
  const pausedDispatchResult = () => ({
    repos: repos.map((repo) => ({ repo, result: { dispatched: [], refusals: [] } })),
    dispatched: [], refusals: [], reconcileRefusals: [],
  });
  // Card xkyw1x4 — the live heavy-test queue gate: ONE baseline read and ONE budget per daemon pass, shared by
  // every repo's fix and CI-heal dispatch, so each dispatch in the pass sees the demand of the ones before it.
  // Only read when a real tick runs (an injected test tick never needs it) AND dispatch is not paused (card
  // x5kagse — no reason to read live queue capacity for a pass that is about to dispatch nothing at all).
  const queueAdmission = (authGate.paused || (fixTick && ciHealTick)) ? null : createQueueBudget(resolveLiveQueueBaseline({ checkoutRoot: DAEMON_REPO_ROOT }));
  // ONE throttle per pass shared by fix + ci-heal: live fix/ci-heal cap and host-load gate (defer-only).
  // xn025gx (R2 fix-slot-count): a session parked on verify gives its slot back; a decided resume keeps one. Setting off →
  // the same live-claim list as before.
  const dispatchThrottle = queueAdmission ? buildFixThrottle() : null;
  // Card 87 — ONE borrow gate per pass (fix only; ci-heal never borrows). OFF unless `fixDispatch.borrowBuildSlots` is on.
  const borrowGate = dispatchThrottle ? createFixBorrowGate({
    listBuildClaims: () => listBuildDispatchClaims(), listFixClaims: () => listFixDispatchClaims(undefined, { liveOnly: true }),
    launcherAvailable: (executor) => fixLauncherAvailable(executor),
  }) : null;
  const executorSetting = resolveFixExecutorSetting();
  const chain = resolveFixExecutorChain();
  const fixExecutorRoute = (planned) => routeFixExecutor(planned, {
    setting: executorSetting, chain, fixSettings, launcherAvailable: e => fixLauncherAvailable(e),
    criticalFor: planned => criticalWorkVerdict({ taskType: planned.kind === 'ci-heal' ? 'ci-heal' : 'fix', filesTouched: planned.scope ?? [] }).critical,
  });
  const routedCiHealTick = (options) => {
    let entries = [];
    return runReconcileCiHealDispatch({ ...options,
      reconcile: (input) => {
        const plan = planCache ? planCache.reconcile(input) : runReconcilePass(input);
        entries = plan.dispatch ?? [];
        return plan;
      },
      dispatch: createRoutedCiHealDispatch({ dispatch: dispatchCiHeal,
        staleBaseGate: createStaleBaseGate(),
        route: (planned) => fixExecutorRoute({ ...entries.find((e) => e.kind === 'ci-heal' && e.prNumber === planned.pr), ...planned }),
        createSinks: createDispatchSinks, launchCodex: fixDetachedProvider,
        writePrompt: writePrivateBorrowedPrompt, removePrompt: (file) => { try { unlinkSync(file); } catch {} },
        profileFor: repoProfile,
      }),
    });
  };
  // R242: share discovery only. Do not speculatively reconcile/hydrate active
  // PRs: their owners still need those reads, and notes needs post-dispatch evidence.
  const snapshots = new Map();
  const skipEmptySteps = fixSettings.skipEmptySteps ?? resolveFixDispatchSettings().skipEmptySteps;
  if (skipEmptySteps && (readPrs || realTick)) {
    timed('snapshot', () => {
      for (const repo of repos) {
        try {
          let commentsReadFailed = false;
          const rows = (readPrs ?? defaultReadPrs)({ repo: CONSTELLATION_REPOS[repo]?.slug ?? repo,
            // The default reader may omit a PR whose long thread is unreadable.
            readComments: (...args) => {
              try { return readCompletePrComments(...args); }
              catch (error) { commentsReadFailed = true; throw error; }
            },
          });
          // Missing/partial/truncated discovery runs the historical paths.
          // defaultReadPrs coerces empty stdout and non-array JSON to [], so an
          // empty snapshot is missing evidence, not proof that a step has no work.
          const complete = !commentsReadFailed && Array.isArray(rows) && rows.length > 0 && rows.discoveryIncomplete !== true && rows.length < PR_LIST_LIMIT && rows.every(pr => pr && Number.isInteger(pr.number)
            && typeof pr.headRefName === 'string' && typeof pr.headRefOid === 'string'
            && typeof pr.baseRefName === 'string' && typeof pr.isDraft === 'boolean'
            && typeof pr.body === 'string' && typeof pr.mergeStateStatus === 'string'
            && Array.isArray(pr.labels) && Array.isArray(pr.statusCheckRollup)
            && Array.isArray(pr.comments) && Array.isArray(pr.files));
          if (complete) snapshots.set(repo, { rows });
        } catch { /* Unknown discovery runs the historical paths. */ }
      }
    });
  }
  const skippedSteps = [];
  const stepRepos = new Map();
  for (const step of ['fix', 'hung-ci', 'main-red-rebase', 'missing-run', 'promote-draft']) {
    const active = repos.filter(repo => snapshots.get(repo)?.rows.length !== 0);
    stepRepos.set(step, active);
    if (repos.length && !active.length) {
      skippedSteps.push(step);
      process.stderr.write(`reconcile-fix-dispatch-daemon: skipped ${step} — empty work list (no candidates in shared PR discovery)\n`);
    }
  }
  const emptyResult = () => ({ repos: repos.map(repo => ({ repo, result: { dispatched: [], refusals: [] } })),
    dispatched: [], refusals: [], reconcileRefusals: [], notes: [], comments: [], autoGrants: [] });
  const stepTimed = (step, fn) => {
    if (skippedSteps.includes(step)) { phaseMs[step] = 0; return emptyResult(); }
    return timed(step, fn);
  };
  // Pass-local plan reuse for the two phases routed through sharedTick (ci-heal and notes are wired below).
  // Fix keeps its net-scope and stack IO, which it only enables for the identity-equal planner.
  const reuseOptions = (step, tick) => {
    if (!planCache || (step !== 'fix' && step !== 'promote-draft')) return {};
    return { reconcile: planCache.reconcile, ...(step === 'fix' && tick === runReconcileFixDispatch
      ? { netScope: applyNetScopeToReconcile, prStack: readStacksForPass } : {}) };
  };
  const sharedTick = (step, tick) => options => {
    if (step === 'fix' && tick === runReconcileFixDispatch) {
      // Fix's existing `now` is a timestamp for capacity accounting, not a clock.
      options = { ...options, clock: options.now, now: options.now() };
    }
    const snapshot = snapshots.get(options.repo);
    if (!snapshot) return tick({ ...options, ...reuseOptions(step, tick) });
    const sharedRead = () => structuredClone(snapshot.rows);
    // Re-run each owner's reconciliation reads; only PR discovery is shared.
    const reconcile = input => runReconcilePass({ ...input, readPrs: sharedRead });
    if (step === 'fix' && tick === runReconcileFixDispatch) {
      // Preserve reconcile's identity: fix uses it to enable net-scope and stack IO.
      return tick({ ...options, readPrs: sharedRead, ...reuseOptions(step, tick) });
    }
    const readOpenPrs = input => {
      const fields = input?.extraFields ?? [];
      return snapshot.rows.every(pr => fields.every(field => Object.hasOwn(pr, field)))
        ? sharedRead() : defaultReadOpenPrs(input);
    };
    return tick({ ...options, readPrs: sharedRead, readOpenPrs, reconcile, ...reuseOptions(step, tick) });
  };
  // The orphan-round guard (retry/escalation cap) stays BEFORE fix so a capped orphan is never re-dispatched first.
  const requireOrphanGuard = !stuckFixerTick && realTick && !!orphanGuardTick;
  const orphanGuardCompleted = new Set();
  const orphanGuard = await timedAsync('orphan-guard', async () => {
    if (!requireOrphanGuard) return { rows: [] };
    try {
      const result = await orphanGuardTick({ env: process.env, nowMs: now(),
      repos: (function* () {
        for (const repo of budgetRepos('orphan-guard', repos)) {
          const key = repoKeyForSlug(repo);
          if (!key) throw new Error(`orphan-guard: unknown repo ${repo}`);
          yield { key, slug: CONSTELLATION_REPOS[key].slug };
          // Iterator progress proves only that the repo was visited; returned rows may still report failure.
          orphanGuardCompleted.add(repo);
        }
      })(),
      });
      if (!Array.isArray(result?.rows)) orphanGuardCompleted.clear();
      else for (const row of result.rows) {
        const key = row?.repo && repoKeyForSlug(row.repo);
        if (!key) { orphanGuardCompleted.clear(); break; }
        const success = { rearm: 're-armed', redispatch: 're-dispatched', escalate: 'escalated' };
        if (!Object.hasOwn(success, row.decision)
          || (row.result !== success[row.decision] && row.result !== 'report-only (WE_ORPHAN_FIX_GUARD=0)')) {
          for (const repo of orphanGuardCompleted) {
            if (repoKeyForSlug(repo) === key) orphanGuardCompleted.delete(repo);
          }
        }
      }
      return result ?? { rows: [] };
    }
    catch (e) {
      orphanGuardCompleted.clear();
      return { rows: [{ decision: 'error', reason: String(e?.message ?? e).split('\n')[0] }] };
    }
  });
  const orphanGuardDeferred = requireOrphanGuard
    ? stepRepos.get('fix').filter(repo => !orphanGuardCompleted.has(repo)) : [];
  const guardedFixRepos = stepRepos.get('fix').filter(repo => !orphanGuardDeferred.includes(repo));
  const fix = stepTimed('fix', () => (authGate.paused ? pausedDispatchResult()
    : runReconcileFixDispatchAllRepos({ repos: budgetRepos('fix', guardedFixRepos), allowStandDownAutoProceed,
      tick: boundedPrTick('fix', sharedTick('fix', fixTick ?? runReconcileFixDispatch)),
      ...(fixTick ? {} : { queueAdmission, dispatchThrottle, borrowGate, fixExecutorRoute }) })));
  for (const repo of orphanGuardDeferred) fix.refusals.push({ repo, prNumber: null,
    kind: 'orphan-guard-deferred', why: 'orphan-cap guard did not complete this repo; fix deferred until next pass' });
  planCache?.markTouched(fix);
  // Reclaim after fix so a slow watchdog sweep cannot delay review:changes decisions.
  // The hooks cannot interrupt in-flight work or bound discovery/endFix/release IO.
  const stuckFixers = await timedAsync('stuck-fixers', async () => {
    const start = now();
    const overBudget = () => {
      if (now() - start > budgets['stuck-fixers'].budgetMs) budgets['stuck-fixers'].hit = true;
      return budgets['stuck-fixers'].hit;
    };
    if (stuckFixerTick) return stuckFixerTick();
    if (!realTick) return { rows: [] };
    return runFixerStuckReclaimPass({
      stopSession: options => {
        if (overBudget()) throw new Error('stuck-fixers pass budget exhausted; retry next tick');
        return stopSession(options);
      },
      orphanPass: null, // ran before fix (orphan-guard phase)
    });
  });
  if (orphanGuard.rows?.length && Array.isArray(stuckFixers?.rows)) {
    stuckFixers.orphanRounds = orphanGuard;
    for (const r of orphanGuard.rows) stuckFixers.rows.push({ ...r, kind: 'orphan-fix-round' });
  }
  // R242 audit round 3: CI-heal must retain its historical flushOwed/flushTimeouts
  // ordering, and notes must write from fresh evidence, even on an empty snapshot.
  // Neither step participates in snapshot sharing or empty-work skipping.
  const ciHeal = await timedAsync('ci-heal', async () => (authGate.paused ? pausedDispatchResult()
    : await runReconcileCiHealDispatchAllRepos({ repos: budgetRepos('ci-heal', repos), tick: boundedPrTick('ci-heal', ciHealTick ?? routedCiHealTick), ...(ciHealTick ? {} : { queueAdmission, dispatchThrottle }),
      ...(planCache ? { reconcile: planCache.reconcile } : {}) })));
  ciHeal.budgetSkipped = budgets['ci-heal'].skipped;
  planCache?.markTouched(ciHeal);
  if (dispatchThrottle) lastFixQueueLength = fixQueueLengthOf(fix, ciHeal);
  const hungCi = stepTimed('hung-ci', () => runHungCiRecoveryAllRepos({ repos: stepRepos.get('hung-ci'), tick: sharedTick('hung-ci', hungCiTick ?? sweepHungCiRecovery) }));
  planCache?.markTouched(hungCi);
  // x5uqim1 follow-up (#4075/#3383) — the FOURTH half this daemon now owns: see
  // {@link runMainRedRebaseAllRepos}'s own docblock for why this daemon, specifically, is where it lives (same
  // reason `hungCi` already does — the pass's own `daemon-manifest.mjs` entry has no launchd job installed).
  const mainRedRebase = stepTimed('main-red-rebase', () => runMainRedRebaseAllRepos({ repos: stepRepos.get('main-red-rebase'), tick: sharedTick('main-red-rebase', mainRedRebaseTick ?? sweepCiRedRecovery) }));
  planCache?.markTouched(mainRedRebase);
  // xi4od2p (#4075/#3383) — the SIXTH half this daemon now owns: see {@link runMissingRunRecoveryAllRepos}'s
  // own docblock for why this daemon, specifically, is where it lives (same reason `hungCi`/`mainRedRebase`
  // already do — the pass's own `daemon-manifest.mjs` entry has no launchd job installed).
  const missingRun = stepTimed('missing-run', () => runMissingRunRecoveryAllRepos({ repos: stepRepos.get('missing-run'), tick: sharedTick('missing-run', missingRunTick ?? sweepMissingRunRecovery) }));
  planCache?.markTouched(missingRun);
  // draft-first PRs (operator-approved 2026-09-27) — the SEVENTH half this daemon now owns: see
  // {@link runPromoteDraftDispatchAllRepos}'s own docblock for why this daemon, specifically, is where it
  // lives (same reason `hungCi`/`mainRedRebase`/`missingRun` already do). UNPAUSED by `authGate` — see that
  // function's own docblock for why (no Claude session is ever spawned by this half).
  const promoteDraft = stepTimed('promote-draft', () => runPromoteDraftDispatchAllRepos({ repos: budgetRepos('promote-draft', stepRepos.get('promote-draft')), tick: boundedPrTick('promote-draft', sharedTick('promote-draft', promoteDraftTick ?? runReconcilePromoteDraftDispatch)) }));
  promoteDraft.budgetSkipped = budgets['promote-draft'].skipped;
  planCache?.markTouched(promoteDraft);
  // #4191: surface notes after the dispatch/promote steps. With plan reuse, notes read the pass's cached plan minus
  // every PR an earlier phase acted on (fail closed); a missing or too-old plan falls back to a fresh read.
  const notes = timed('notes', () => {
    // Bound the complete note effects, not just the reader, so deferred notes keep their PR cursor.
    const tick = boundedPrTick('notes', ({ repo, ...options }) => runReconcileNotesAllRepos({
      ...options, repos: [repo], ...(planCache ? { reconcile: planCache.reconcile } : {}),
      tick: notesTick ?? (planCache ? o => planCache.notes(o.repo) ?? defaultReadNotesForRepo(o) : defaultReadNotesForRepo),
      ...(notesDryRun == null ? {} : { dryRun: notesDryRun }),
    }));
    const result = { repos: [], notes: [], refusals: [], comments: [], autoGrants: [] };
    for (const repo of budgetRepos('notes', repos)) {
      const part = tick({ repo });
      for (const key of Object.keys(result)) result[key].push(...part[key]);
    }
    return result;
  });
  // #3383 follow-up — tag confirmed freshly-dispatched fix/ci-heal sessions, `fix`+`ci-heal`
  // ONLY: `hungCi`/`mainRedRebase`/`missingRun` are mechanical git/gh actions with no live Claude session bound
  // to a `fix-<pr>`/`ci-heal-<pr>` name, so `review-status:*` (a label about a SESSION, not a mechanical patch)
  // has nothing to say about them. One try/catch per PR — the exact "cosmetic, never fails the tick" discipline
  // `we:scripts/conveyor/review-status-tag.mjs`'s own header already documents for this label family.
  const statusTags = [];
  if (typeof tagDispatchStatus === 'function') {
    // Dispatch arrays also contain timeout requests and incomplete launch results. A minted slug alone
    // proves nothing. Refusals from either half (including reconcile's no-findings) veto the same repo/PR.
    const key = (row) => JSON.stringify([row.repo, String(row.pr ?? row.prNumber)]);
    // A refusal that only says "a session is already live" (live-process / held / fix-claimed) is the echo of a
    // launch that just succeeded, so it must not veto that launch's tag; every other kind is a real refusal.
    const LIVE_ECHO = new Set(['live-process', 'held', 'fix-claimed']);
    const refused = new Set([...fix.refusals, ...ciHeal.refusals,
      ...(fix.reconcileRefusals ?? []), ...(ciHeal.reconcileRefusals ?? [])]
      .filter(r => !LIVE_ECHO.has(r?.kind)).map(key));
    const hasHandle = value => typeof value === 'string' && value.trim().length > 0 && !/^refused:/.test(value.trim());
    const launched = d => d?.pr != null && d.kind !== 'ci-heal-salvage'
      && !d.held && d.launched !== 'unverified' && d.ok !== false && !d.error && !d.refused && !d.failed
      && !['failed', 'held', 'refused', 'error'].includes(d.status)
      && !['failed', 'held', 'refused', 'error'].includes(d.outcome)
      && d.claim?.ok !== false && !refused.has(key(d))
      // Only the spawn handle (`agentId`, from the launcher's stdout) or a confirmed resume proves a session
      // exists; a minted `sessionId` or an acquired claim both precede the launch and prove nothing.
      && ((hasHandle(d.agentId) && d.agentId !== d.sessionId) || (d.resumed === true && hasHandle(d.sessionId)));
    for (const d of [...fix.dispatched, ...ciHeal.dispatched]) {
      if (!launched(d)) continue;
      try {
        const result = await tagDispatchStatus({ pr: d.pr, repo: d.repo });
        statusTags.push({ pr: d.pr, repo: d.repo, ...result });
      } catch (e) {
        statusTags.push({ pr: d.pr, repo: d.repo, changed: false, error: String((e && e.message) || e).split('\n')[0] });
      }
    }
  }
  return {
    repos: repos.map(repo => fix.repos.find(entry => entry.repo === repo)
      ?? { repo, result: { dispatched: [], refusals: [] }, skipped: true }),
    dispatched: [...fix.dispatched, ...ciHeal.dispatched, ...hungCi.dispatched, ...mainRedRebase.dispatched, ...missingRun.dispatched, ...promoteDraft.dispatched],
    refusals: [...fix.refusals, ...ciHeal.refusals, ...hungCi.refusals, ...mainRedRebase.refusals, ...missingRun.refusals, ...promoteDraft.refusals, ...notes.refusals],
    reconcileRefusals: [...(fix.reconcileRefusals ?? []), ...(ciHeal.reconcileRefusals ?? []), ...(promoteDraft.reconcileRefusals ?? [])],
    ciHeal, // the ci-heal half's own detail, kept available rather than discarded once merged above
    hungCi, // the hung-ci-recovery half's own detail, same reason
    mainRedRebase, // the main-red-rebase half's own detail, same reason
    missingRun, // the missing-run-recovery half's own detail, same reason (xi4od2p, #4075/#3383)
    rulingStandDown,
    promoteDraft, // the promote-draft half's own detail, same reason (draft-first PRs, 2026-09-27)
    authPaused: authGate.paused, // card x5kagse — fix/ci-heal dispatch skipped outright this tick
    authPauseReason: authGate.reason,
    notes: notes.notes, // #4191 — every surfaced note this tick saw, repo-tagged
    noteComments: notes.comments, // #4191 — one row per note: posted / would-post (dryRun) / already-posted
    autoRoundGrants: notes.autoGrants ?? [], // standing-ruling card-only round grants this tick decided
    statusTags, // #3383 follow-up — one row per dispatch-time `review-status:*` tag attempt this tick made
    awaitVerify, // #5137 — one row per recorded verify wait this tick read (wait / push / rerequest / resume)
    stuckFixers, // card xccgzu5 — one row per unacknowledged fixer-stuck event (reclaim / hold / ack)
    supersede, // card xiqtf7w — per repo: the supersede holds planned and posted this tick
    ...(realTick ? { factsWarm, factsStats: takeFixReadStats() } : {}), // perf C1d — where this tick's PR facts came from
    phasePrCounts, budgets, passBudgetSettings: passBudgets,
    skippedSteps, phaseMs, passMs: now() - passStart, // how long each half of this pass took (see formatPassTiming)
  };
}

/** The real `tagDispatchStatus` effect for {@link buildCliDaemonEffects}: a fresh fix/ci-heal dispatch is
 *  always "fixing" the instant it's confirmed spawned — `we:scripts/conveyor/review-status-tag.mjs`'s own
 *  `STATUS_LABEL_RE` has no distinct `ci-heal`-specific state yet (only `fixing`/`fix-stalled`), so a ci-heal
 *  dispatch is tagged `fixing` here too; the Review daemon's own periodic {@link tagReviewStatus} pass (fed by
 *  `reconcile-core.mjs#selectStatusCandidates`) is what later corrects a STALLED session to `fix-stalled`, or
 *  clears the tag once the session finishes — this function only ever seeds the initial, confidently-known
 *  "something just started" state. */
export function defaultTagDispatchStatus({ pr, repo }) {
  return applyReviewStatus({ pr, repo, state: 'fixing' });
}

/**
 * we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs#formatRefusalLine — #x0mn6x0 (epic #4075/#3383,
 * "daemons must log every refusal and skip with its reason"): ONE printable line per refusal object, whatever
 * layer produced it. `prNumber`/`pr` is read tolerantly — the fix-side refusals (`reconcile-fix-dispatch.mjs`)
 * key on `pr`, the ci-heal-side and reconcile-core ones key on `prNumber` (the SAME inconsistency the existing
 * CLI printer already papers over — `we:scripts/operations/ci-heal-pr-dispatch.mjs`'s own IS_CLI block reads
 * `r.prNumber ?? r.pr`) — never re-derived, matched here. `label` distinguishes the two populations a tick can
 * now report: an ordinary dispatch-layer refusal (`no-lane`/`held`/`dispatch-failed`/`unsupported-repo`/
 * `no-scope`, for a PR the plan DID offer to `fix`/`ci-heal`) from a reconcile-layer one (`owed-ci-rerun`/
 * `no-findings`/`live-process`/`cap-exhausted`/`stood-down`/`owed-elsewhere`/`nothing-owed`/..., for a PR
 * `reconcile-core.mjs#planReconcile` refused OUTRIGHT and never even offered) — the exact distinction PRs
 * #2635/#2636/#2653 made invisible on 2026-09-25 (see this file's own imports' docblocks for the incident).
 * @param {string} label - `'refused'` or `'reconcile-refused'`.
 * @param {{repo?:string, kind?:string, prNumber?:(number|null), pr?:(number|null), why?:string, name?:(string|null), pid?:(number|null), cwd?:(string|null)}} r
 * @returns {string}
 */
export function formatRefusalLine(label, r) {
  const prNum = r?.prNumber ?? r?.pr ?? null;
  const prLabel = prNum == null ? '(no PR)' : `PR #${prNum}`;
  const holder = r?.kind === 'live-process' ? ` [name=${r.name ?? '?'} pid=${r.pid ?? 'absent'} cwd=${r.cwd ?? '?'}]` : '';
  return `reconcile-fix-dispatch-daemon: ${label} ${r?.kind ?? 'unknown'} ${r?.repo ?? '?'} ${prLabel} — ${r?.why ?? '(no reason given)'}${holder}`;
}

/** ONE printable line per draft the promote half un-drafted (`gh pr ready`), the success half of "log every
 *  promote outcome" (live incident 2026-10-03, PR #3806). Mirrors {@link formatRefusalLine}'s shape. */
export function formatPromoteActionLine(d) {
  if (d?.kind === 'close-superseded') {
    return `reconcile-fix-dispatch-daemon: closed ${d?.repo ?? '?'} PR #${d?.pr ?? '?'} as superseded — operator disposition (close-superseded), no fix agent`;
  }
  if (d?.kind === 'restore-review-label') {
    return `reconcile-fix-dispatch-daemon: labelled ${d?.repo ?? '?'} PR #${d?.pr ?? '?'} ${d?.label ?? 'review:pending'} — open lane PR, all required checks green, no review:* label (restore-review-label)`;
  }
  return `reconcile-fix-dispatch-daemon: promoted ${d?.repo ?? '?'} PR #${d?.pr ?? '?'} to ready for review — every required check is green (promote-draft)`;
}

/**
 * we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs#formatHungActionLine — xd1sfms (#4075/#3383): ONE
 * printable line per hung-run cancel+rerun ACTION this tick attempted (never just a count) — this card's own
 * "log each hung-run action with its reason" scope item. Mirrors {@link formatRefusalLine}'s own shape.
 * @param {{repo?:string, prNumber?:(number|null), runId?:(number|string|null), ok?:boolean, action?:string,
 *   why?:string, error?:string}} a
 * @returns {string}
 */
export function formatHungActionLine(a) {
  const prLabel = a?.prNumber == null ? '(no PR)' : `PR #${a.prNumber}`;
  const outcome = a?.ok ? `applied ${a.action}` : `FAILED ${a.action}${a?.error ? ` (${a.error})` : ''}`;
  return `reconcile-fix-dispatch-daemon: hung-ci-recovery ${a?.repo ?? '?'} ${prLabel} run ${a?.runId ?? '?'} — ${outcome} — ${a?.why ?? '(no reason recorded)'}`;
}

/**
 * we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs#formatMainRedRebaseActionLine — x5uqim1 follow-up
 * (#4075/#3383): ONE printable line per mechanical-rebase action this tick attempted. Mirrors
 * {@link formatHungActionLine}'s own shape.
 * @param {{repo?:string, prNumber?:(number|null), headRefName?:(string|null), ok?:boolean, action?:string, error?:string}} a
 * @returns {string}
 */
export function formatMainRedRebaseActionLine(a) {
  const prLabel = a?.prNumber == null ? '(no PR)' : `PR #${a.prNumber}`;
  const outcome = a?.ok ? `applied ${a.action}` : `FAILED ${a.action}${a?.error ? ` (${a.error})` : ''}`;
  return `reconcile-fix-dispatch-daemon: main-red-rebase ${a?.repo ?? '?'} ${prLabel} (${a?.headRefName ?? '?'}) — ${outcome}`;
}

/**
 * we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs#formatMissingRunActionLine — xi4od2p (#4075/#3383):
 * ONE printable line per missing-run-trigger action this tick attempted, including whether the stale `checking`
 * label was cleared. Mirrors {@link formatMainRedRebaseActionLine}'s own shape.
 * @param {{repo?:string, prNumber?:(number|null), headRefName?:(string|null), ok?:boolean, action?:string,
 *   labelCleared?:boolean, error?:string, why?:string}} a
 * @returns {string}
 */
export function formatMissingRunActionLine(a) {
  const prLabel = a?.prNumber == null ? '(no PR)' : `PR #${a.prNumber}`;
  const outcome = a?.ok ? `applied ${a.action}` : `FAILED ${a.action}${a?.error ? ` (${a.error})` : ''}`;
  const labelNote = a?.labelCleared ? ', cleared stale checking label' : '';
  return `reconcile-fix-dispatch-daemon: missing-run-recovery ${a?.repo ?? '?'} ${prLabel} (${a?.headRefName ?? '?'}) — ${outcome}${labelNote} — ${a?.why ?? '(no reason recorded)'}`;
}

/**
 * we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs#formatNoteLine — #4191 (epic #4075/#3383): ONE
 * printable line per `planReconcile` note this tick saw (`ci-heal-exhausted`/`awaiting-permission`), with its
 * own reason — mirrors {@link formatRefusalLine}'s own "never just a count" discipline, applied to the
 * population this whole card exists to stop dropping.
 * @param {{repo?:string, kind?:string, prNumber?:(number|null), text?:string}} n
 * @returns {string}
 */
export function formatNoteLine(n) {
  const prLabel = n?.prNumber == null ? '(no PR)' : `PR #${n.prNumber}`;
  return `reconcile-fix-dispatch-daemon: note ${n?.kind ?? 'unknown'} ${n?.repo ?? '?'} ${prLabel} — ${n?.text ?? '(no detail recorded)'}`;
}

/**
 * we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs#formatNoteCommentLine — #4191: ONE printable line per
 * note-comment decision this tick made (`we:scripts/conveyor/reconcile-note-comment.mjs#runReconcileNotesAllRepos`
 * — already-posted / dry-run would-post / posted / failed). The dry-run case prints the FULL comment body (not
 * just its key) — this is this card's own "don't post real PR comments in tests or the proof; show the comment
 * text it WOULD post" requirement, satisfied at the log line itself rather than a separate code path.
 * @param {{repo?:string, prNumber?:(number|null), kind?:string, key?:string, body?:string, alreadyPosted?:boolean,
 *   posted?:boolean, dryRun?:boolean, error?:string}} c
 * @returns {string}
 */
export function formatNoteCommentLine(c) {
  const prLabel = c?.prNumber == null ? '(no PR)' : `PR #${c.prNumber}`;
  const head = `reconcile-fix-dispatch-daemon: note-comment ${c?.kind ?? 'unknown'} ${c?.repo ?? '?'} ${prLabel} (${c?.key ?? '?'})`;
  if (c?.alreadyPosted) return `${head} — already posted, skipping`;
  if (c?.dryRun) return `${head} — DRY-RUN, would post:\n${c?.body ?? '(no body)'}`;
  if (c?.posted) return `${head} — posted`;
  return `${head} — FAILED to post${c?.error ? ` (${c.error})` : ''}`;
}

// xn025gx — the three pieces of glue between the tick/main() and the push-on-green core. Each is its own factory so a
// test drives the real wiring (PR #4510 review: the glue was guarded only by source-text regexes).
/** The tick's verify-verdict step (R4): the core's `runTickAwaitVerify`, with the unchanged legacy pass as its off-switch fallback. */
export function buildAwaitVerifyStep({ run = runTickAwaitVerify, legacyPass = runAwaitVerifyPassDefault } = {}) {
  return ({ allowResume }) => run({ allowResume, legacyPass });
}
/** Card x6nuodj — how many PRs waited for a fixer slot in the previous pass (null before the first pass). */
let lastFixQueueLength = null;
/** PURE: the distinct PRs a pass refused for the fixer cap or the host gate — the fix queue the next pass sizes the
 *  dynamic cap from. */
export function fixQueueLengthOf(...results) {
  const waiting = new Set();
  for (const r of results) for (const x of (r?.refusals ?? [])) {
    if (x?.kind === 'fix-cap' || x?.kind === 'host-load') waiting.add(`${x.repo ?? ''}#${x.pr ?? x.prNumber}`);
  }
  return waiting.size;
}
/** The fix/ci-heal dispatch throttle, counting the cap with R2's active-only claim list. x6nuodj: the cap is dynamic
 *  (floor..ceiling, raised when the CPU is free and the queue is long) and the host gate decides through admit(). */
export function buildFixThrottle({ slotClaims = defaultSlotCountedFixClaims, queueLength = () => lastFixQueueLength, ...rest } = {}) {
  return createResourceFixThrottle({ ...rest, queueLength, listClaims: () => slotClaims() });
}
/**
 * main()'s three exits: SIGTERM/SIGINT (`shutdown`), restart-onto-new-code (`restartOntoNewCode`) and `runDaemonLoop`
 * returning on its own (`loopEnded`). Each stops the await-verify loop child FIRST, then releases the lease (the first two
 * then exit) — a child outliving its daemon would keep pushing and waking with no one supervising it.
 */
export function buildDaemonExits({ awaitLoop, releaseLease, exit = (code) => process.exit(code), log = console } = {}) {
  let stopping = false;
  return {
    isStopping: () => stopping,
    shutdown: (signal) => {
      if (stopping) return;
      stopping = true;
      awaitLoop.stop();
      log.error(`reconcile-fix-dispatch-daemon: ${signal} — releasing the lease and exiting.`);
      releaseLease();
      exit(0);
    },
    restartOntoNewCode: () => {
      stopping = true;
      awaitLoop.stop();
      releaseLease();
      exit(0);
    },
    // The third exit: `runDaemonLoop` returned on its own. The loop child is a ref'd handle that only ends when its parent
    // PID dies, so leaving it running would keep this process alive with no lease and nobody supervising the child.
    loopEnded: (reason) => {
      awaitLoop.stop();
      if (stopping) return;
      log.error(`reconcile-fix-dispatch-daemon: loop stopped (${reason}) — releasing the lease and exiting.`);
      releaseLease();
    },
  };
}

/**
 * PURE: one log line naming how long this pass took and where the time went, slowest half first — or `null` when
 * the result carries no timing. Live 2026-10-09: the pass that ended 19:09:31Z ran 15.7 min (started 18:53:51Z)
 * and PR #4624's advisory, posted at 18:55:54Z, waited for it with no record of which half was slow.
 * @param {{phaseMs?: Record<string, number>, passMs?: number}} result
 */
export function formatPassTiming(result) {
  const phaseMs = result?.phaseMs;
  if (!phaseMs || !Number.isFinite(result?.passMs)) return null;
  const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;
  const parts = Object.entries(phaseMs).filter(([, ms]) => Number.isFinite(ms)).sort((a, b) => b[1] - a[1])
    .map(([name, ms]) => `${name} ${sec(ms)}`);
  return `pass-timing total ${sec(result.passMs)} — ${parts.join(', ') || 'no phases'}`;
}

/** Keep the historical total line intact; emit each phase exactly once alongside it. */
export function formatPassPhaseTiming(result) {
  return Object.entries(result?.phaseMs ?? {}).filter(([, ms]) => Number.isFinite(ms))
    .map(([name, ms]) => `pass-timing phase=${name} ms=${ms} budgetMs=${result?.budgets?.[name]?.budgetMs ?? 'none'} budgetHit=${result?.budgets?.[name]?.hit ?? false} prs=${result?.phasePrCounts?.[name]?.handled ?? 0} deferred=${result?.phasePrCounts?.[name]?.deferred ?? 0}`);
}

/** Build the real effects for {@link runDaemonLoop}: a real tick of {@link runTickAllRepos} (`fix` +
 *  `ci-heal`, #xngv3vn), a real interval sleep, and a real keyed lease heartbeat. Kept as its own factory
 *  (mirroring `buildCliTickEffects` in runner.mjs) so `main()` stays a thin wire-up. */
export function buildCliDaemonEffects({ owner, intervalMs = DEFAULT_INTERVAL_MS, log = console, handoffDir } = {}) {
  let heapPass = 0;
  return {
    intervalMs,
    tickOnce: () => runTickAllRepos({ tagDispatchStatus: defaultTagDispatchStatus }),
    // A send-back or CI-red label write signals the hand-off mailbox; this sleep wakes on it instead of the interval.
    sleep: createFixHandoffSleep(handoffDir ? { dir: handoffDir } : {}),
    heartbeat: () => heartbeatRunnerLease(RUNNER_LOCK_ROOT, owner, { key: RECONCILE_FIX_DISPATCH_LEASE_KEY }),
    onTick: (result) => {
      const {
        repos = [], dispatched = [], refusals = [], reconcileRefusals = [], hungCi, mainRedRebase, missingRun, promoteDraft, notes = [], noteComments = [],
        authPaused = false, authPauseReason = null, statusTags = [], awaitVerify = null, stuckFixers = null, supersede = null,
      } = result || {};
      if (result?.rulingStandDown) {
        const { setting, settingSource, rows = [] } = result.rulingStandDown;
        log.error(`ruling-resolves-stand-down: setting=${setting} (source: ${settingSource})`);
        for (const row of rows) log.error(`ruling-resolves-stand-down: ${row.repo}#${row.pr} ${row.action} stand-down=${row.standDownId ?? '?'}${row.why ? ` — ${row.why}` : ''}`);
      }
      // card xiqtf7w — one line per supersede hold planned or posted.
      for (const line of formatSupersedeLines(supersede)) log.error(`reconcile-fix-dispatch-daemon: ${line}`);
      // card xccgzu5 — one line per fixer-stuck event this tick reclaimed, held or acknowledged.
      for (const line of formatFixerStuckReclaimLines(stuckFixers)) log.error(`reconcile-fix-dispatch-daemon: ${line}`);
      // #5137 — one line per verify wait the harness acted on (pushed / re-requested / resumed), plus a waiting count.
      for (const line of formatAwaitVerifyLines(awaitVerify)) log.error(`reconcile-fix-dispatch-daemon: ${line}`);
      for (const line of formatReleaseLines(awaitVerify)) log.error(`reconcile-fix-dispatch-daemon: ${line}`); // xn025gx R5
      if (result?.factsStats) {
        const w = result.factsWarm;
        log.error(`reconcile-fix-dispatch-daemon: pr-facts ${w?.skipped ? `off (${w.skipped})` : (w?.warmed ?? []).map((x) => `${x.repo.split('/')[1]}=${x.ok ? 'store' : `github (${x.reason})`}`).join(' ')} — reads: ${formatFixReadStats(result.factsStats)}`);
      }
      log.error(`reconcile-fix-dispatch-daemon: tick (${repos.map((r) => r.repo).join(', ')}) — dispatched ${dispatched.length}, refused ${refusals.length}`);
      const timing = formatPassTiming(result);
      if (timing) log.error(`reconcile-fix-dispatch-daemon: ${timing}`);
      for (const line of formatPassPhaseTiming(result)) log.error(`reconcile-fix-dispatch-daemon: ${line}`);
      if (result?.passBudgetSettings) log.error(`reconcile-fix-dispatch-daemon: fix-pass-budget ${Object.entries(result.passBudgetSettings)
        .map(([key, setting]) => `${key}=${setting.value} source=${setting.source}`).join(', ')}`);
      heapPass += 1;
      logDaemonHeap({ daemon: 'reconcile-fix-dispatch-daemon', pass: heapPass, passMs: result?.passMs, log });
      // card x5kagse (epic #4075/#3383) — logged EVERY tick fix/ci-heal dispatch stays paused, exact wording
      // required by the card and matched by the soak scenario/live-proof read; never merely implied by an
      // empty `dispatched` count.
      if (authPaused) log.error(`reconcile-fix-dispatch-daemon: ${authPauseReason ?? 'paused: Claude login expired — run /login'}`);
      for (const r of repos) for (const h of (r.result?.terminalHoldsReleased ?? [])) {
        log.error(`reconcile-fix-dispatch-daemon: scope-hold released ${r.repo} PR #${h.pr} — ${h.why}`);
      }
      for (const r of repos) for (const rank of (r.result?.scopeRanks ?? [])) {
        log.error(`reconcile-fix-dispatch-daemon: scope-rank ${r.repo} PR #${rank.pr} — rank ${rank.rank}, blocks ${rank.blocks}, age ${rank.ageHours}h, score ${rank.score}, aged-FIFO ${rank.aged}${rank.agedAdmit ? ` — aged-admit after ${rank.agedAdmit.waitedMinutes}m (bound ${rank.agedAdmit.maxWaitMinutes}m) past ${rank.agedAdmit.bypassed.join(', ')}` : ''}`);
      }
      for (const r of repos) if (r.error) log.error(`reconcile-fix-dispatch-daemon: ${r.repo} tick failed (non-fatal, other repos unaffected): ${r.error}`);
      // #x0mn6x0 — ONE LINE PER REFUSAL, never just the count above. `refusals` = a PR the plan offered to
      // `fix`/`ci-heal` but the dispatch itself refused (no-lane, held, dispatch-failed, unsupported-repo,
      // no-scope). A `tick-failed` entry is already printed via the per-repo loop above — skip it here so it
      // is never printed twice.
      for (const r of refusals) if (r?.kind !== 'tick-failed') log.error(formatRefusalLine('refused', r));
      // LIVE INCIDENT 2026-10-03 (PR #3806): a `tick-failed` refusal from ANY half other than the fix half was
      // dropped here on the false premise that the per-repo loop above already printed it — that loop reads only
      // the fix half's `repos`. The promote half threw the stale-main guard every tick for ~15 min and logged
      // nothing at all. Print every tick-failed the per-repo loop did not (matched on repo + message).
      const printedTickErrors = new Set(repos.filter((r) => r.error).map((r) => `${r.repo}\u0000${r.error}`));
      for (const r of refusals) {
        if (r?.kind !== 'tick-failed' || printedTickErrors.has(`${r.repo}\u0000${r.why}`)) continue;
        printedTickErrors.add(`${r.repo}\u0000${r.why}`);
        log.error(formatRefusalLine('refused', r));
      }
      // ONE LINE PER PROMOTE OUTCOME — promoted (here), refused or not-planned (the `refused` loop above:
      // `draft-not-promoted`, `stale-check-*`, `ready-failed`, ...), tick-failed (just above).
      for (const d of (promoteDraft?.dispatched ?? [])) log.error(formatPromoteActionLine(d));
      // `reconcileRefusals` = a PR `reconcile-core.mjs#planReconcile` refused OUTRIGHT, never even offered to
      // `fix`/`ci-heal` (owed-ci-rerun, no-findings, live-process, cap-exhausted, stood-down, owed-elsewhere,
      // nothing-owed, ...) — previously invisible everywhere (collapsed to a bare count and dropped before it
      // ever reached this daemon's own tick result at all).
      for (const r of reconcileRefusals) log.error(formatRefusalLine('reconcile-refused', r));
      // xd1sfms (#4075/#3383) — ONE LINE PER HUNG-RUN ACTION, whether it succeeded or not (this card's own
      // "log each hung-run action with its reason" scope item). `hungCi.dispatched` here are the pass's own
      // `applied` rows (an action this tick actually attempted), never the bare refusal population already
      // covered by the `refusals` loop above.
      for (const a of (hungCi?.dispatched ?? [])) log.error(formatHungActionLine(a));
      // x5uqim1 follow-up (#4075/#3383) — ONE LINE PER MECHANICAL-REBASE ACTION, same discipline as the
      // hung-run loop just above.
      for (const a of (mainRedRebase?.dispatched ?? [])) log.error(formatMainRedRebaseActionLine(a));
      // xi4od2p (#4075/#3383) — ONE LINE PER MISSING-RUN-TRIGGER ACTION, same discipline as the two loops above.
      for (const a of (missingRun?.dispatched ?? [])) log.error(formatMissingRunActionLine(a));
      // #4191 (epic #4075/#3383) — ONE LINE PER SURFACED NOTE (`ci-heal-exhausted`/`awaiting-permission`),
      // never just a count — the exact population this card exists to stop silently dropping, plus ONE LINE
      // PER note-comment decision (already-posted / dry-run would-post, with the full body / posted / failed).
      for (const n of notes) log.error(formatNoteLine(n));
      for (const c of noteComments) log.error(formatNoteCommentLine(c));
      // #3383 follow-up — ONE LINE PER DISPATCH-TIME STATUS TAG attempt, same discipline as every other loop
      // above: a failed tag is cosmetic (never fails the tick) but must still be VISIBLE, never silent.
      for (const t of statusTags) {
        if (t?.error) log.error(`reconcile-fix-dispatch-daemon: ${t.repo}#${t.pr} review-status tag failed (non-fatal): ${t.error}`);
        else if (t?.changed) log.error(`reconcile-fix-dispatch-daemon: ${t.repo}#${t.pr} tagged ${t.label} at dispatch`);
      }
    },
    onTickError: (error) => {
      log.error(`reconcile-fix-dispatch-daemon: tick failed (non-fatal): ${String((error && error.message) || error).split('\n')[0]}`);
    },
  };
}

/**
 * we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs#withFixDispatchClaimRefresh — dup-heal-dispatch
 * (#x0jphk5 follow-up, epic #3383). Wraps `effects.tickOnce` (mirrors `we:scripts/lib/github-app-auth-env.mjs
 * #withGithubAppAuth`'s own "wrap tickOnce, forward args, delegate" shape — the SAME composition idiom `main()`
 * already chains `withSelfSync(withGithubAppAuth(...))` through) to heartbeat-refresh every live fix-dispatch
 * claim BEFORE this tick's own `fix`/`ci-heal` dispatch attempts run underneath it —
 * `we:scripts/conveyor/fix-dispatch-claim.mjs#refreshLiveFixDispatchClaims`'s own docblock has the full "why":
 * the claim's resource key no longer rotates with a PR's own head sha (the live incident this whole item
 * fixes), so a session that runs LONGER than `DEFAULT_FIX_DISPATCH_CLAIM_TTL_MINUTES` needs this refresh to
 * keep its own claim from lapsing out from under it. Kept OUT of {@link buildCliDaemonEffects} itself
 * (composed here, in `main()`, instead) so that factory's own `tickOnce` stays the exact single-expression
 * shape `we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon.test.mjs`'s own source-contract test
 * asserts (`tickOnce: () => runTickAllRepos(...)`) — this wrapper changes WHEN the refresh runs, never that
 * literal call site.
 * @param {{tickOnce:Function, [k:string]:*}} effects
 * @param {{log?:object, refresh?:Function}} [o] - `refresh` is injectable (defaults to the real
 *   {@link refreshLiveFixDispatchClaims}); a test never wants a real `claude agents --json --all` call.
 * @returns {object} the SAME effects object, with `tickOnce` wrapped.
 */
export function withFixDispatchClaimRefresh(effects, { log = console, refresh = refreshLiveFixDispatchClaims } = {}) {
  const tick = effects.tickOnce;
  return {
    ...effects,
    tickOnce: async (...args) => {
      // Best-effort: a refresh failure (a `claude`/fs hiccup) is logged, never fatal to the tick — the plain
      // TTL still recovers a claim this refresh could not reach.
      let result = { checked: 0, refreshed: [] };
      try {
        // Awaited so an async `refresh` can never hand a Promise to the loop below (PR #2789 review).
        result = await refresh();
      } catch (e) {
        log.error(`reconcile-fix-dispatch-daemon: fix-dispatch claim refresh failed (non-fatal): ${String((e && e.message) || e).split('\n')[0]}`);
      }
      for (const r of Array.isArray(result?.refreshed) ? result.refreshed : []) {
        log.error(`reconcile-fix-dispatch-daemon: refreshed live claim ${r.kind}-${r.pr} (${r.repo}) — still owned by ${r.owner}`);
      }
      for (const r of result?.released ?? []) {
        log.error(`reconcile-fix-dispatch-daemon: released ${r.reason ? 'dead borrowed' : 'settled'} claim ${r.kind}-${r.pr} (${r.repo}) — ${r.reason ?? 'overlap slot free'}`);
      }
      return tick(...args);
    },
  };
}

async function main() {
  installDaemonLog(); // item 68a: ISO-stamp every log line (WE_DAEMON_LOG_TIMESTAMPS=0 turns it off)
  const owner = makeOwner('reconcile-fix-dispatch-daemon');
  const acquired = acquireRunnerLease(RUNNER_LOCK_ROOT, owner, { key: RECONCILE_FIX_DISPATCH_LEASE_KEY });
  if (!acquired.ok) {
    // Efficiency no-op, not a safety refusal (see file header) — a live copy is already doing this work.
    console.error(`reconcile-fix-dispatch-daemon: a live instance already holds the lease (${acquired.heldBy}) — exiting.`);
    return;
  }
  // xn025gx (R4) — the fast push-on-green loop runs as this daemon's own child (the tick blocks the event loop for
  // minutes, so a timer here would starve). It exits on its own when this process is gone; the supervisor restarts it
  // (at most once a minute) if it dies, and stops it by PID — ours — on shutdown/restart. Setting off → never spawned.
  const awaitLoop = superviseAwaitVerifyLoop();
  const exits = buildDaemonExits({ awaitLoop, releaseLease: () => releaseRunnerLeaseIfOwned(RUNNER_LOCK_ROOT, owner, { key: RECONCILE_FIX_DISPATCH_LEASE_KEY }) });
  process.on('SIGTERM', () => exits.shutdown('SIGTERM'));
  process.on('SIGINT', () => exits.shutdown('SIGINT'));
  console.error(`reconcile-fix-dispatch-daemon: started on ${hostname()}:${process.pid}, tick every ${DEFAULT_INTERVAL_MS}ms.`);
  // xv6fciw — keep this daemon's dedicated clone on origin/main, and restart onto new code BETWEEN ticks
  // (launchd KeepAlive brings it back), instead of refusing every dispatch until someone re-syncs by hand.
  const selfRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
  awaitLoop.start();
  // Webhook-driven wake (flag WE_PR_EVENTS, default OFF → effects unchanged) — see we:scripts/lib/pr-events.mjs.
  const { stoppedReason } = await runDaemonLoop(
    withPrEvents(withSelfSync(withGithubAppAuth(withFixDispatchClaimRefresh(buildCliDaemonEffects({ owner })), FIX_DISPATCH_APP_AUTH_OPTS), {
      root: selfRoot, onRestart: exits.restartOntoNewCode, hasStaleRefusal: hasStaleMainRefusal,
    }), fixDaemonPrEventsOptions()),
  );
  exits.loopEnded(stoppedReason);
}

/** The fix daemon's pr-events options: with webhook waking on, a local hand-off still wakes it first. */
export function fixDaemonPrEventsOptions({ handoffDir } = {}) {
  return { role: 'fix', repos: FIX_DISPATCH_DAEMON_REPOS, localWake: createFixHandoffProbe(handoffDir ? { dir: handoffDir } : {}) };
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  main().catch((e) => { console.error(`reconcile-fix-dispatch-daemon: fatal: ${String((e && e.message) || e)}`); process.exit(1); });
}
