#!/usr/bin/env node
/**
 * @file scripts/conveyor/ci-red-recovery-watch.mjs
 * @description we:backlog/x5uqim1-*.md (parent #4075, epic #3383) — THE ACTUAL RECOVERY ACTION.
 * `we:scripts/conveyor/reconcile-core.mjs`'s new `owed-ci-rerun` refusal (see its own docblock, and
 * `we:scripts/conveyor/main-red-recovery.mjs`'s file header for the full 2026-09-25 incident) correctly stops
 * `ci-heal` from misdiagnosing a red-`main`-caused failure as a code defect — but a refusal is not a repair.
 * Something has to actually give the PR a fresh look against the now-recovered `main`. This is that something.
 *
 * CORRECTED MID-BUILD, FROM A LIVE FINDING (see `main-red-recovery.mjs`'s own header for the full story): this
 * file originally called `gh run rerun <id> --failed`. Live-measured that this does NOT work — it re-executes
 * the SAME commit the run already built, so `main`'s fix is never in that tree, and the operator's own manual
 * rerun of #2596/#2622/#2629/#2631/#2634 all concluded `failure` again for the identical reason. The real fix,
 * confirmed against the operator's own emergency correction, is to actually merge current `main` into the PR's
 * head — done here via `we:scripts/lib/rebase-drop-manifest.mjs#rebaseDropManifest`, the SAME proven,
 * no-checkout plumbing the drain itself already uses to rebuild a lane's tip onto `main` (it already knows how
 * to drop the transient `.lane-manifest.json` collision rather than colliding on it, and it is already
 * idempotent — `action:'current'` when nothing needs to change). Never a raw `git merge` or the GitHub
 * `update-branch` REST endpoint, both of which would reintroduce exactly the manifest collision that plumbing
 * exists to avoid.
 *
 * WHERE THIS LIVES, AND WHY (the item's own Fork 1 — a pass-daemon watcher, not the drain and not the
 * fix-dispatch daemon):
 *   - NOT the drain (`we:skills-src/drain/SKILL.md`). The drain's job is landing a PR that is ALREADY green and
 *     reviewed; this pass's job is the opposite direction — making a wrongly-red PR eligible to be looked at
 *     again. Folding it into the drain would conflate "watch CI state" with "land", the same conflation
 *     `ci-heal` was deliberately kept separate from `fix` for (see `reconcile-core.mjs#DISPATCH_KINDS`'s own
 *     docblock).
 *   - NOT the fix-dispatch daemon (`we:scripts/conveyor/reconcile-fix-dispatch.mjs` /
 *     `we:scripts/operations/ci-heal-pr-dispatch.mjs`). Both dispatch an AGENT — acquire a lane, fill a brief,
 *     spend a session — for work that needs JUDGMENT. Refreshing a branch onto `main` needs none: it is exactly
 *     the "script-decidable → hook, deterministic" case `we:docs/agent/platform-decisions.md
 *     #deterministic-core-thin-judgment` and this repo's own Hookable-vs-Judgment doctrine (MEMORY #51) both
 *     name — `rebaseDropManifest` is already pure git plumbing, no judgment anywhere in it. Routing this through
 *     an agent brief would spend a lane and a session on a mechanical rebase, and — worse — would be the SAME
 *     kind of category error `ci-heal` misfiring on a red-`main` PR already is: handing judgment-shaped
 *     machinery a job that has none.
 *   - IS a per-repo `pass-daemon.mjs` watcher (`we:skills-src/conveyor/daemon-manifest.mjs`), the SAME shape as
 *     its siblings in this directory (`ci-queue-watch.mjs`, `parked-pr-conflict-watch.mjs`,
 *     `parked-pr-progress-watch.mjs`) — a periodic, read-mostly CI-state check with one narrow, IDEMPOTENT
 *     side effect (`we:scripts/conveyor/main-red-recovery.mjs#planMainRedRebases`'s own cap: `already-current`
 *     once `main`'s tip is already an ancestor of the PR's head, read back off GitHub's own `compare` endpoint —
 *     no parallel store — AND `rebaseDropManifest`'s own independent `action:'current'` short-circuit). It must
 *     survive a conveyor restart on its own, for the exact reason `reconcile-pass.mjs`'s own header gives for
 *     being a resident daemon rather than folded into the tick: the tick's bookkeeping (`launchedNums`) is
 *     session-ephemeral and dies with the session that launched it.
 *
 * PURE-CORE / IO-SHELL SPLIT, mirroring `ci-queue-watch.mjs`: the pure planner
 * ({@link module:./main-red-recovery.mjs.planMainRedRebases}) is imported, not re-derived; this file owns every
 * `gh`/git call and the CLI.
 * The pr-cancelled pass grants one durable, free failed-jobs rerun per cancelled required workflow on a PR head.
 *
 * `--apply` GATES THE REAL WRITE (the rebase + push), mirroring `we:scripts/conveyor/orphan-claim-release.mjs`'s
 * own convention: bare `sweep` is a DRY RUN (plans and reports, touches nothing), `sweep --apply` actually
 * refreshes. The daemon manifest entry always passes `--apply`; an operator running this by hand gets a
 * safe-by-default dry run. `rebaseDropManifest` itself needs a real local checkout with an `origin` remote (the
 * SAME requirement every other conveyor dispatcher in this directory already has, e.g.
 * `we:scripts/operations/dispatch-lane-io.mjs#REPO_ROOT`) — it fetches the lane ref and pushes the rebuilt tip.
 */
import { readFixPush } from './fix-push-state.mjs';
import { resolveHandoffSettings } from '../lib/handoff-settings.mjs';
import { dirname, join, resolve } from 'node:path';
import { linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { handoffHome } from '../operations/handoff-home.mjs';
import { appendDaemonEvent } from '../lib/daemon-events.mjs';
import { randomUUID } from 'node:crypto';
import { isGhDeferred, isGhThrottled } from '../lib/gh-deferred.mjs';
import { readPlatformPreferences } from '../lib/policy-cascade.mjs';
import { readSettings } from '../lib/settings-files.mjs';
import { resolveCiHealBudget } from './reconcile-core.mjs';
import { resolveExhaustedRetry, exhaustionFacts, countExhaustedRetries, planExhaustedRetry, countBlockingRetryStandDowns,
  buildExhaustedRetryComment, buildExhaustedRetrySpentComment, trustedRetryMarkerComments, EXHAUSTED_RETRY_SPENT_MARKER,
  realRequiredFailures, retryOutcome, wrongSpentStandDowns, buildResolvedSpentComment,
  buildExhaustedRetryRecoveredComment, EXHAUSTED_RETRY_RECOVERED_MARKER } from './exhausted-retry.mjs';
import { excusePrMergeGateHolds } from '../lib/merge-gate-hold-class.mjs';
import { pushMissingRunCommit } from './missing-run-push.mjs';
import { sweepPrCancelledRerun, formatPrCancelledReport } from './pr-cancelled-rerun.mjs';
import { DECLARED_REQUIRED_STATUS_CHECKS, getRequiredStatusChecks } from '../lib/required-status-checks.mjs';
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { readSharedOpenPrs } from '../lib/pr-snapshot.mjs';
import { writeAllSync, writeLineSync } from '../lib/write-all-sync.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
import { countTrustedLeadingMarker } from '../lib/marker-authorship.mjs';
import { latestRequiredCheck, isRequiredCheckFailed, collapseRollupToLatestPerName, CI_LIFECYCLE_LABELS, restampAcceptance } from '../merge-ai-prs.mjs';
import { REVIEW_LABELS, hasReviewLabel } from '../lib/review-escalation.mjs';
import { spawnCiHealRearm } from './ci-heal-mark.mjs';
import {
  extractInfraSignatures, runIdFromDetailsUrl, isMainRecoveredForCheck, currentMainGreen, resolveRecoveryCaps, markerFreeText, computeMainRedWindows, planMainRedRebases, DEFAULT_MAIN_WORKFLOW_NAME, DEFAULT_REQUIRED_CHECK,
  buildHungCandidates, planHungCiRecoveries, DEFAULT_HUNG_THRESHOLD_MS, DEFAULT_MAX_HUNG_RETRIES_PER_SHA,
  classifyCiFailureAttribution, countRebaseOntoMainComments, buildRebaseOntoMainComment,
  DEFAULT_MAX_REBASE_RETRIES_PER_SHA,
  DEFAULT_REQUIRED_CONTEXTS, DEFAULT_MISSING_RUN_THRESHOLD_MS, DEFAULT_MAX_MISSING_RUN_RETRIES_PER_SHA,
  buildMissingRunCandidates, planMissingRunRecoveries, countMissingRunComments, buildMissingRunComment,
  DEFAULT_MAIN_RED_ATTRIBUTED_CHECKS, failingRequiredCheckForAttribution, isAnyRequiredCheckFailed,
  // landing-freeze fix (2026-09-27) — see `main-red-recovery.mjs`'s own "LANDING-FREEZE FIX" section header.
  mainLatestGreenShaForCheck, isMainGreenFixOwed, classifyMainDefect, classifierNeedsComments, isMainLatestCheckGreen, isMainFixedSignatureOwed,
} from './main-red-recovery.mjs';
import {
  defaultReadMainRuns, defaultReadAheadBy, defaultReadMainLatestCheckRuns, defaultReadMainGreenFixFacts,
  defaultReadMainFixedSignatureFacts,
} from './reconcile-pass.mjs';
import { pushRefusal } from './fix-procedure.mjs';
import { readCompletePrComments } from './pr-comments-complete.mjs';
import { rebaseDropManifest } from '../lib/rebase-drop-manifest.mjs';
import { gitRun } from '../lib/git-run.mjs';
import { REPO_ROOT } from '../operations/dispatch-lane-io.mjs';
import { resolveLanePoolRepoPath } from './lane-pool-health-watch.mjs';
import { readMainRedPriority } from '../lib/main-red-priority.mjs'; // card xu1nixv
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';

/** How many open PRs one sweep reads — mirrors `we:scripts/conveyor/reconcile-pass.mjs#PR_LIST_LIMIT`. */
export const PR_LIST_LIMIT = 200;

/**
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#defaultReadOpenPrs — the narrow PR read this pass needs:
 * `number`, `headRefName` (the lane ref `rebaseDropManifest` refreshes), `headRefOid` (what `defaultReadAheadBy`
 * compares) and `statusCheckRollup` (what `latestRequiredCheck` reads). `exec` is injectable so the argv is
 * assertable with no `gh` on PATH.
 * @param {{exec?:Function, repo?:string|null}} [o]
 * @returns {Array<object>}
 */
export function defaultReadOpenPrs({ exec = execFileSyncThrottled, repo = null, extraFields = [] } = {}) {
  const fields = [...new Set(['number', 'headRefName', 'headRefOid', 'statusCheckRollup', ...extraFields])];
  // #gh-graphql-budget — read the host-shared open-PR snapshot (one right-sized list per repo per TTL for the
  // whole fleet) instead of a private `gh pr list`; null = not applicable (tests, cwd repo) → the direct read below.
  if (exec === execFileSyncThrottled) { const shared = readSharedOpenPrs({ repo, fields: fields }); if (shared) return shared; }
  const argv = ['pr', 'list', '--state', 'open', '--limit', String(PR_LIST_LIMIT), '--json', fields.join(',')];
  if (repo) argv.push('--repo', repo);
  const out = exec('gh', argv, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
    timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
  });
  const parsed = JSON.parse(String(out || '[]'));
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#buildCandidates — narrow the open-PR listing to the shape
 * {@link planMainRedRebases} wants: one row per PR whose required check is currently failing, with its
 * failure's completion time and how far behind `main` its head is resolved. `readAheadBy` is called ONLY for a
 * PR that actually has a resolvable `headRefOid` — defensive; every real `gh pr list` row carries one.
 * @param {Array<object>} prs
 * @param {{requiredCheck?:string, readAheadBy?:Function, repo?:string|null, defaultBranch?:string}} [o]
 * @returns {Array<{prNumber:number, headRefName:(string|null), aheadBy:(number|null), failureCompletedAt:(string|null)}>}
 */
export function buildCandidates(prs, {
  requiredCheck = null, requiredChecks = DEFAULT_MAIN_RED_ATTRIBUTED_CHECKS, mainRedWindows = [],
  readAheadBy = defaultReadAheadBy, repo = null, defaultBranch = 'main',
} = {}) {
  // soak-main-red — EVERY required check (test/smoke/daemon-soak), not `test` alone: a PR red only on
  // `daemon-soak` inside a red-`main` window is exactly as owed a refresh onto main as a `test`-red one.
  // `requiredCheck` (singular, legacy) narrows to that one check when passed.
  const checks = requiredCheck ? [requiredCheck] : requiredChecks;
  const out = [];
  for (const pr of Array.isArray(prs) ? prs : []) {
    if (!isAnyRequiredCheckFailed(pr, checks)) continue;
    const prNumber = Number(pr?.number);
    if (!Number.isInteger(prNumber) || prNumber <= 0) continue;
    const check = failingRequiredCheckForAttribution(pr, { requiredChecks: checks, mainRedWindows });
    const aheadBy = pr?.headRefOid ? readAheadBy(pr.headRefOid, { repo, base: defaultBranch }) : null;
    out.push({
      prNumber, headRefName: pr?.headRefName ?? null, headSha: pr?.headRefOid ?? null, aheadBy,
      failureCompletedAt: check?.completedAt ?? null, detailsUrl: latestRequiredCheck(pr, check?.name)?.detailsUrl ?? null,
      // landing-freeze fix (2026-09-27) — WHICH check is the one judged, so `planMainRedRebases` can ask
      // `isMainLatestCheckGreen` about THIS SAME check on main's own latest completed run. See that function's
      // own docblock.
      failingCheckName: check?.name ?? null,
      // xo7mr6l — a PR parked `needs-human` may carry a main-defect escalation; also read comments for these (besides the merge-base-not-green case).
      needsHuman: (pr?.labels ?? []).some((l) => (typeof l === 'string' ? l : l?.name) === 'review-status:needs-human'),
    });
  }
  return out;
}

/**
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#refreshOntoMain — refresh ONE PR's lane branch onto current
 * `main`, the ONE write this pass ever performs. A thin wrapper over the shared, proven
 * `we:scripts/lib/rebase-drop-manifest.mjs#rebaseDropManifest` — never a second rebase implementation. Reports
 * `rebaseDropManifest`'s own `action` verbatim (`'rebased'` / `'current'` / `'skip'` / `'error'`) so a reader can
 * tell "refreshed" apart from "was already current" apart from "hit a real conflict, left for a human".
 * The sink guard: when the caller names the PR (`prNumber`), it must be provably same-repo
 * ({@link sameRepoRefusal}) before anything is rebased or pushed — a fork PR, or one whose head name merely
 * shadows a same-repo lane, would otherwise have `origin/<laneRef>` (someone else's branch) force-pushed.
 * @param {string} laneRef
 * @param {{root?:string, base?:string, rebase?:Function, prNumber?:number, repo?:(string|null), readIsCrossRepository?:Function}} [o]
 * @returns {{ok:boolean, action:string, error?:string, deferred?:boolean}}
 */
export function refreshOntoMain(laneRef, {
  root = REPO_ROOT, base = 'origin/main', rebase = rebaseDropManifest,
  prNumber = null, repo = null, readIsCrossRepository = defaultReadIsCrossRepository,
} = {}) {
  if (prNumber !== null) {
    const refused = sameRepoRefusal(prNumber, { repo, readIsCrossRepository });
    if (refused) return refused;
  }
  const result = rebase({ laneRef, base, cwd: root });
  if (result.action === 'error') return { ok: false, action: 'error', error: result.reason };
  if (result.action === 'skip') return { ok: false, action: 'skip', error: result.reason };
  // #2811 — `newCommit` threaded through (never dropped): `sweepCiRedRecovery`'s own apply loop needs the
  // AUTHORITATIVE post-rebase head to re-verify/re-arm a live `review:accepted` against, the same "this
  // process already knows the value it just minted, never re-derive it" reasoning `restampAcceptance`'s own
  // `--new-head` override already documents.
  return { ok: true, action: result.action, newCommit: result.newCommit ?? null }; // 'rebased' or 'current'
}

/**
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#defaultPostRebaseComment — post the durable rebase-onto-main
 * marker comment ({@link module:./main-red-recovery.mjs.buildRebaseOntoMainComment}) after EVERY attempt,
 * success or failure — mirrors {@link defaultPostHungCiComment}'s own discipline exactly.
 * @param {number} prNumber
 * @param {{exec?:Function, repo?:string|null, headRefName?:(string|null), headSha?:(string|null),
 *   ok?:boolean, action?:string, error?:(string|null)}} [o]
 */
export function defaultPostRebaseComment(prNumber, {
  exec = execFileSyncThrottled, repo = null, headRefName = null, headSha = null, mainGreen = null, ok = true, action = 'rebased', error = null,
  attribution = null, attributedWindow = null,
} = {}) {
  const argv = ['pr', 'comment', String(prNumber), '--body', buildRebaseOntoMainComment({
    headRefName, headSha, mainGreen, ok, action, error, attribution, attributedWindow,
  })];
  if (repo) argv.push('--repo', repo);
  exec('gh', argv, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
  });
}

/**
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#sweepCiRedRecovery — THE IO SHELL. Read, plan, and — only with
 * `apply: true` — act. Every reader is injectable so the whole sweep is exercisable with no network and no
 * credential.
 * @param {{repo?:string|null, apply?:boolean, requiredCheck?:string, defaultBranch?:string,
 *   readOpenPrs?:Function, readMainRuns?:Function, readAheadBy?:Function, readMainLatestCheckRuns?:Function,
 *   readMainGreenFixFacts?:Function, readRequiredContexts?:Function, readAttributedRequiredChecks?:Function,
 *   refresh?:Function}} [o]
 * @returns {{dispatch:Array<object>, refusals:Array<object>, applied:Array<object>, mainRedWindows:Array<object>,
 *   mainLatestCheckRuns:Array<object>}}
 */
export function sweepCiRedRecovery({
  repo = null, apply = false, requiredCheck = null, defaultBranch = 'main',
  readOpenPrs = defaultReadOpenPrs, readMainRuns = defaultReadMainRuns, readAheadBy = defaultReadAheadBy,
  readRequiredContexts, // Compatibility for callers injecting the original main-red reader.
  readAttributedRequiredChecks = readRequiredContexts ?? defaultReadAttributedRequiredChecks,
  // landing-freeze fix (2026-09-27) — see `main-red-recovery.mjs`'s own "LANDING-FREEZE FIX" section header.
  readMainLatestCheckRuns = defaultReadMainLatestCheckRuns, readMainGreenFixFacts = defaultReadMainGreenFixFacts,
  readMainFixedSignatureFacts = defaultReadMainFixedSignatureFacts,
  readMainFailureSignature = defaultReadMainFailureSignature, exhaustedRetrySettings = null,
  ciHealBudget = defaultCiHealBudget(), ciHealCap = ciHealBudget.cap,
  readComments = defaultReadPrComments, refresh = refreshOntoMain, postComment = defaultPostRebaseComment,
  readIsCrossRepository = defaultReadIsCrossRepository,
  maxRebaseRetriesPerSha = resolveRecoveryCaps().rebaseRetriesPerSha, checkClaim = pushRefusal,
  // #2811 — injectable so a test can pin the restamp-first/rearm-fallback chain with no `gh`/child-process.
  reconcileAcceptance = reconcileAcceptanceAfterRebase,
  // Card xu1nixv — the published red-main priority record (WE only); hermetic (null) inside a test run.
  readPriority = () => readMainRedPriority(),
} = {}) {
  const retrySettings = exhaustedRetrySettings ?? resolveExhaustedRetry();
  const prs = readOpenPrs({ repo, extraFields: ['labels', 'baseRefName'] });
  // soak-main-red — judge every REQUIRED check (shared ruleset ∪ classic-protection set when available, else
  // DEFAULT_MAIN_RED_ATTRIBUTED_CHECKS), so a `daemon-soak`-only red PR is refreshed like a `test`-red one.
  // Required checks also judge terminal retry outcomes when the CLI shares green PRs with the next pass.
  const prList = Array.isArray(prs) ? prs : [];
  const anyRed = prList.some((pr) => collapseRollupToLatestPerName(pr?.statusCheckRollup).some((c) => isRequiredCheckFailed(pr, c?.name || c?.context)));
  const checks = requiredCheck ? [requiredCheck]
    : (((anyRed || (exhaustedRetrySettings?.enabled && exhaustedRetrySettings.maxRetries > 0 && prList.length))
      ? readAttributedRequiredChecks({ repo, branch: defaultBranch }) : null) ?? DEFAULT_MAIN_RED_ATTRIBUTED_CHECKS);
  // The `gh run list --branch main` read only matters when at least one PR has a failing required check to
  // judge against it — mirrors `reconcile-pass.mjs#enrichPrsWithMainRedFacts`'s own "pay for it only when needed".
  const needWindows = prList.some((pr) => isAnyRequiredCheckFailed(pr, checks));
  const mainRuns = needWindows ? readMainRuns({ repo, branch: defaultBranch, workflowName: DEFAULT_MAIN_WORKFLOW_NAME }) : [];
  const mainGreen = currentMainGreen(mainRuns);
  const mainRedWindows = needWindows ? computeMainRedWindows(mainRuns) : [];
  // landing-freeze fix (2026-09-27) — same "pay only when needed" gate as `mainRedWindows` above: `main`'s own
  // latest completed run's per-check conclusions, the retrospection-independent fact `isMainLatestCheckGreen`
  // needs (a required check that never RAN on `main` during its own regression window opens no red window to
  // read here at all — see `main-red-recovery.mjs`'s own file header for the incident this closes). Reuses the
  // run list just read (PR #2793 review — no second `gh run list`).
  const mainLatestCheckRuns = needWindows ? readMainLatestCheckRuns({ repo, branch: defaultBranch, mainRuns }) : [];
  const rawCandidates = buildCandidates(prs, { requiredChecks: checks, mainRedWindows, readAheadBy, repo, defaultBranch });
  // x5uqim1 follow-up (#4075/#3383) — the durable per-sha rebase-attempt count (`rebaseAttemptsForSha`,
  // {@link DEFAULT_MAX_REBASE_RETRIES_PER_SHA}'s own safety net) only matters for a candidate that would
  // otherwise actually be dispatched: attributable to a red-`main` window (or, landing-freeze fix, main's own
  // latest run now passing this exact check) AND still `aheadBy > 0`. Reading a PR's comment thread only for
  // THOSE mirrors `sweepHungCiRecovery`'s own "pay for it only when needed" discipline — never one extra
  // `gh pr view` per open PR on every tick.
  // PR #2793 review — a check green on main's latest run is NOT enough on its own: the candidate also needs the
  // per-PR evidence `isMainGreenFixOwed` requires (lacks that green commit; check not already green at its merge
  // base), read only for a candidate this path could actually admit.
  const candidates = rawCandidates.map((c) => {
    let exhaustionComments;
    if (exhaustedRetrySettings?.enabled && exhaustedRetrySettings.maxRetries > 0) {
      exhaustionComments = readComments(c.prNumber, { repo });
      c = { ...c, comments: exhaustionComments, exhaustion: exhaustionFacts({ comments: exhaustionComments, ciHealBudget, ciHealCap, headSha: c.headSha }) };
    }
    if (!(c.aheadBy > 0)) return c;
    const attribution = classifyCiFailureAttribution({ failureCompletedAt: c.failureCompletedAt, mainRedWindows });
    let withFacts = c;
    let comments = exhaustionComments;
    if (attribution !== 'main-red') {
      const greenSha = mainLatestGreenShaForCheck({ failingCheckName: c.failingCheckName, mainLatestCheckRuns });
      if (greenSha) {
        withFacts = { ...c, ...readMainGreenFixFacts(c.headSha, { repo, greenSha, checkName: c.failingCheckName }) };
        // xo7mr6l: comments are also needed when merge base is green — a main-defect escalation bypasses that veto.
        // The gate is the shared classifier's own (never a private label signal: this pass does not fetch labels, so
        // the old `needsHuman` gate never fired and #4368's recorded main-defect escalation went unseen).
        if (classifierNeedsComments({ failingCheckName: c.failingCheckName, mainLatestCheckRuns, prContainsMainGreenSha: withFacts.prContainsMainGreenSha })) {
          comments ??= readComments(c.prNumber, { repo });
          withFacts.comments = comments;
        }
      }
      if (!classifyMainDefect({ requiredCheckCompletedAt: c.failureCompletedAt, mainRedWindows, mainLatestCheckRuns, ...withFacts }).mainDefect) {
        withFacts.mainFixedSignature = readMainFixedSignatureFacts({ repo, defaultBranch,
          detailsUrl: c.detailsUrl, failureCompletedAt: c.failureCompletedAt });
        if (!isMainFixedSignatureOwed(withFacts.mainFixedSignature)) {
          if (!retrySettings.enabled || retrySettings.maxRetries === 0) return withFacts;
          withFacts.mainFailureSignature = readMainFailureSignature({ repo, detailsUrl: c.detailsUrl,
            failingCheckName: c.failingCheckName, mainRuns, lookbackHours: retrySettings.lookbackHours });
          if (!withFacts.mainFailureSignature?.matched) return withFacts;
        }
      }
    }
    comments ??= readComments(c.prNumber, { repo });
    return { ...withFacts, comments, rebaseAttemptsForSha: countRebaseOntoMainComments(comments, c.headSha, { mainRedWindows, mainGreen }) };
  });
  // xd3dkzx — mainRuns (with per-check verdicts) so recovery is judged on the PR's own failing check.
  // Card xu1nixv — the red-main fix PRs (published priority record) are never told to wait for main.
  const prio = readPriority();
  const isWe = repo == null || repo === 'we' || repo === CONSTELLATION_REPOS.we.slug;
  const mainFixPrs = prio && prio.repo === 'we' && isWe ? (Array.isArray(prio.prs) ? prio.prs : [prio.pr]) : [];
  const signatureHolds = new Set();
  for (const c of candidates) {
    c.mainRecoveryOwned = existingMainRecoveryOwns(c, { mainRedWindows, mainLatestCheckRuns });
    if (!c.mainRecoveryOwned && c.mainFailureSignature?.matched && countBlockingRetryStandDowns(c.comments, c.headSha)) {
      signatureHolds.add(c);
    }
  }
  const plan = planMainRedRebases({ candidates: candidates.filter(c => !signatureHolds.has(c) && (!c.exhaustion?.exhausted || c.mainRecoveryOwned)), mainRedWindows, mainLatestCheckRuns, maxRebaseRetriesPerSha, mainRuns, mainFixPrs });
  plan.refusals.push(...[...signatureHolds].map(c => ({ ...c, kind: 'stand-down', why: 'an active stand-down requires operator resolution before signature recovery' })));

  // x5uqim1 follow-up (#4075/#3383) part (c) — "check the owed-ci-rerun path for frontierui/plateau-app too":
  // `rebaseDropManifest` needs a REAL LOCAL checkout of the repo it rebases (this file's own header). Left at
  // its old default (`REPO_ROOT`, WE's own checkout, always) this would have run every mechanical rebase in
  // the WRONG local git repo for frontierui/plateau-app — `git fetch origin <laneRef>` against WE's own
  // `origin` remote, which just fails cleanly (no matching ref) rather than corrupting anything, but never
  // actually refreshes those repos' PRs either. `resolveLanePoolRepoPath` (already used the identical way by
  // `we:scripts/conveyor/lane-pool-health-watch.mjs`) resolves the SAME sibling checkout path every other
  // multi-repo conveyor pass already reads from (`we:scripts/lib/constellation-repos.mjs#CONSTELLATION_REPOS`),
  // returning `null` for `we` itself (kept on `REPO_ROOT`, unchanged).
  const repoRoot = resolveLanePoolRepoPath(repo) ?? REPO_ROOT;

  const applied = [];
  if (apply) {
    for (const d of plan.dispatch) {
      const held = checkClaim({ repo, branch: d.headRefName });
      // Passing prNumber makes refreshOntoMain verify the PR is same-repo before it rebases and force-pushes.
      const result = held ? { ok: false, error: held.message }
        : refresh(d.headRefName, { base: `origin/${defaultBranch}`, root: repoRoot, prNumber: d.prNumber, repo, readIsCrossRepository });
      // 2026-10-10 live: #4784 claim-held refusals burned the cap. A failed push re-reads the claim store (the push
      // race); the failure text is never trusted to say a claim is held (PR #4825 round 4).
      if (held || result.deferred || (!result.ok && checkClaim({ repo, branch: d.headRefName }))) {
        applied.push({ prNumber: d.prNumber, headRefName: d.headRefName, ok: false, action: 'deferred', deferred: true, error: result.error });
        continue;
      }
      // Posted on EVERY attempt, success or failure — mirrors `sweepHungCiRecovery`'s own discipline: a
      // permanently-failing refresh must still trip {@link DEFAULT_MAX_REBASE_RETRIES_PER_SHA}'s cap, not
      // retry forever silently.
      postComment(d.prNumber, {
        repo, headRefName: d.headRefName, headSha: d.headSha, mainGreen, ok: result.ok, action: result.action, error: result.error ?? null,
        ...(d.attribution ? { attribution: d.attribution, attributedWindow: d.attributedWindow } : {}),
      });
      // #2811 — the ONE new step: this rebase just moved the head (`action === 'rebased'` — never on
      // `'current'`, which minted nothing new to re-verify against). Best-effort, never throws (see the
      // function's own docblock); a `review:accepted` PR gets carried forward (content-preserving) or
      // reverted to pending (genuinely stale) before the next tick's reconcile pass ever reads this PR again.
      let acceptance = { attempted: false, restamped: false, rearmed: false };
      if (result.ok && result.action === 'rebased' && result.newCommit) {
        acceptance = reconcileAcceptance({ prNumber: d.prNumber, newHead: result.newCommit, repo, root: repoRoot });
      }
      applied.push({ prNumber: d.prNumber, headRefName: d.headRefName, ...result, acceptance });
    }
  }
  // Keep discovery rows too: a retry can have gone green (or be missing checks) since the last tick.
  // The exhausted pass merges these with the attributed candidates instead of rebuilding ownership.
  return { ...plan, applied, mainRedWindows, mainLatestCheckRuns, mainRuns, candidates, prs: prList, requiredChecks: checks };
}

// live PR #5195, 2026-10-14: read FAILED sibling logs, not just the aggregate check's 3s log.
export function defaultReadMainFailureSignature({ repo, detailsUrl, failingCheckName, mainRuns = [],
  exec = execFileSyncThrottled, lookbackHours = 72, now = Date.now() } = {}) {
  const runId = runIdFromDetailsUrl(detailsUrl);
  if (!runId) return { matched: false };
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
    timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' };
  const readSignatures = id => {
    const jobs = JSON.parse(String(exec('gh', ['api', `repos/${repoSlug(repo)}/actions/runs/${id}/jobs?per_page=100`], options))).jobs;
    if (!Array.isArray(jobs)) throw new Error('unreadable jobs');
    const found = new Set();
    for (const job of jobs.filter(j => ['failure', 'timed_out'].includes(j.conclusion)).slice(0, 6)) {
      for (const signature of extractInfraSignatures(exec('gh', ['api', `repos/${repoSlug(repo)}/actions/jobs/${job.id}/logs`], options))) found.add(signature);
    }
    return [...found];
  };
  try {
    const signatures = readSignatures(runId);
    if (!signatures.length) return { matched: false };
    const runs = (Array.isArray(mainRuns) ? mainRuns : []).filter(r => r.conclusion === 'failure'
      && Date.parse(r.updatedAt) >= now - lookbackHours * 3600000 && Date.parse(r.updatedAt) <= now)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 4);
    for (const run of runs) {
      const shared = readSignatures(run.databaseId ?? run.id).find(id => signatures.includes(id));
      if (shared) return { matched: true, signature: shared, mainRunId: run.databaseId ?? run.id, mainSha: run.headSha };
    }
    return { matched: false, signature: signatures[0] };
  } catch { return null; }
}

function defaultCiHealBudget(env = process.env) {
  return resolveCiHealBudget({ env, platform: readPlatformPreferences({ env }).prefs, repo: readSettings()?.ciHeal });
}

function existingMainRecoveryOwns(c, { mainRedWindows = [], mainLatestCheckRuns = [] } = {}) {
  const cls = classifyMainDefect({ ...c, requiredCheckCompletedAt: c.failureCompletedAt, mainRedWindows, mainLatestCheckRuns });
  return cls.mainDefect && cls.via !== 'main-failure-signature';
}

export function defaultReadMainTip({ repo, defaultBranch = 'main', exec = execFileSyncThrottled } = {}) {
  const out = exec('gh', ['api', `repos/${repoSlug(repo)}/commits/${defaultBranch}`], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
  });
  const tip = JSON.parse(String(out));
  return { sha: tip.sha, committedAt: tip.commit?.committer?.date ?? null };
}

export function defaultPostExhaustedRetryComment(prNumber, { body, repo, exec = execFileSyncThrottled } = {}) {
  const out = exec('gh', ['pr', 'comment', String(prNumber), '--repo', repoSlug(repo), '--body', body], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
  });
  if (isGhDeferred(out)) throw new Error('exhausted-retry comment publication deferred');
}

/** Edit our own erroneous stand-down using the node id returned by the complete comment reader. */
export function defaultEditExhaustedRetryComment(commentId, { body, repo, exec = execFileSyncThrottled } = {}) {
  const out = exec('gh', ['api', 'graphql', '-f',
    'query=mutation($id:ID!,$body:String!){updateIssueComment(input:{id:$id,body:$body}){issueComment{id}}}',
    '-f', `id=${commentId}`, '-f', `body=${body}`], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
  });
  const result = JSON.parse(String(out || '{}'));
  if (result.errors?.length || result.data?.updateIssueComment?.issueComment?.id !== commentId) {
    throw new Error('could not resolve exhausted-retry stand-down');
  }
}

export function sweepExhaustedRetry({ repo = null, apply = false, defaultBranch = 'main', settings = resolveExhaustedRetry(),
  ciHealBudget = defaultCiHealBudget(), ciHealCap = ciHealBudget.cap, now = Date.now(), candidates = null, mainRuns = null,
  prs: sharedPrs = null, requiredChecks: sharedRequiredChecks = null,
  excuseHolds = excusePrMergeGateHolds, editComment = defaultEditExhaustedRetryComment,
  readOpenPrs = defaultReadOpenPrs, readAttributedRequiredChecks = defaultReadAttributedRequiredChecks,
  readAheadBy = defaultReadAheadBy, readComments = defaultReadPrComments, readMainRuns = defaultReadMainRuns,
  readMainTip = defaultReadMainTip, readMainFailureSignature = defaultReadMainFailureSignature,
  refresh = refreshOntoMain, trigger = triggerCiForPr, postComment = defaultPostExhaustedRetryComment,
  checkClaim = pushRefusal, readIsCrossRepository = defaultReadIsCrossRepository,
  reconcileAcceptance = reconcileAcceptanceAfterRebase,
} = {}) {
  const dispatch = [], refusals = [], applied = [];
  if (!settings.enabled || settings.maxRetries === 0) return { dispatch, refusals, applied, settings };
  if (candidates === null || sharedPrs !== null) {
    // Listings nominate PRs only. Marker-dependent mutations require a complete live thread, even when
    // discovery supplied fewer than 100 comments. Shared candidates carry the first pass's live reads.
    const raw = sharedPrs ?? readOpenPrs({ repo, extraFields: ['labels'] });
    const prs = excuseHolds(Array.isArray(raw) ? raw : [], { repo });
    const checks = sharedRequiredChecks ?? (prs.length ? readAttributedRequiredChecks({ repo, branch: defaultBranch }) : []);
    const requiredChecks = checks ?? DEFAULT_MAIN_RED_ATTRIBUTED_CHECKS;
    const shared = new Map((candidates ?? []).map(c => [c.prNumber, c]));
    candidates = prs.filter(pr => Number.isInteger(pr.number) && pr.number > 0).map(pr => {
      const failures = realRequiredFailures(pr, requiredChecks);
      const candidate = shared.get(pr.number) ?? (failures.length
        ? buildCandidates([pr], { requiredChecks: failures, readAheadBy, repo, defaultBranch })[0] : null);
      return { prNumber: pr.number, headRefName: pr.headRefName, headSha: pr.headRefOid,
        ...candidate, pr, requiredChecks };
    });
  }
  let mainTip;
  for (const c of candidates) {
    const comments = c.comments ?? readComments(c.prNumber, { repo });
    const facts = c.exhaustion ?? exhaustionFacts({ comments, ciHealBudget, ciHealCap, headSha: c.headSha });
    const outcome = c.pr ? retryOutcome({ comments, pr: c.pr, requiredChecks: c.requiredChecks }) : null;
    const wrongSpent = c.pr ? wrongSpentStandDowns({ comments, pr: c.pr, requiredChecks: c.requiredChecks }) : [];
    if (outcome?.state === 'recovered' || wrongSpent.length) {
      const recovered = trustedRetryMarkerComments(comments, EXHAUSTED_RETRY_RECOVERED_MARKER)
        .some(comment => bodyHasExactLine(comment.body, `head: ${c.headSha}`));
      if (apply) {
        for (const comment of wrongSpent) {
          editComment(comment.id, { repo, body: buildResolvedSpentComment(comment, c.headSha) });
          applied.push({ prNumber: c.prNumber, kind: 'spent-stand-down-resolved', ok: true, commentId: comment.id });
        }
        if (!recovered) {
          postComment(c.prNumber, { repo, body: buildExhaustedRetryRecoveredComment({ kind: facts.kind ?? c.exhaustion?.kind ?? 'exhaustion', headSha: c.headSha }) });
          applied.push({ prNumber: c.prNumber, kind: 'exhausted-retry-recovered', ok: true });
        }
      }
      continue;
    }
    if (!facts.exhausted) continue;
    if (outcome?.state === 'pending') {
      refusals.push({ ...c, action: 'wait', kind: 'wait', why: `the retried CI run has not finished on ${c.headSha?.slice(0, 7)}` });
      continue;
    }
    if (c.pr && !realRequiredFailures(c.pr, c.requiredChecks).length) continue;
    mainRuns ??= readMainRuns({ repo, branch: defaultBranch, workflowName: DEFAULT_MAIN_WORKFLOW_NAME });
    // Existing main attribution keeps its recovery gates and per-head cap, even after heal exhaustion.
    if (c.mainRecoveryOwned ?? existingMainRecoveryOwns({ ...c, comments }, { mainRedWindows: computeMainRedWindows(mainRuns) })) continue;
    mainTip ??= readMainTip({ repo, defaultBranch });
    // Shared candidates from the red sweep carry the already-read signature facts (including a failed read).
    const signature = Object.hasOwn(c, 'mainFailureSignature') ? c.mainFailureSignature
      : readMainFailureSignature({ repo, detailsUrl: c.detailsUrl, failingCheckName: c.failingCheckName, mainRuns, lookbackHours: settings.lookbackHours });
    const decision = planExhaustedRetry({ facts, retriesUsed: countExhaustedRetries(comments), settings, mainTip,
      aheadBy: c.aheadBy, now, mainFailureSignature: signature, outcome, headSha: c.headSha,
      mainRecoveredForCheck: isMainRecoveredForCheck({ checkName: c.failingCheckName, mainRuns, failureCompletedAt: c.failureCompletedAt }) });
    const d = { ...c, ...decision, kind: decision.action, exhaustionKind: facts.kind };
    if (decision.action !== 'retry') {
      if (decision.action === 'none') continue;
      refusals.push(d);
      const spent = trustedRetryMarkerComments(comments, EXHAUSTED_RETRY_SPENT_MARKER)
        .some(comment => bodyHasExactLine(comment.body, `head: ${c.headSha}`));
      if (apply && decision.action === 'needs-you' && !spent) {
        postComment(c.prNumber, { repo, body: buildExhaustedRetrySpentComment({ kind: facts.kind, check: c.failingCheckName, headSha: c.headSha }) });
      }
      continue;
    }
    if (countBlockingRetryStandDowns(comments, c.headSha)) {
      refusals.push({ ...c, action: 'wait', kind: 'stand-down', why: 'an active stand-down other than fix-loop exhaustion requires operator resolution' });
      continue;
    }
    dispatch.push(d);
    if (!apply) continue;
    const root = resolveLanePoolRepoPath(repo) ?? REPO_ROOT;
    const held = checkClaim({ repo, branch: c.headRefName });
    if (held) {
      refusals.push({ ...d, kind: 'exhausted-retry-failed', why: held.message });
      applied.push({ prNumber: c.prNumber, ok: false, deferred: true, error: held.message });
      continue;
    }
    const attempt = { prNumber: c.prNumber, kind: facts.kind, trigger: decision.trigger, mode: decision.mode,
      mainSha: mainTip.sha, headSha: c.headSha, why: decision.why, attemptId: randomUUID() };
    // Persist consumption BEFORE either side effect. If this write fails, no retry may execute.
    postComment(c.prNumber, { repo, body: buildExhaustedRetryComment({ ...attempt, reserved: true }) });
    let result;
    try {
      const claimed = checkClaim({ repo, branch: c.headRefName });
      result = claimed ? { ok: false, deferred: true, error: claimed.message }
        : decision.mode === 'rebase' ? refresh(c.headRefName, { repo, root, base: `origin/${defaultBranch}`, prNumber: c.prNumber, readIsCrossRepository })
        : trigger(c, { repo: repoSlug(repo), defaultBranch });
    } catch (e) { result = { ok: false, error: describeExecError(e) }; }
    if (!result.ok && checkClaim({ repo, branch: c.headRefName })) result = { ...result, deferred: true };
    if (!result.ok || result.deferred) {
      refusals.push({ ...d, kind: 'exhausted-retry-failed', why: result.error ?? 'retry deferred' });
    }
    // Once reserved, even an ambiguous deferral consumes the attempt. A failed outcome write cannot refund it.
    postComment(c.prNumber, { repo, body: buildExhaustedRetryComment({ ...attempt,
      retryHeadSha: result.newCommit ?? result.newHeadSha ?? c.headSha, ok: result.ok && !result.deferred }) });
    if (result.ok && result.action === 'rebased' && result.newCommit) reconcileAcceptance({ prNumber: c.prNumber, newHead: result.newCommit, repo, root });
    applied.push({ prNumber: c.prNumber, ...result });
  }
  return { dispatch, refusals, applied, settings };
}

export function formatExhaustedRetryReport({ dispatch = [], refusals = [], applied = [], settings } = {}) {
  const lines = [`exhausted-retry: ${Object.entries(settings?.sources ?? {}).map(([key, source]) => `${key}=${settings[key]} (${source})`).join(' ')}${settings?.invalid?.length ? ` ignored invalid: ${settings.invalid.join('; ')}` : ''}`,
    `exhausted-retry — ${dispatch.length} retry(s), ${refusals.length} refusal(s), ${applied.length} applied`];
  for (const d of dispatch) lines.push(`  → ${d.mode} PR #${d.prNumber} — ${d.why}`);
  for (const r of refusals) lines.push(`  ✗ ${r.kind} PR #${r.prNumber} — ${r.why}`);
  for (const a of applied) lines.push(`  ${a.ok ? '✓' : '✗'} PR #${a.prNumber} — ${a.action ?? a.error}`);
  return lines.join('\n');
}

// ── HUNG-CI-RUN RECOVERY (we:backlog/xd1sfms-*.md, parent #4075/#3383) ─────────────────────────────────────────
// See `we:scripts/conveyor/main-red-recovery.mjs`'s own "HUNG-CI-RUN RECOVERY" section header for the full
// incident (#2636, run 36161558017) and why this reasons about the whole CI *run*, never just the named
// required check. This half owns every real IO the hung-run pass needs: reading a PR's comment thread (to
// recover the durable per-sha attempt count), the one real write (`gh run cancel` then `gh run rerun`), and
// posting the durable marker comment that write leaves behind.

/** we:scripts/conveyor/ci-red-recovery-watch.mjs#HUNG_CI_COMMENT_MARKER — the stable FIRST LINE of the durable
 *  hung-recovery comment, mirroring `we:scripts/conveyor/ci-heal-mark.mjs#CI_HEAL_COMMENT_MARKER`'s own shape.
 *  Distinct marker text (and, unlike that file, scoped to one head sha per {@link countHungCiComments} AND to
 *  one job name per {@link countHungCiCommentsByJob}) so the two attempt caps never cross-count. Posted on
 *  EVERY attempt now — success or failure (see `sweepHungCiRecovery`'s own docblock for why a failed cancel
 *  must still count) — so the body always states the real outcome, never implying a rerun that never happened. */
export const HUNG_CI_COMMENT_MARKER = '⏱️ conveyor CI-hung-recovery';

/**
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#buildHungCiComment — the durable comment body posted after
 * EVERY hung-run attempt, whatever its outcome. Its first line MUST be {@link HUNG_CI_COMMENT_MARKER}; its body
 * embeds `sha: <headSha>` (so {@link countHungCiComments} can scope its count to the CURRENT head sha only — a
 * new push must start that cap fresh, see `main-red-recovery.mjs`'s own docblock for why) AND `job: <jobName>`
 * (so {@link countHungCiCommentsByJob} can recognise the SAME job hanging again on a later, different sha —
 * the repeat-hang signal `main-red-recovery.mjs#planHungCiRecoveries` escalates on). LIVE 2026-09-25,
 * orchestrator-flagged: the very first version of this function silently dropped the real `gh` stderr on a
 * failed cancel (truncated to the exec error's own first line, "Command failed: gh run cancel …", which never
 * contains the actual reason) — `error` now carries the real text a caller like `cancelAndRerunHungRun`
 * captured, so a permission gap (a GitHub App token missing `actions:write`, the concrete cause found live) or
 * a "run already completing" race is VISIBLE on the PR itself, not just swallowed. PURE.
 * @param {{actor?:string, runId?:(number|string|null), headSha?:(string|null), jobName?:(string|null),
 *   kind?:string, reason?:string|null, ok?:boolean, action?:string, error?:(string|null), cancelError?:(string|null)}} o
 * @returns {string}
 */
export function buildHungCiComment({
  actor = 'conveyor CI-hung-recovery', runId = null, headSha = null, jobName = null,
  kind = 'hung-cancel-rerun', reason = null, ok = true, action = 'cancelled-and-rerun', error = null, cancelError = null,
} = {}) {
  const outcome = ok
    ? (reason === 'run-not-found-retrigger'
      ? `could not cancel run ${runId ?? '?'}; triggered CI for the current PR head via "${markerFreeText(action)}".`
      : kind === 'repeat-hang'
      ? `cancelled run ${runId ?? '?'} (job "${jobName ?? '?'}") and did NOT re-run it — this job has hung before on a different head, so this is handed to ci-heal for a real diagnosis instead of retried again.`
      : kind === 'hung-cap-escalate'
        ? `cancelled run ${runId ?? '?'} (job "${jobName ?? '?'}") and did NOT re-run it — this head sha's own hung-recovery retries are exhausted, so this is handed to ci-heal instead of left for GitHub's own job timeout-minutes, which this PR's branch predates.`
        : `found run ${runId ?? '?'} stuck in_progress/queued past the hung threshold; cancelled it and asked GitHub to re-run it.`)
    : `attempted "${action}" on run ${runId ?? '?'} and it FAILED: ${error == null ? '(no error text captured)' : markerFreeText(error)} — this attempt still counts toward the retry cap so a permanently-failing action (e.g. a token missing \`actions:write\`) cannot retry forever.`;
  return [
    HUNG_CI_COMMENT_MARKER,
    '',
    `sha: ${headSha ?? '(unknown)'}`,
    `run: ${runId ?? '(unknown)'}`,
    `job: ${jobName ?? '(unknown)'}`,
    ...(reason ? [`reason: ${markerFreeText(reason)}`] : []),
    ...(cancelError != null ? [`Original cancel error: ${markerFreeText(cancelError)}`] : []),
    `${actor} ${outcome}`,
  ].join('\n');
}

/**
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#countHungCiComments — the DURABLE, restart-surviving hung-run
 * attempt count for ONE head sha, mirroring `we:scripts/conveyor/ci-heal-mark.mjs#countCiHealComments`'s own
 * "the count IS PR state" discipline, narrowed to `headSha` (see {@link buildHungCiComment}'s own docblock for
 * why a new push must not inherit a previous sha's count). Delegates the leading-line-+-trusted-author match
 * itself to `we:scripts/lib/marker-authorship.mjs#countTrustedLeadingMarker` — the ONE shared answer every
 * durable marker counter in this repo now runs through (#3383 adversarial-review finding: a forged marker from
 * an untrusted login must never inflate a real cap) — never re-derived here; this function's only own logic is
 * the per-sha pre-filter that function doesn't know about. Counts EVERY attempt marker regardless of outcome
 * (success or failure — see {@link buildHungCiComment}'s own docblock for why a failed attempt still counts).
 * PURE.
 * @param {Array<{body?:string}|string>|null|undefined} comments - as `gh pr view <pr> --json comments` returns.
 * @param {string|null} [headSha] - when given, only a marker whose body names THIS sha counts; omitted counts
 *   every trusted hung-recovery marker on the PR regardless of sha (used only when the caller has no sha yet).
 * @returns {number}
 */
/**
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#bodyHasExactLine — does `body` contain `line` as a WHOLE LINE
 * (bounded by string-start/newline on one side and newline/string-end on the other), never merely as a
 * substring? LIVE 2026-09-25, adversarial-review-caught (PR #2693): the original `countHungCiComments`/
 * `countHungCiCommentsByJob` used a bare `body.includes(needle)`, so job name `"test"` matched INSIDE
 * `"job: test-shard (1)"` (confirmed: `'job: test-shard (1)'.includes('job: test')` → `true`) — a job whose
 * name is a text-prefix of a sibling job's name (exactly the `"test"` / `"test-shard (1)"` pair this same PR's
 * own p95 comment names) would inherit the OTHER job's hung-attempt history, denying it its own first
 * legitimate retry. Anchoring the match to a full line closes this for both the `sha:` and `job:` marker
 * fields — never re-derived per call site. PURE.
 * @param {string} body
 * @param {string} line - the exact line to look for, WITHOUT a trailing newline.
 * @returns {boolean}
 */
export function bodyHasExactLine(body, line) {
  if (typeof body !== 'string' || typeof line !== 'string' || !line) return false;
  return body.split('\n').some((l) => l === line);
}

export function countHungCiComments(comments, headSha = null) {
  if (!Array.isArray(comments)) return 0;
  const scoped = headSha
    ? comments.filter((c) => bodyHasExactLine(typeof c === 'string' ? c : c?.body, `sha: ${headSha}`))
    : comments;
  return countTrustedLeadingMarker(scoped, HUNG_CI_COMMENT_MARKER);
}

/**
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#countHungCiCommentsByJob — the DURABLE count of how many times
 * ONE job name has hung on this PR, ACROSS EVERY head sha it has ever had — the repeat-hang signal
 * `we:scripts/conveyor/main-red-recovery.mjs#planHungCiRecoveries` escalates on (xd1sfms follow-up, live
 * 2026-09-25: #2636's `test-shard (1)` hung on TWO different shas in a row). Deliberately NOT scoped by sha,
 * unlike {@link countHungCiComments} — a rebase/refresh changes the sha but never explains away the SAME shard
 * hanging again; scoping by sha here would reset the very signal this function exists to keep. Matches the
 * `job:` line EXACTLY ({@link bodyHasExactLine}) — see that helper's own docblock for the live adversarial-
 * review finding a bare substring match let through (`"test"` falsely matching inside `"test-shard (1)"`).
 * PURE.
 * @param {Array<{body?:string}|string>|null|undefined} comments
 * @param {string|null} jobName - when given, only a marker whose body names THIS job counts; omitted counts
 *   every trusted hung-recovery marker on the PR regardless of job (used only when the caller has no job yet).
 * @returns {number}
 */
export function countHungCiCommentsByJob(comments, jobName = null) {
  if (!Array.isArray(comments)) return 0;
  const scoped = jobName
    ? comments.filter((c) => bodyHasExactLine(typeof c === 'string' ? c : c?.body, `job: ${jobName}`))
    : comments;
  return countTrustedLeadingMarker(scoped, HUNG_CI_COMMENT_MARKER);
}

/**
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#defaultReadPrComments — read one candidate's complete live
 * thread for recovery budgets, deduplication and stand-down edits. Preserve author, timestamp and node id.
 * @param {number} prNumber
 * @param {{exec?:Function, repo?:string|null}} [o]
 * @returns {Array<object>}
 */
export function defaultReadPrComments(prNumber, { exec = execFileSyncThrottled, repo = null } = {}) {
  return readCompletePrComments(prNumber, { repo: repoSlug(repo), exec });
}

/** we:scripts/conveyor/ci-red-recovery-watch.mjs#defaultReadPrLabels — #2811. The one extra read the rebase
 *  applied loop pays, and ONLY for a PR it just successfully rebased: does this head-moving mechanical rebase
 *  need to say anything about a live `review:accepted`? Mirrors `defaultReadPrComments`'s own shape exactly. */
export function defaultReadPrLabels(prNumber, { exec = execFileSyncThrottled, repo = null } = {}) {
  const argv = ['pr', 'view', String(prNumber), '--json', 'labels'];
  if (repo) argv.push('--repo', repo);
  const out = exec('gh', argv, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
    timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
  });
  const parsed = JSON.parse(String(out || '{}'));
  return Array.isArray(parsed?.labels) ? parsed.labels : [];
}

/**
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#reconcileAcceptanceAfterRebase — #2811 (web-everything/web-everything
 * PR #2811 live incident). This watcher's OWN rebase (`refreshOntoMain`, a MECHANICAL `rebaseDropManifest` —
 * never a code edit) moves the head exactly like a ci-heal's re-push does, and a live `review:accepted` it
 * leaves behind is stale for the same reason (`ci-heal-mark.mjs`'s own header: an acceptance is a claim about a
 * SPECIFIC head). Two DIFFERENT outcomes are both legitimate, so BOTH existing swaps are tried, in order, never
 * a THIRD hand-rolled label write:
 *   1. `restampAcceptance` FIRST — if the rebase was genuinely content-preserving (the reviewed diff/contribution
 *      fingerprint still matches, `acceptanceCoversHead`'s own content-equivalence escape), the acceptance
 *      legitimately still covers this tree and should be CARRIED FORWARD, not thrown away — that is exactly what
 *      `we:scripts/lib/review-escalation.mjs#decideSetLabel`'s `restamp` target exists for (#x5e2ldj).
 *   2. Only when restamp REFUSES (no accepted label to carry at all — the common case — OR the content genuinely
 *      changed, so the fingerprint no longer matches) does this fall back to the WIDENED `rearm` swap (#2811),
 *      reverting a truly-stale acceptance to `review:pending` so a fresh review is owed.
 * Never both: a successful restamp already leaves `review:accepted` live, so a SUBSEQUENT rearm call would
 * immediately undo it — the `if (!restamped.ok)` gate is load-bearing, not an optimisation.
 * Best-effort throughout (mirrors `postComment`'s own "never let a write failure sink the pass" discipline) —
 * this NEVER re-throws; a failure here leaves the label exactly as it was, next tick's pass gets another try.
 * @param {{prNumber:number, newHead:string, repo?:string|null, root?:string, readLabels?:Function,
 *   restamp?:Function, rearm?:Function}} o
 * @returns {{attempted:boolean, restamped:boolean, rearmed:boolean}}
 */
export function reconcileAcceptanceAfterRebase({
  prNumber, newHead, repo = null, root = REPO_ROOT,
  readLabels = defaultReadPrLabels, restamp = restampAcceptance, rearm = spawnCiHealRearm,
} = {}) {
  try {
    const labels = readLabels(prNumber, { repo });
    if (!hasReviewLabel(labels, REVIEW_LABELS.accepted)) return { attempted: false, restamped: false, rearmed: false };
    const restamped = restamp({ pr: prNumber, repo, newHead, cwd: root });
    if (restamped.ok) return { attempted: true, restamped: true, rearmed: false };
    const rearmed = rearm({
      pr: prNumber, repo, cwd: root,
      actor: 'conveyor mechanical rebase (ci-red-recovery-watch)',
    });
    return { attempted: true, restamped: false, rearmed: rearmed.ok };
  } catch {
    return { attempted: false, restamped: false, rearmed: false };
  }
}

/**
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#defaultPostHungCiComment — post the durable marker comment
 * ({@link buildHungCiComment}) after EVERY hung-run attempt, success or failure (see `sweepHungCiRecovery`'s
 * own docblock for why a failed attempt must still be recorded — never conditioned on `ok` here or by the
 * caller).
 * @param {number} prNumber
 * @param {{exec?:Function, repo?:string|null, runId?:(number|null), headSha?:(string|null),
 *   jobName?:(string|null), kind?:string, reason?:string|null, ok?:boolean, action?:string, error?:(string|null), cancelError?:(string|null)}} [o]
 */
export function defaultPostHungCiComment(prNumber, {
  exec = execFileSyncThrottled, repo = null, runId = null, headSha = null, jobName = null,
  kind = 'hung-cancel-rerun', reason = null, ok = true, action = 'cancelled-and-rerun', error = null, cancelError = null,
} = {}) {
  const argv = ['pr', 'comment', String(prNumber), '--body', buildHungCiComment({
    runId, headSha, jobName, kind, reason, ok, action, error, cancelError,
  })];
  if (repo) argv.push('--repo', repo);
  exec('gh', argv, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
  });
}

/** we:scripts/conveyor/ci-red-recovery-watch.mjs#defaultSleepSync — a bounded, SYNCHRONOUS pause, used only to
 *  give GitHub a moment to actually land a cancellation before the immediately-following rerun request (a
 *  rerun asked for before the cancel lands is rejected by GitHub's own API). Kept synchronous — like every
 *  other effect in this file — rather than turning this whole module async for one call site; injectable so
 *  tests never actually sleep. */
export function defaultSleepSync(ms) {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

/**
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#describeExecError — LIVE 2026-09-25, orchestrator-flagged: the
 * first version of every `cancel*`/`rerun*` catch block here reported only `String(e.message).split('\n')[0]`
 * — for a Node `execFileSync` child-process failure that is JUST `"Command failed: gh run cancel 123 …"`, the
 * ACTUAL reason (`gh`'s own stderr — e.g. a GitHub App token missing the `actions:write` scope, or "run is
 * already completed") lives in `e.stderr` (or on the later lines of `e.message`), which that truncation threw
 * away. Confirmed live: the daemon's own log for #2636 showed exactly this useless first line while the real
 * cause sat unread in `e.stderr`. Prefers `e.stderr` (trimmed, capped) when present and non-empty; falls back
 * to the full `e.message` (not just its first line) otherwise. PURE (no IO of its own — reads only the error
 * object handed to it).
 * @param {*} e
 * @returns {string}
 */
/**
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#redactTokenShapes — strip a GitHub token shape out of text
 * before it can reach a PUBLIC surface (a PR comment). Adversarial-review-caught, live 2026-09-25 (PR #2693's
 * own round-1 review, security/information-exposure): `describeExecError` started forwarding raw `gh` stderr
 * (capped at 500 chars) verbatim into a public comment — reasonable per this card's own goal ("real stderr
 * surfaces on the PR"), but with no redaction safety net for the low-likelihood case that stderr ever echoes
 * more than plain API error text (a proxy layer, a future `gh` regression). Mirrors the SAME pattern
 * `we:scripts/lib/daemon-rebuild.mjs`'s own (private) `redactDetail` already uses for its alerts log — never
 * re-derived as a different shape, just re-applied here since that function isn't exported. PURE.
 * @param {string} text
 * @returns {string}
 */
export function redactTokenShapes(text) {
  return String(text ?? '').replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '$1<redacted>');
}

export function describeExecError(e) {
  const stderr = typeof e?.stderr === 'string' ? e.stderr.trim() : (Buffer.isBuffer(e?.stderr) ? e.stderr.toString('utf8').trim() : '');
  const raw = redactTokenShapes(stderr || String((e && e.message) || e));
  return raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
}

export function isRunNotFoundError(error) {
  return typeof error === 'string' && /\bHTTP 404\b|\bNot Found\b/i.test(error);
}

/**
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#cancelHungRun — cancel a hung run WITHOUT re-running it. Used
 * for the `repeat-hang` dispatch (`main-red-recovery.mjs#planHungCiRecoveries`): the SAME job hanging again on
 * a different head sha is treated as a real hang in that shard's own tests, not infra, so this pass cancels
 * (unsticking the PR — `we:scripts/merge-ai-prs.mjs#isRequiredCheckFailed` already treats a CANCELLED required
 * check as failed, handing the PR to the ordinary `ci-red` → `ci-heal` path) and deliberately stops there.
 * @param {number|string} runId
 * @param {{repo?:string|null, exec?:Function}} [o]
 * @returns {{ok:boolean, action:string, error?:string}}
 */
export function cancelHungRun(runId, { repo = null, exec = execFileSyncThrottled } = {}) {
  const slug = repoSlug(repo);
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' };
  try {
    exec('gh', ['api', '-X', 'POST', `repos/${slug}/actions/runs/${runId}/cancel`], opts);
  } catch (e) {
    return { ok: false, action: 'cancel-failed', error: describeExecError(e) };
  }
  return { ok: true, action: 'cancelled-no-rerun' };
}

/**
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#cancelAndRerunHungRun — the ONE real write the ordinary
 * (non-repeat-hang) hung-run dispatch performs: REST run cancellation, a short bounded pause, then
 * REST run rerun (the WHOLE run — never `--failed`, which matches a `failure` conclusion, not the
 * `cancelled` one this pass's own cancel just produced, and would silently rerun nothing). Never a raw retry
 * of the still-hung attempt in place.
 * @param {number|string} runId
 * @param {{repo?:string|null, exec?:Function, sleepSync?:Function, waitMs?:number}} [o]
 * @returns {{ok:boolean, action:string, error?:string}}
 */
export function cancelAndRerunHungRun(runId, { repo = null, exec = execFileSyncThrottled, sleepSync = defaultSleepSync, waitMs = 5000 } = {}) {
  const slug = repoSlug(repo);
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' };
  try {
    exec('gh', ['api', '-X', 'POST', `repos/${slug}/actions/runs/${runId}/cancel`], opts);
  } catch (e) {
    return { ok: false, action: 'cancel-failed', error: describeExecError(e) };
  }
  sleepSync(waitMs);
  try {
    exec('gh', ['api', '-X', 'POST', `repos/${slug}/actions/runs/${runId}/rerun`], opts);
  } catch (e) {
    return { ok: false, action: 'rerun-failed', error: describeExecError(e) };
  }
  return { ok: true, action: 'cancelled-and-rerun' };
}

/**
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#sweepHungCiRecovery — THE IO SHELL for the hung-run pass,
 * mirroring {@link sweepCiRedRecovery}'s own read/plan/act shape exactly. Every reader/writer is injectable so
 * the whole sweep is exercisable with no network and no credential.
 *
 * THE MARKER IS POSTED ON EVERY ATTEMPT NOW, SUCCESS OR FAILURE — a live, orchestrator-flagged correctness
 * fix (2026-09-25). The original version only posted (and therefore only COUNTED) a successful cancel+rerun;
 * live against #2636, the GitHub App token turned out to lack `actions:write`, so `gh run cancel` failed on
 * EVERY tick, the marker was never posted, `hungAttemptsForSha` stayed 0 forever, and this pass would have
 * hammered the same doomed `gh run cancel` call every 2 minutes indefinitely — worse than the hang it exists to
 * fix. Counting every ATTEMPT (never just every success) is what makes the retry cap a real ceiling under a
 * permanently-failing write, not just under a flaky one; once the cap trips, `hung-cap-exhausted` hands off to
 * GitHub's own job `timeout-minutes` exactly as a successful-but-still-hung run would.
 * A missing-run retrigger that defers on a temporary precondition is not an attempt: report it without
 * posting a counted marker, so the trigger remains eligible when that precondition clears.
 * @param {{repo?:string|null, apply?:boolean, requiredCheck?:string, workflowName?:string, thresholdMs?:number,
 *   maxRetriesPerSha?:number, readOpenPrs?:Function, readComments?:Function, cancelAndRerun?:Function,
 *   cancelOnly?:Function, trigger?:Function, defaultBranch?:string, postComment?:Function, now?:number}} [o]
 * @returns {{dispatch:Array<object>, refusals:Array<object>, applied:Array<object>}}
 */
export function sweepHungCiRecovery({
  repo = null, apply = false, requiredCheck = DEFAULT_REQUIRED_CHECK, workflowName = DEFAULT_MAIN_WORKFLOW_NAME,
  thresholdMs = DEFAULT_HUNG_THRESHOLD_MS, maxRetriesPerSha = DEFAULT_MAX_HUNG_RETRIES_PER_SHA,
  readOpenPrs = defaultReadOpenPrs, readComments = defaultReadPrComments,
  cancelAndRerun = cancelAndRerunHungRun, cancelOnly = cancelHungRun, postComment = defaultPostHungCiComment, now = Date.now(),
  trigger = triggerCiForPr, defaultBranch = 'main',
} = {}) {
  const prs = readOpenPrs({ repo });
  const rawCandidates = buildHungCandidates(prs, { requiredCheck, workflowName });
  const retriggerRefusals = [];
  // The `gh pr view --json comments` read (to recover the durable per-sha AND per-job attempt counts) only
  // matters for a candidate this tick has ALREADY found hung — mirrors `sweepCiRedRecovery`'s own "pay for it
  // only when needed" discipline (there, gating the `gh run list --branch main` read on `candidates.length`).
  // ONE read serves both counts — never two separate `gh pr view` calls for the same PR.
  const candidates = rawCandidates.map((c) => {
    if (c.runId == null || !Number.isFinite(Date.parse(c.startedAt))) return c;
    const hungNow = (now - Date.parse(c.startedAt)) >= thresholdMs;
    if (!hungNow) return c;
    const comments = readComments(c.prNumber, { repo });
    // Existing builder prose distinguishes successful retriggers from FAILED attempts, including old markers.
    const retriggerComments = comments.filter((cm) => {
      const body = typeof cm === 'string' ? cm : cm?.body;
      return bodyHasExactLine(body, 'reason: run-not-found-retrigger') && bodyHasExactLine(body, `run: ${c.runId}`);
    });
    const successfulRetriggers = retriggerComments.filter((cm) => {
      const outcome = (typeof cm === 'string' ? cm : cm.body).split('\n').at(-1);
      return !outcome.includes(' and it FAILED:') && outcome.includes('; triggered CI for the current PR head via "');
    });
    const successfulRetriggerCount = countHungCiComments(successfulRetriggers, c.headSha);
    if (successfulRetriggerCount > 0) {
      retriggerRefusals.push({ ...c, kind: 'run-not-found-retriggered',
        why: 'This head and run already have a recorded retrigger outcome that succeeded; see its run-not-found-retrigger comment. No further attempt owed.' });
      return null;
    }
    // `hungAttemptsForJob` must answer "has this job hung on a DIFFERENT head sha before" — the repeat-hang
    // signal (main-red-recovery.mjs#planHungCiRecoveries) is about the shard surviving a rebase/refresh, not
    // about how many times THIS sha's own retries have already failed (that is `hungAttemptsForSha`'s job).
    // Excluding this candidate's OWN current sha from the job count keeps the two signals independent: a sha
    // that has failed twice in a row against ITSELF trips `hung-cap-exhausted`, never a false `repeat-hang`.
    const otherShaComments = comments.filter((cm) => !bodyHasExactLine(typeof cm === 'string' ? cm : cm?.body, `sha: ${c.headSha}`));
    return {
      ...c,
      hungAttemptsForSha: countHungCiComments(comments, c.headSha),
      hungAttemptsForJob: countHungCiCommentsByJob(otherShaComments, c.jobName),
    };
  }).filter(Boolean);
  const plan = planHungCiRecoveries({
    candidates, now, thresholdMs, maxRetriesPerSha,
  });

  plan.refusals.push(...retriggerRefusals);
  const applied = [];
  if (apply) {
    for (const d of plan.dispatch) {
      let result = d.runId == null
        ? { ok: false, action: 'no-run-id', error: `PR #${d.prNumber}'s hung check has no resolvable run id (detailsUrl missing/unparseable)` }
        // #4075/#3383, 2026-09-25 18:55 ET correction — `hung-cap-escalate` cancels only, exactly like
        // `repeat-hang`: both hand the PR to the existing ci-red -> ci-heal path rather than retrying.
        : ((d.kind === 'repeat-hang' || d.kind === 'hung-cap-escalate') ? cancelOnly(d.runId, { repo }) : cancelAndRerun(d.runId, { repo }));
      let reason = null;
      let cancelError = null;
      if (d.kind === 'hung-cancel-rerun' && !result.ok && result.action === 'cancel-failed' && isRunNotFoundError(result.error)) {
        const triggered = trigger(d, { repo: repoSlug(repo), defaultBranch });
        cancelError = result.error;
        result = triggered;
        reason = 'run-not-found-retrigger';
      }
      // A temporary trigger hold is not a spent recovery attempt. Keep it visible in the report,
      // without a counted marker that would exhaust the only retrigger path before the hold clears.
      if (d.runId != null && !result.deferred) {
        postComment(d.prNumber, {
          repo, runId: d.runId, headSha: d.headSha, jobName: d.jobName, kind: d.kind, ok: result.ok, action: result.action, error: result.error ?? null,
          ...(reason ? { reason, cancelError } : {}),
        });
      }
      // xd1sfms (#4075/#3383) — `why` carries forward from the PLAN (never re-derived here) so every applied
      // action stays traceable to the reason it fired, whether or not the write itself succeeded — "log each
      // hung-run action with its reason" (this card's own scope item 3).
      applied.push({
        prNumber: d.prNumber, headRefName: d.headRefName, runId: d.runId, jobName: d.jobName ?? null, kind: d.kind, why: d.why, ...result,
      });
    }
  }
  return { ...plan, applied };
}

/** we:scripts/conveyor/ci-red-recovery-watch.mjs#formatHungReport — one line per dispatch/refusal/applied
 *  result for the hung-run pass, mirroring {@link formatReport}'s own shape/discipline. */
export function formatHungReport({ dispatch = [], refusals = [], applied = [] } = {}) {
  const lines = [`ci-red-recovery-watch (hung) — ${dispatch.length} owed an action, ${refusals.length} refusal(s), ${applied.length} applied`];
  for (const d of dispatch) lines.push(`  → ${d.kind} PR #${d.prNumber} run ${d.runId ?? '?'} — ${d.why}`);
  for (const r of refusals) if (r.kind !== 'not-hung') lines.push(`  ✗ ${r.kind} PR #${r.prNumber} — ${r.why}`);
  for (const a of applied) lines.push(a.deferred ? `  … deferred PR #${a.prNumber} run ${a.runId ?? '?'} — ${a.error}` : a.ok ? `  ✓ applied: ${a.action} run ${a.runId ?? '?'} (PR #${a.prNumber}) — ${a.why ?? '(no reason recorded)'}` : `  ✗ apply ${a.action} PR #${a.prNumber} run ${a.runId ?? '?'} — ${a.error} (reason it was attempted: ${a.why ?? '(none)'})`);
  return lines.join('\n');
}

/**
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#defaultReadAttributedRequiredChecks — the main-red pass's
 * shared ruleset ∪ classic-protection set, with the same cache and declared-policy degradation as reconcile.
 * Live #5079/#5055: ruleset-only `merge-gate` must be judged alongside classic-protection checks.
 * Returns `null` (UNKNOWN) without a repo or a usable shared array, preserving the main-red fallback.
 * An explicitly empty shared array is preserved as `[]`.
 * @param {{repo?:string|null, branch?:string, readRequiredChecks?:Function}} [o]
 * @returns {string[]|null}
 */
export function defaultReadAttributedRequiredChecks({
  repo = null, branch = 'main', readRequiredChecks = getRequiredStatusChecks,
} = {}) {
  if (!repo) return null;
  try {
    const checks = readRequiredChecks({ repo, branch })?.checks;
    return Array.isArray(checks) ? checks : null;
  } catch {
    return null;
  }
}

/** Required checks for cancelled-PR recovery: only a fresh live read can authorize a rerun. */
export function readLiveRequiredChecks({
  repo = null, branch = 'main', readRequiredChecks = getRequiredStatusChecks,
} = {}) {
  if (!repo) return null;
  try {
    const result = readRequiredChecks({ repo, branch, ttlMs: 0 });
    if (result?.source !== 'live' || !Array.isArray(result.checks) || !result.checks.length ||
      result.checks.some(check => typeof check !== 'string' || !check)) return null;
    return result.checks;
  } catch {
    return null;
  }
}

// ── MISSING-CI-RUN RECOVERY (we:backlog/xi4od2p-*.md, parent #4075/#3383) ──────────────────────────────────────
// See `we:scripts/conveyor/main-red-recovery.mjs`'s own "MISSING-CI-RUN RECOVERY" section header for the full
// incident (PR web-everything/web-everything#2729) and why this is a THIRD, disjoint population from the main-red and
// hung-run passes above: a required check that never even started, never CONCLUDED and never went
// `IN_PROGRESS`/`QUEUED`. This half owns every real IO the missing-run pass needs: reading the LIVE required
// context names off branch protection, the one extra per-candidate read (`gh api commits/<sha>` for the head
// commit's own committed date — `gh pr list` never returns it), the guarded empty-commit push, the durable
// marker comment, and clearing the stale `checking` label this card's own scope names.

/**
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#defaultReadRequiredContexts — the LIVE classic-branch-protection
 * required-check-name set this pass watches, read through the one shared per-repo cache
 * (`we:scripts/lib/required-status-checks.mjs#getRequiredStatusChecks`) rather than a direct `gh api …/protection`
 * on every call. It returns the shared entry's `classic` subset, NEVER the rules ∪ classic union: this set feeds the
 * all-absent test and the declared fallback in {@link sweepMissingRunRecovery}, and ruleset-only checks (e.g.
 * `merge-gate`) enter only through {@link defaultReadAttributedRequiredChecks} (#5060).
 * Returns `null` (UNKNOWN) with no `repo`, on a read failure, or whenever the classic set was not read live —
 * a `declared`/`fallback`/`unavailable` result, or a stale entry that was declared — never a substituted default:
 * a guessed set like `['test']` would classify a PR that has already reported a DIFFERENT required context
 * (`smoke`) as "missing every run" and trigger CI it does not need (PR #2740 review). A classic set that was read
 * and is empty is preserved as `[]` only when the full required set is also empty. An empty classic subset
 * beside ruleset requirements returns `null`, keeping ruleset-only missing-run recovery enabled. On `null`,
 * {@link buildMissingRunCandidates} falls back to its narrower name-free "no CI-workflow check at all" test.
 * @param {{repo?:string|null, branch?:string, readRequiredChecks?:Function}} [o]
 * @returns {string[]|null}
 */
export function defaultReadRequiredContexts({
  repo = null, branch = 'main', readRequiredChecks = getRequiredStatusChecks,
} = {}) {
  if (!repo) return null;
  try {
    const result = readRequiredChecks({ repo, branch });
    if (result?.source === 'declared' || result?.source === 'fallback' || result?.source === 'unavailable') return null;
    if (!Array.isArray(result?.classic)) return null;
    const classic = result.classic.filter((n) => typeof n === 'string' && n);
    // Ruleset-only protection is not an empty required set: allow the attributed partial-rollup test.
    if (!classic.length && result.checks?.length) return null;
    return classic;
  } catch {
    return null;
  }
}

/** The repo's declared (policy) required set — never a network read; `null` for an undeclared repo. */
export function defaultReadDeclaredContexts({ repo = null } = {}) {
  const declared = repo ? DECLARED_REQUIRED_STATUS_CHECKS[repo] : null;
  return Array.isArray(declared) ? [...declared] : null;
}

/**
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#defaultReadHeadCommittedAt — the one extra per-candidate read
 * this pass needs (`gh pr list` never returns a head commit's own timestamp): the head sha's own commit date,
 * read ONLY for a PR {@link buildMissingRunCandidates} already narrowed to — mirrors every other "pay for it
 * only when needed" read in this file.
 * @param {string|null} sha
 * @param {{repo?:string|null, exec?:Function}} [o]
 * @returns {string|null}
 */
export function defaultReadHeadCommittedAt(sha, { repo = null, exec = execFileSyncThrottled } = {}) {
  if (!sha || !repo) return null;
  try {
    const out = exec('gh', ['api', `repos/${repo}/commits/${sha}`, '--jq', '.commit.committer.date'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
    });
    return String(out || '').trim() || null;
  } catch {
    return null;
  }
}

/** A fresh, exact-head preflight and credential-pinned push produce the PR synchronize
 * event required checks evaluate. Dispatch runs are deliberately not a fallback.
 */
export function triggerCiForPr(d, options = {}) {
  return pushMissingRunCommit(d, options);
}

/**
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#defaultPostMissingRunComment — post the durable marker comment
 * ({@link buildMissingRunComment}) after EVERY missing-run trigger attempt, success or failure — mirrors
 * {@link defaultPostRebaseComment}'s own discipline exactly.
 * @param {number} prNumber
 * @param {{exec?:Function, repo?:string|null, headRefName?:(string|null), headSha?:(string|null),
 *   ok?:boolean, action?:string, error?:(string|null)}} [o]
 */
export function defaultPostMissingRunComment(prNumber, {
  exec = execFileSyncThrottled, repo = null, headRefName = null, headSha = null, mainGreen = null, ok = true, action = 'pull-request-push', error = null,
  refresh = null, refreshError = null, newHeadSha = null,
} = {}) {
  const argv = ['pr', 'comment', String(prNumber), '--body', buildMissingRunComment({
    headRefName, headSha, mainGreen, ok, action, error, refresh, refreshError, newHeadSha,
  })];
  if (repo) argv.push('--repo', repo);
  exec('gh', argv, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
  });
}

/**
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#clearStaleCheckingLabel — this card's own "fix the `checking`
 * label so it reflects reality" scope item, narrowly scoped: ONLY for a PR THIS pass's own read already proved
 * has zero required-check rollup entries at all (never re-derives that proof, and never touches
 * `we:scripts/merge-ai-prs.mjs#lifecycleLabelFromCiTruth`'s ratified 4-state taxonomy or any other caller of
 * it). `checking`'s own label description (#2281) is "Required checks are still running — CI truth not yet
 * known", which is false while no run has ever even started; removing it here corrects THIS pass's own narrow
 * true positive, not a taxonomy change. The label is re-applied correctly by the EXISTING label reconciler on
 * its own next tick, once the trigger above gives it a real, in-flight check to read.
 * @param {number} prNumber
 * @param {{repo?:string|null, exec?:Function, currentLabels?:string[]}} [o]
 * @returns {boolean} true iff the label was present and a removal was attempted.
 */
export function clearStaleCheckingLabel(prNumber, { repo = null, exec = execFileSyncThrottled, currentLabels = [] } = {}) {
  if (!currentLabels.includes(CI_LIFECYCLE_LABELS.checking)) return false;
  const argv = ['pr', 'edit', String(prNumber), '--remove-label', CI_LIFECYCLE_LABELS.checking];
  if (repo) argv.push('--repo', repo);
  exec('gh', argv, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
  });
  return true;
}

function defaultFetchStackRef(ref, { root, run = gitRun }) {
  const r = run('git', ['fetch', 'origin', ref], { cwd: root });
  return r.status === 0 ? { ok: true } : { ok: false, error: `fetch ${ref} failed (${String(r.stderr || '').split('\n')[0]})` };
}

/** An omitted repo means WE itself (the same reading `sweepCiRedRecovery`'s `isWe` uses), never "cannot proceed";
 *  a constellation key (`we`, `frontierui`, …) maps to its gh slug, anything else passes through. */
function repoSlug(repo) {
  return !repo ? CONSTELLATION_REPOS.we.slug : (CONSTELLATION_REPOS[repo]?.slug ?? repo);
}

/**
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#defaultReadIsCrossRepository — whether PR `prNumber`'s head lives
 * in a fork. A per-PR read (the shared open-PR snapshot carries no head-repo field), paid only for a stacked
 * candidate's chain. Returns `true`/`false`, or `null` when it cannot be read — callers treat anything but
 * `false` as "not provably same-repo" and refuse.
 * @param {number} prNumber
 * @param {{repo?:string|null, exec?:Function}} [o]
 * @returns {boolean|null}
 */
export function defaultReadIsCrossRepository(prNumber, { repo = null, exec = execFileSyncThrottled } = {}) {
  if (!Number.isSafeInteger(prNumber)) return null;
  const slug = repoSlug(repo);
  try {
    const out = exec('gh', ['pr', 'view', String(prNumber), '--repo', slug, '--json', 'isCrossRepository', '--jq', '.isCrossRepository'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
    });
    const v = String(out || '').trim();
    return v === 'true' ? true : v === 'false' ? false : null;
  } catch {
    return null;
  }
}

/**
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#sameRepoRefusal — the one same-repo guard every path that rebases
 * and force-pushes `origin/<headRefName>` ({@link refreshOntoMain}) must pass first. The open-PR listing carries
 * no head-repo field, so this reads it per PR. A fork PR is a COUNTED refusal (a marker is posted, so the per-sha
 * cap bounds it); an unreadable answer is a free `deferred` one (a transient `gh` failure must not burn the cap).
 * Returns `null` when the PR is provably same-repo.
 * @param {number} prNumber
 * @param {{repo?:string|null, readIsCrossRepository?:Function, action?:string}} [o]
 * @returns {null|{ok:false, action:string, error:string, deferred?:true}}
 */
export function sameRepoRefusal(prNumber, { repo = null, readIsCrossRepository = defaultReadIsCrossRepository, action = 'refresh' } = {}) {
  let cross = null;
  try { cross = readIsCrossRepository(prNumber, { repo }); } catch { cross = null; }
  if (cross === false) return null;
  return cross === true
    ? { ok: false, action, error: `PR #${prNumber} is from a fork; refusing to rebase and push its head ref` }
    : { ok: false, action, deferred: true, error: `PR #${prNumber} could not be verified as same-repo; retry next tick` };
}

export function restackStackedPr(d, {
  prs, repo, defaultBranch = 'main', root = REPO_ROOT, refresh = refreshOntoMain,
  fetchRef = defaultFetchStackRef, checkClaim = pushRefusal, readIsCrossRepository = defaultReadIsCrossRepository,
} = {}) {
  const action = 'stack-restack';
  const open = Array.isArray(prs) ? prs : [];
  // Every link is verified same-repo before any claim check, fetch or push (a fork PR, or one whose head name
  // merely shadows a same-repo lane in the chain, must never reach refreshOntoMain). One read per PR.
  const verdicts = new Map();
  const verify = (pr) => {
    const n = pr.prNumber ?? pr.number;
    if (!verdicts.has(n)) verdicts.set(n, sameRepoRefusal(n, { repo, readIsCrossRepository, action }));
    return verdicts.get(n);
  };
  const refusal = pr => ({ ...verify(pr), error: `stack link ${pr.headRefName}: ${verify(pr).error}` });
  const chain = [];
  const seen = new Set();
  let link = d;
  while (link) {
    const ref = link.baseRefName;
    if (seen.has(link.headRefName) || chain.length >= 10) {
      return { ok: false, action, error: `stack base ${ref} is not an open PR head; cannot restack` };
    }
    seen.add(link.headRefName);
    chain.push(link);
    if (ref === defaultBranch) break;
    const named = open.filter(pr => pr.headRefName === ref);
    if (!named.length) return { ok: false, action, error: `stack base ${ref} is not an open PR head; cannot restack` };
    if (verify(link)) return refusal(link);
    // A fork can open a PR from a branch with the same name as a same-repo lane, so the parent is the same-repo
    // PR among every name match, never the first match by listing order (PR #4825 round 5).
    const parents = named.filter(pr => !verify(pr));
    // An unverifiable match defers (it may be the parent, or a second same-repo parent making the stack ambiguous).
    const unverified = named.find(pr => verify(pr)?.deferred);
    if (unverified) return refusal(unverified);
    // GitHub allows one open PR per head/base pair, so two same-repo matches always differ in base.
    if (parents.length > 1) {
      return { ok: false, action, error: `stack base ${ref} heads several same-repo PRs with different bases; ambiguous stack, cannot restack` };
    }
    // Only forks match: a fork's branch can never be the base-repo branch this PR targets — a counted refusal.
    if (!parents.length) return refusal(named[0]);
    link = parents[0];
  }
  // A failure is a deferral only if the claim store holds a live claim on a chain link now (the push race) — never
  // because the failure text quotes the claim phrase (PR #4825 round 4).
  const failed = error => ({ ok: false, action, error,
    ...(chain.some(pr => checkClaim({ repo, branch: pr.headRefName })) ? { deferred: true } : {}),
  });
  for (const pr of chain) {
    if (verify(pr)) return refusal(pr);
  }
  for (const pr of chain) {
    const held = checkClaim({ repo, branch: pr.headRefName });
    if (held) return { ok: false, action, deferred: true, error: held.message };
  }
  const steps = [];
  for (const [index, pr] of chain.reverse().entries()) {
    try {
      if (index > 0) {
        const fetched = fetchRef(pr.baseRefName, { root });
        if (!fetched.ok) return failed(fetched.error);
      }
      const result = refresh(pr.headRefName, { base: `origin/${pr.baseRefName}`, root });
      if (!result.ok) return failed(result.error);
      steps.push({ prNumber: pr.prNumber ?? pr.number, headRefName: pr.headRefName, action: result.action, newCommit: result.newCommit });
    } catch (e) { return failed(describeExecError(e)); }
  }
  if (steps.every(step => step.action === 'current')) {
    return failed('stack already current with main; CI still absent — needs a human look');
  }
  const last = steps.at(-1);
  return { ok: true, action, steps, newHeadSha: last?.action === 'rebased' ? last.newCommit ?? null : null };
}

/**
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#sweepMissingRunRecovery — THE IO SHELL for the missing-run pass
 * (xi4od2p, #4075/#3383). Mirrors {@link sweepCiRedRecovery}/{@link sweepHungCiRecovery}'s own read/plan/act
 * shape and injectability exactly — every reader/writer is injectable so the whole sweep is exercisable with no
 * network and no credential.
 * @param {{repo?:string|null, apply?:boolean, defaultBranch?:string, readOpenPrs?:Function,
 *   readRequiredContexts?:Function, readAttributedRequiredChecks?:Function, readHeadCommittedAt?:Function, readComments?:Function,
 *   trigger?:Function, postComment?:Function, clearLabel?:Function, thresholdMs?:number, maxRetriesPerSha?:number,
 *   maxRetriesPerPr?:number, now?:number}} [o] maxRetriesPerPr caps only ruleset-only candidates across SHAs.
 * @returns {{dispatch:Array<object>, refusals:Array<object>, applied:Array<object>}}
 */
export function sweepMissingRunRecovery({
  repo = null, apply = false, defaultBranch = 'main',
  mainRuns = null, readMainRuns = defaultReadMainRuns, restack = restackStackedPr, readIsCrossRepository = defaultReadIsCrossRepository,
  readOpenPrs = defaultReadOpenPrs, readRequiredContexts = defaultReadRequiredContexts,
  // A caller injecting the protection reader (a soak/test fixture) gets it reused here, never a live ruleset read
  // — the same compatibility rule {@link sweepCiRedRecovery} applies.
  readAttributedRequiredChecks = readRequiredContexts === defaultReadRequiredContexts
    ? defaultReadAttributedRequiredChecks : readRequiredContexts,
  readHeadCommittedAt = defaultReadHeadCommittedAt, readDeclaredContexts = defaultReadDeclaredContexts,
  readComments = defaultReadPrComments, trigger = triggerCiForPr, postComment = defaultPostMissingRunComment,
  readPush = readFixPush, clearLabel = clearStaleCheckingLabel, thresholdMs = resolveHandoffSettings().value.ciMissingAfterPushMin * 60_000,
  maxRetriesPerSha = resolveRecoveryCaps().missingRunRetriesPerSha, maxRetriesPerPr = maxRetriesPerSha, now = Date.now(),
} = {}) {
  // #2793 — `mergeable` added so {@link buildMissingRunCandidates} can exclude a real merge conflict (never a
  // "missing run", a conflicting PR can produce no `pull_request` run at all — see that function's own docblock).
  const prs = readOpenPrs({ repo, extraFields: ['labels', 'baseRefName', 'mergeable'] });
  // `null` (UNKNOWN — the protection read failed, as it does for the daemon's App token) is passed through as-is:
  // {@link buildMissingRunCandidates} then uses its narrower "no CI-workflow check at all" test rather than a
  // guessed name set (PR #2740 review).
  const requiredContexts = readRequiredContexts({ repo, branch: defaultBranch });
  // The daemon's App token cannot read protection (403 → null), which would blind the partial-rollup check
  // (draft #3850: `test` never reported beside green siblings). Fall back to the repo's DECLARED required set —
  // used ONLY for that check, never to widen the all-absent test (PR #2740 review).
  const stalledPartialContexts = requiredContexts ?? readDeclaredContexts({ repo });
  let defaultBasePartialContexts = stalledPartialContexts;
  // live #5060 (2026-10-13): include ruleset-only merge-gate in the partial-rollup test.
  try {
    const attributed = readAttributedRequiredChecks({ repo, branch: defaultBranch });
    if (Array.isArray(attributed)) defaultBasePartialContexts = [...new Set([...(stalledPartialContexts ?? []), ...attributed])];
  } catch { /* An unavailable attributed read preserves the existing set. */ }
  // Ruleset-only workflows may target only the default base (merge-gate targets main).
  // Keep the classic/declared population for stacks and unreadable bases; never restack a healthy chain
  // merely because a check that cannot run on its base is absent. The all-absent test is unchanged.
  const classicCandidateNumbers = new Set(buildMissingRunCandidates(prs, {
    requiredContexts: requiredContexts ?? null, stalledPartialContexts,
  }).map(c => c.prNumber));
  const rawCandidates = (Array.isArray(prs) ? prs : []).flatMap(pr => buildMissingRunCandidates([pr], {
    requiredContexts: requiredContexts ?? null,
    stalledPartialContexts: pr?.baseRefName === defaultBranch ? defaultBasePartialContexts : stalledPartialContexts,
  }));
  if (rawCandidates.length && mainRuns === null) {
    try { mainRuns = readMainRuns({ repo, branch: defaultBranch, workflowName: DEFAULT_MAIN_WORKFLOW_NAME }); }
    catch { mainRuns = []; }
  }
  const mainRedWindows = computeMainRedWindows(mainRuns);
  const mainGreen = currentMainGreen(mainRuns);
  const prByNumber = new Map((Array.isArray(prs) ? prs : []).map((pr) => [Number(pr?.number), pr]));
  // Every per-candidate extra read below only runs for a PR {@link buildMissingRunCandidates} already narrowed
  // to (zero required-check rollup entries at all) — mirrors {@link sweepCiRedRecovery}/{@link sweepHungCiRecovery}'s
  // own "pay for it only when needed" discipline; never one extra `gh` call per ordinary open PR on every tick.
  const candidates = rawCandidates.map((c) => {
    const headCommittedAt = readPush({ repo: repoSlug(repo), pr: c.prNumber, head: c.headSha })?.pushedAt ?? readHeadCommittedAt(c.headSha, { repo });
    const comments = readComments(c.prNumber, { repo });
    return {
      ...c, headCommittedAt, triggerAttemptsForSha: countMissingRunComments(comments, c.headSha, { baseRefName: c.baseRefName, mainRedWindows, mainGreen, defaultBranch }),
      // Bound checks discovered only by the ruleset expansion across pushes. Classic/declared candidates
      // retain their existing per-SHA budget, including all-absent heads and restacks.
      triggerAttemptsForPr: classicCandidateNumbers.has(c.prNumber)
        ? null : countMissingRunComments(comments, null, { defaultBranch }),
    };
  });
  const plan = planMissingRunRecoveries({
    candidates, now, thresholdMs, maxRetriesPerSha,
  });
  const attemptsByPr = new Map(candidates.map(c => [c.prNumber, c.triggerAttemptsForPr]));
  plan.dispatch = plan.dispatch.filter(d => {
    if (classicCandidateNumbers.has(d.prNumber)) return true;
    const attempts = attemptsByPr.get(d.prNumber) ?? 0;
    if (attempts < maxRetriesPerPr) return true;
    plan.refusals.push({ ...d, kind: 'missing-run-pr-cap-exhausted', attempts,
      why: `PR #${d.prNumber} already had ${attempts} missing-run trigger attempt(s) across all head SHAs (cap ${maxRetriesPerPr}) — needs human/ci-heal inspection` });
    return false;
  });

  const applied = [];
  if (apply) {
    for (const d of plan.dispatch) {
      // 2026-10-10 live (#4759…#4797): a stacked PR gets no run because its merge commit's ci.yml predates the
      // `lane/**` trigger — an empty push cannot fix that; restacking the chain onto main can.
      const stacked = d.baseRefName && d.baseRefName !== defaultBranch;
      const result = stacked
        ? restack(d, { prs, repo, defaultBranch, readIsCrossRepository, root: resolveLanePoolRepoPath(repo) ?? REPO_ROOT })
        : trigger(d, { repo: repoSlug(repo), defaultBranch });
      // Unknown mergeability, a moving head or a held claim is not an attempt.
      if (result.deferred) {
        applied.push({ prNumber: d.prNumber, headRefName: d.headRefName, why: d.why, labelCleared: false, ...result });
        continue;
      }
      // Posted on EVERY attempt, success or failure — same discipline as every sibling durable marker in this
      // file: a permanently-failing trigger must still trip {@link DEFAULT_MAX_MISSING_RUN_RETRIES_PER_SHA}'s cap.
      postComment(d.prNumber, {
        repo, headRefName: d.headRefName, headSha: d.headSha, mainGreen, ok: result.ok, action: result.action, error: result.error ?? null,
        refresh: result.refresh ?? null, refreshError: result.refreshError ?? null,
        newHeadSha: result.newHeadSha ?? null,
      });
      // The push requested CI; only a later rollup proves a run actually started.
      // Clear the stale label on successful submission; the reconciler owns future CI truth.
      const pr = prByNumber.get(d.prNumber);
      const currentLabels = (Array.isArray(pr?.labels) ? pr.labels : [])
        .map((l) => (typeof l === 'string' ? l : l?.name))
        .filter(Boolean);
      const labelCleared = result.ok ? clearLabel(d.prNumber, { repo, currentLabels }) : false;
      applied.push({
        prNumber: d.prNumber, headRefName: d.headRefName, why: d.why, labelCleared, ...result,
      });
    }
  }
  return { ...plan, applied };
}

/** we:scripts/conveyor/ci-red-recovery-watch.mjs#formatMissingRunReport — one line per dispatch/refusal/applied
 *  result for the missing-run pass, mirroring {@link formatReport}/{@link formatHungReport}'s own shape. */
export function formatMissingRunReport({ dispatch = [], refusals = [], applied = [] } = {}) {
  const lines = [`ci-red-recovery-watch (missing-run) — ${dispatch.length} owed a trigger, ${refusals.length} refusal(s), ${applied.length} applied`];
  for (const d of dispatch) lines.push(`  → trigger-ci PR #${d.prNumber} (${d.headRefName ?? '?'}) — ${d.why}`);
  for (const r of refusals) if (r.kind !== 'not-overdue') lines.push(`  ✗ ${r.kind} PR #${r.prNumber} — ${r.why}`);
  for (const a of applied) lines.push(a.deferred ? `  … deferred PR #${a.prNumber} — ${a.error}` : a.ok ? `  ✓ applied: ${a.action} PR #${a.prNumber}${a.labelCleared ? ' (cleared stale checking label)' : ''} — ${a.why ?? '(no reason recorded)'}` : `  ✗ apply ${a.action} PR #${a.prNumber} — ${a.error} (reason it was attempted: ${a.why ?? '(none)'})`);
  return lines.join('\n');
}

function readMainRetriggerRecord(path, repo) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const legacy = join(dirname(path), 'main-ci-retrigger.json');
    if (legacy === path) return {};
    try {
      const record = JSON.parse(readFileSync(legacy, 'utf8'));
      // A shared SHA does not establish repository identity. Unattributed legacy attempts
      // belong only to WE; seeding another repository requires explicit matching provenance.
      // Preserve malformed evidence for the caller's fail-closed validation.
      if (!record || Array.isArray(record) || typeof record !== 'object') return record;
      const slug = repoSlug(repo);
      return Object.fromEntries(Object.entries(record).filter(([, entry]) =>
        !entry || typeof entry !== 'object' || Array.isArray(entry) || entry.repo === slug ||
        (entry.repo === undefined && slug === CONSTELLATION_REPOS.we.slug)));
    }
    catch (le) { if (le.code === 'ENOENT') return {}; throw le; }
  }
}

function writeMainRetriggerRecord(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (e) {
    rmSync(temporary, { force: true });
    throw e;
  }
}

/** Local refusals prove that no rerun was submitted; generic rate-limit/transport errors do not. */
function isMainRerunNotSubmitted(error) {
  if (isGhThrottled(error) || error?.budgetBlocked) return true;
  // The gh shim preserves the budget refusal on stderr, but cannot preserve custom Error properties.
  const stderr = error?.stderr;
  return (typeof stderr === 'string' || Buffer.isBuffer(stderr)) &&
    /^gh-throttle: GitHub (?:core|graphql) API rate limit exceeded for this identity — shared backoff until [^\r\n]+, call not sent \(#gh-graphql-budget\)\r?$/m.test(String(stderr));
}

export function rerunMainCancelledRun(runId, { repo = null, exec = execFileSyncThrottled } = {}) {
  try {
    const out = exec('gh', ['api', '-X', 'POST', `repos/${repoSlug(repo)}/actions/runs/${runId}/rerun`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
      timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
    });
    // The throttle can answer with a deferral payload instead of running gh: nothing was submitted.
    if (isGhDeferred(out)) return { ok: false, uncertain: false, error: 'rerun deferred by the gh throttle; nothing submitted' };
    return { ok: true };
  } catch (e) {
    const error = describeExecError(e);
    // An explicit API rejection is retryable; a timeout/transport failure may
    // have lost the acknowledgement after GitHub accepted the rerun.
    // Local slot/budget refusals happen before submission and can safely release the reservation.
    return { ok: false, error, uncertain: !isMainRerunNotSubmitted(e) && !/\bHTTP 4(?!08)\d\d\b/.test(error) };
  }
}

/** Per-repository record file; WE keeps the legacy name so existing records stay valid. Every repository
 *  watcher shares one handoff home, and a shared file lets one watcher's stale snapshot erase another's attempts. */
export function mainRetriggerRecordPath(repo = null, home = handoffHome()) {
  const slug = repoSlug(repo);
  return join(home, slug === CONSTELLATION_REPOS.we.slug ? 'main-ci-retrigger.json'
    : `main-ci-retrigger.${encodeURIComponent(slug)}.json`);
}

export function prCancelledRecordPath(repo = null, home = handoffHome()) {
  const slug = repoSlug(repo);
  return join(home, slug === CONSTELLATION_REPOS.we.slug ? 'pr-ci-cancelled-rerun.json'
    : `pr-ci-cancelled-rerun.${encodeURIComponent(slug)}.json`);
}

function readPrCancelledRecord(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}

/** Exclusive advisory lock around a record's read-modify-write (atomic rename protects one write, not the sequence).
 *  Returns {locked:false} when another holder is still live after `waitMs`; a lock older than `staleMs`
 *  (a crashed holder) is stolen. The lock is always released, including when `fn` throws. */
export function withMainRetriggerLock(recordPath, fn, { waitMs = 5000, staleMs = resolveChildTimeoutMs() * 2 + 60_000 } = {}) {
  const lockPath = `${recordPath}.lock`;
  const token = randomUUID();
  mkdirSync(dirname(recordPath), { recursive: true });
  const deadline = Date.now() + waitMs;
  const readToken = () => { try { return readFileSync(lockPath, 'utf8'); } catch { return null; } };
  const holdsLock = () => readToken() === token;
  // The lock file carries an owner token: only its owner releases it, and a holder whose lock was stolen
  // as stale (slow gh calls) learns that via assertHeld before every record write instead of clobbering.
  const assertHeld = () => { if (!holdsLock()) throw Error('main retrigger lock lost; another watcher may be updating the record'); };
  // Stale = older than any live holder can run, either direction (a future mtime is clock skew, not a live hold).
  // Never throws or loops without a sleep: an unremovable or odd entry just falls through to the deadline.
  const reclaimStale = () => {
    let seen;
    try { const st = lstatSync(lockPath); if (Math.abs(Date.now() - st.mtimeMs) <= staleMs) return false; seen = readToken(); }
    catch { return false; }
    const parked = `${lockPath}.stale.${randomUUID()}`;
    try { renameSync(lockPath, parked); } catch { return false; }
    try {
      // Between the stat and the rename a faster watcher may have replaced the stale lock; put a fresh one back.
      let content = null;
      try { content = readFileSync(parked, 'utf8'); } catch { /* a directory or symlink: nothing to restore */ }
      if (content !== seen) { try { linkSync(parked, lockPath); } catch { /* lost the lock: its holder's assertHeld aborts it */ } }
    } finally { rmSync(parked, { recursive: true, force: true }); }
    return true;
  };
  for (;;) {
    try { writeFileSync(lockPath, token, { flag: 'wx', mode: 0o600 }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // A reclaimed lock is retried at once (even with no wait budget); otherwise honour the deadline, then sleep.
      if (reclaimStale()) continue;
      if (Date.now() >= deadline) return { locked: false };
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try { return { locked: true, value: fn({ assertHeld }) }; }
  finally { if (holdsLock()) rmSync(lockPath, { force: true }); }
}

/** One whole-run retry per main head, then a durable, once-only stuck signal.
 * Record IO is synchronous; event delivery is best-effort and cannot fail the sweep.
 * Unreadable evidence refuses action: restore the record or inspect main CI before retrying. */
export function sweepMainCancelledRetrigger(options = {}) {
  const { repo = null, apply = false, recordPath = mainRetriggerRecordPath(repo), lock = withMainRetriggerLock } = options;
  if (!apply) return sweepMainCancelledLocked({ ...options, recordPath });
  let held;
  let sweepError = null;
  try {
    held = lock(recordPath, ctx => {
      // A sweep exception is not a lock failure: let it reach the caller's per-pass isolation unchanged.
      try { return sweepMainCancelledLocked({ ...options, recordPath, assertHeld: ctx?.assertHeld }); }
      catch (e) { sweepError = { e }; return null; }
    });
  } catch (e) {
    return { dispatch: [], applied: [], refusals: [{ reason: 'record-lock-failed', error: describeExecError(e) }] };
  }
  if (sweepError) throw sweepError.e;
  return held.locked ? held.value
    : { dispatch: [], applied: [], refusals: [{ reason: 'record-locked', error: 'another watcher is updating the main CI retrigger record; retry next tick' }] };
}

function sweepMainCancelledLocked({ repo = null, defaultBranch = 'main', apply = false,
  readMainRuns = defaultReadMainRuns, rerun = rerunMainCancelledRun,
  recordPath,
  readRecord = path => readMainRetriggerRecord(path, repo), writeRecord: persistRecord = writeMainRetriggerRecord,
  emitEvent = event => appendDaemonEvent({ ...event, daemon: 'ci-red-recovery-watch' }),
  now = Date.now(), assertHeld = () => {},
} = {}) {
  // A holder whose lock expired during slow gh calls must not write its stale snapshot over a newer record.
  const writeRecord = (path, value) => { assertHeld(); persistRecord(path, value); };
  const result = { dispatch: [], refusals: [], applied: [] };
  const refuse = (reason, detail = {}) => {
    result.refusals.push({ reason, ...detail });
    return result;
  };
  let runs;
  try {
    runs = readMainRuns({ repo, branch: defaultBranch, workflowName: DEFAULT_MAIN_WORKFLOW_NAME });
    if (!Array.isArray(runs) || runs.some(r => typeof r?.workflowName !== 'string')) throw Error('incomplete main run history');
    runs = runs.filter(r => r.workflowName === DEFAULT_MAIN_WORKFLOW_NAME);
    if (runs.some(r => !Number.isFinite(Date.parse(r.createdAt)) || typeof r.headSha !== 'string' || !r.headSha || !r.status)) throw Error('incomplete main run evidence');
  } catch (e) { return refuse('main-runs-unreadable', { error: describeExecError(e) }); }
  if (!runs.length) return result;
  const newest = [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const sha = newest.headSha;
  const runId = newest.databaseId;
  if (runs.some(r => r.headSha === sha && ['queued', 'in_progress', 'waiting', 'pending'].includes(r.status))) {
    return refuse('in-progress', { sha, runId });
  }
  if (newest.status !== 'completed' || !['cancelled', 'skipped'].includes(newest.conclusion)) return result;
  if (!/^[1-9]\d*$/.test(String(runId))) return refuse('invalid-run-id', { sha });
  let record;
  try {
    record = readRecord(recordPath);
    if (!record || Array.isArray(record) || typeof record !== 'object' || Object.values(record).some(entry =>
      !entry || !/^[1-9]\d*$/.test(String(entry.runId)) || !Number.isFinite(Date.parse(entry.retriggeredAt)) ||
      (entry.stuck !== undefined && typeof entry.stuck !== 'boolean') ||
      (entry.reserved !== undefined && typeof entry.reserved !== 'boolean'))) throw Error('invalid main retrigger record');
  } catch (e) {
    return refuse('record-unreadable', { sha, runId,
      error: `${describeExecError(e)}; restore the attempt record or inspect main CI before retrying` });
  }
  const previous = Object.hasOwn(record, sha) ? record[sha] : null;
  if (previous?.stuck) return result;
  // A successful rerun request is not evidence that its attempt has finished. GitHub
  // can still return the original cancellation for several sweeps. Reruns retain
  // their run ID and createdAt, so require a completed observation updated after
  // the request, or a distinct newest run, before consuming the stuck signal.
  if (previous && String(previous.runId) === String(runId) &&
    !(Date.parse(newest.updatedAt) > Date.parse(previous.retriggeredAt))) {
    if (previous.reserved) return refuse('rerun-outcome-unknown', { sha, runId,
      error: 'inspect main CI; clear the reservation only after confirming that no rerun was accepted' });
    return result;
  }
  const action = previous ? 'main-ci-stuck' : 'main-ci-retriggered';
  const dispatch = { action, sha, runId };
  result.dispatch.push(dispatch);
  if (!apply) return result;
  const boundedRecord = entry => Object.fromEntries([[sha, entry], ...Object.entries(record)
    .filter(([key]) => key !== sha)
    .sort((a, b) => Date.parse(b[1].retriggeredAt) - Date.parse(a[1].retriggeredAt)).slice(0, 19)]);
  const attempt = previous
    ? { runId: previous.runId, retriggeredAt: previous.retriggeredAt, stuck: true }
    : { runId, retriggeredAt: new Date(now).toISOString() };
  if (!previous) {
    // Reserve durably BEFORE the remote write. A crash, lost acknowledgement,
    // or failed confirmation write must never make this head eligible again.
    try { writeRecord(recordPath, boundedRecord({ ...attempt, reserved: true })); }
    catch (e) {
      result.applied.push({ ...dispatch, ok: false, error: `reservation failed: ${describeExecError(e)}` });
      return result;
    }
    let outcome;
    // Injectable rerunners may return ok:false for a confirmed rejection;
    // uncertain:true (or a thrown error) retains the reservation for inspection.
    try { outcome = rerun(runId, { repo }); }
    catch (e) { outcome = { ok: false, uncertain: !isMainRerunNotSubmitted(e), error: describeExecError(e) }; }
    if (outcome?.ok !== true) {
      let error = outcome?.error ?? 'rerun did not confirm success';
      if (outcome?.ok === false && outcome.uncertain !== true) {
        try { writeRecord(recordPath, record); }
        catch (e) { error += `; reservation rollback failed: ${describeExecError(e)}; inspect main CI before clearing the reservation`; }
      } else error += '; reservation retained; inspect main CI before clearing it';
      result.applied.push({ ...dispatch, ok: false, error });
      return result;
    }
  }
  // Always retain the head being acted on, including when an oversized old record is supplied.
  try { writeRecord(recordPath, boundedRecord(attempt)); }
  catch (e) {
    result.applied.push({ ...dispatch, ok: false,
      error: `${describeExecError(e)}; attempt remains recorded; inspect main CI before changing the record` });
    return result;
  }
  try { Promise.resolve(emitEvent({ kind: action, detail: { sha, runId } })).catch(() => {}); }
  catch { /* Best-effort events; the durable record is authoritative. */ }
  result.applied.push({ ...dispatch, ok: true });
  return result;
}

export function formatMainCancelledReport({ dispatch = [], refusals = [], applied = [] } = {}) {
  const lines = [`ci-red-recovery-watch (main-cancelled) — ${dispatch.length} dispatch, ${refusals.length} refusal(s), ${applied.length} applied`];
  for (const d of dispatch) {
    const outcome = applied.find(a => a.sha === d.sha);
    lines.push(`  ${outcome ? (outcome.ok ? '✓' : '✗') : '→'} ${d.action} ${d.sha}${outcome?.error ? ` — ${markerFreeText(outcome.error)}` : ''}`);
  }
  for (const r of refusals) lines.push(`  ✗ ${r.reason} ${r.sha ?? '(unknown sha)'}${r.error ? ` — ${markerFreeText(r.error)}` : ''}`);
  return lines.map(line => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')).join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────────────

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

/** we:scripts/conveyor/ci-red-recovery-watch.mjs#formatReport — one line per dispatch/refusal/applied result,
 *  mirroring `reconcile-pass.mjs#formatReport`'s own "a pass that acts silently has reproduced the defect one
 *  level up" discipline. */
export function formatReport({ dispatch = [], refusals = [], applied = [] } = {}) {
  const lines = [`ci-red-recovery-watch — ${dispatch.length} owed a refresh, ${refusals.length} refusal(s), ${applied.length} applied`];
  for (const d of dispatch) lines.push(`  → rebase-onto-main PR #${d.prNumber} (${d.headRefName ?? '?'}) — ${d.why}`);
  for (const r of refusals) lines.push(`  ✗ ${r.kind} PR #${r.prNumber} — ${r.why}`);
  for (const a of applied) lines.push(a.deferred ? `  … deferred PR #${a.prNumber} ${a.headRefName ?? '?'} — ${a.error}` : a.ok ? `  ✓ applied: ${a.action} ${a.headRefName ?? '?'} onto main (PR #${a.prNumber})` : `  ✗ apply ${a.action} PR #${a.prNumber} ${a.headRefName ?? '?'} — ${a.error}`);
  return lines.join('\n');
}

// Injectable CLI boundary: regression tests exercise the same orchestration that the daemon invokes.
export async function main(argv, { sweepOptions = {}, sweepMainRed = sweepCiRedRecovery,
  sweepExhausted = sweepExhaustedRetry, sweepHung = sweepHungCiRecovery, sweepMissingRun = sweepMissingRunRecovery,
  sweepMainCancelled = sweepMainCancelledRetrigger,
  sweepPrCancelled = sweepPrCancelledRerun,
  writeLine = writeLineSync, writeAll = writeAllSync } = {}) {
  const [verbRaw, ...rest] = argv;
  const verb = verbRaw && !verbRaw.startsWith('--') ? verbRaw : 'sweep';
  const flags = parseFlags(verbRaw && !verbRaw.startsWith('--') ? rest : argv);
  if (verb !== 'sweep') {
    writeLine(2, 'usage: ci-red-recovery-watch.mjs sweep [--repo=<owner/name>] [--apply] [--json]');
    process.exitCode = 2;
    return;
  }
  const repoFlag = typeof flags.repo === 'string' && flags.repo ? flags.repo : null;
  if (repoFlag && repoKeyForSlug(repoFlag) === null) {
    writeLine(2, `✗ ci-red-recovery-watch: --repo ${repoFlag} is not a constellation repo`);
    process.exitCode = 1;
    return;
  }
  const exhaustedRetrySettings = sweepOptions.exhaustedRetrySettings ?? resolveExhaustedRetry();
  const options = { ...sweepOptions, repo: repoFlag, apply: !!flags.apply };
  let failed = false;
  const runPass = (name, sweep, args) => {
    try { return sweep(args); }
    catch (e) {
      failed = true;
      const error = describeExecError(e);
      writeLine(2, `✗ ci-red-recovery-watch ${name}: ${error}`);
      return { dispatch: [], refusals: [], applied: [], error };
    }
  };
  const result = runPass('main-red', sweepMainRed, { ...options, exhaustedRetrySettings });
  // Never rediscover exhausted candidates if the first pass failed: ownership facts may be incomplete.
  const exhaustedResult = runPass('exhausted-retry', sweepExhausted, { ...options,
    settings: exhaustedRetrySettings, mainRuns: result.mainRuns, candidates: result.candidates ?? [],
    prs: result.prs ?? [], requiredChecks: result.requiredChecks });
  // xd1sfms (#4075/#3383) — the hung-run pass runs in the SAME `sweep` invocation, never a separate CLI verb:
  // both watch the same open-PR listing for the same reason (a PR wrongly stuck on `checking`), and a daemon
  // manifest entry that already schedules this script (see `we:skills-src/conveyor/daemon-manifest.mjs`'s own
  // `ci-red-recovery-watch` entries) gets the hung-run fix for free rather than needing a second entry.
  const hungResult = runPass('hung-CI', sweepHung, options);
  // xi4od2p (#4075/#3383) — the missing-run pass runs in the SAME `sweep` invocation too, for the identical
  // reason the hung-run pass was folded in above rather than given a second CLI verb: both watch the same
  // open-PR listing for the same reason (a PR wrongly stuck on `checking`), and the daemon-manifest entry that
  // already schedules this script gets the missing-run fix for free rather than needing a third entry.
  const missingRunResult = runPass('missing-run', sweepMissingRun, { ...options, mainRuns: result.mainRuns?.length ? result.mainRuns : null });
  const mainCancelledResult = runPass('main-cancelled', sweepMainCancelled, options);
  const prCancelledResult = runPass('pr-cancelled', sweepPrCancelled, {
    ...options, repo: repoSlug(options.repo),
    // Reuse defaultReadOpenPrs' snapshot from main-red; a failed pass provides no actionable evidence.
    readOpenPrs: options.readOpenPrs ?? (() => result.prs ?? null),
    requiredChecks: undefined,
    readRequiredChecks: readLiveRequiredChecks,
    recordPath: prCancelledRecordPath(options.repo), lock: withMainRetriggerLock,
    readRecord: readPrCancelledRecord, writeRecord: writeMainRetriggerRecord,
  });
  if (flags.json) {
    writeLine(2, formatExhaustedRetryReport(exhaustedResult).split('\n')[0]);
    writeAll(1, `${JSON.stringify({ mainRedRecovery: result, hungRecovery: hungResult, missingRunRecovery: missingRunResult, exhaustedRetry: exhaustedResult, mainCancelledRetrigger: mainCancelledResult, prCancelledRerun: prCancelledResult })}\n`);
  } else {
    writeLine(2, formatReport(result));
    writeLine(2, formatExhaustedRetryReport(exhaustedResult));
    writeLine(2, formatHungReport(hungResult));
    writeLine(2, formatMissingRunReport(missingRunResult));
    writeLine(2, formatMainCancelledReport(mainCancelledResult));
    writeLine(2, formatPrCancelledReport(prCancelledResult));
  }
  process.exitCode = failed ? 1 : 0;
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (IS_CLI) {
  main(process.argv.slice(2)).catch((e) => {
    writeLineSync(2, `✗ ci-red-recovery-watch error: ${String((e && e.stack) || e)}`);
    process.exit(1);
  });
}
