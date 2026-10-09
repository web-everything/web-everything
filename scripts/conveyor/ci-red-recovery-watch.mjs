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
 *
 * `--apply` GATES THE REAL WRITE (the rebase + push), mirroring `we:scripts/conveyor/orphan-claim-release.mjs`'s
 * own convention: bare `sweep` is a DRY RUN (plans and reports, touches nothing), `sweep --apply` actually
 * refreshes. The daemon manifest entry always passes `--apply`; an operator running this by hand gets a
 * safe-by-default dry run. `rebaseDropManifest` itself needs a real local checkout with an `origin` remote (the
 * SAME requirement every other conveyor dispatcher in this directory already has, e.g.
 * `we:scripts/operations/dispatch-lane-io.mjs#REPO_ROOT`) — it fetches the lane ref and pushes the rebuilt tip.
 */
import { resolve } from 'node:path';
import { pushMissingRunCommit } from './missing-run-push.mjs';
import { DECLARED_REQUIRED_STATUS_CHECKS } from '../lib/required-status-checks.mjs';
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
  computeMainRedWindows, planMainRedRebases, DEFAULT_MAIN_WORKFLOW_NAME, DEFAULT_REQUIRED_CHECK,
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
import { rebaseDropManifest } from '../lib/rebase-drop-manifest.mjs';
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
 * @param {string} laneRef
 * @param {{root?:string, base?:string, rebase?:Function}} [o]
 * @returns {{ok:boolean, action:string, error?:string}}
 */
export function refreshOntoMain(laneRef, { root = REPO_ROOT, base = 'origin/main', rebase = rebaseDropManifest } = {}) {
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
  exec = execFileSyncThrottled, repo = null, headRefName = null, headSha = null, ok = true, action = 'rebased', error = null,
  attribution = null, attributedWindow = null,
} = {}) {
  const argv = ['pr', 'comment', String(prNumber), '--body', buildRebaseOntoMainComment({
    headRefName, headSha, ok, action, error, attribution, attributedWindow,
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
 *   readMainGreenFixFacts?:Function,
 *   refresh?:Function}} [o]
 * @returns {{dispatch:Array<object>, refusals:Array<object>, applied:Array<object>, mainRedWindows:Array<object>,
 *   mainLatestCheckRuns:Array<object>}}
 */
export function sweepCiRedRecovery({
  repo = null, apply = false, requiredCheck = null, defaultBranch = 'main',
  readOpenPrs = defaultReadOpenPrs, readMainRuns = defaultReadMainRuns, readAheadBy = defaultReadAheadBy,
  readRequiredContexts = defaultReadRequiredContexts,
  // landing-freeze fix (2026-09-27) — see `main-red-recovery.mjs`'s own "LANDING-FREEZE FIX" section header.
  readMainLatestCheckRuns = defaultReadMainLatestCheckRuns, readMainGreenFixFacts = defaultReadMainGreenFixFacts,
  readMainFixedSignatureFacts = defaultReadMainFixedSignatureFacts,
  readComments = defaultReadPrComments, refresh = refreshOntoMain, postComment = defaultPostRebaseComment,
  maxRebaseRetriesPerSha = DEFAULT_MAX_REBASE_RETRIES_PER_SHA,
  // #2811 — injectable so a test can pin the restamp-first/rearm-fallback chain with no `gh`/child-process.
  reconcileAcceptance = reconcileAcceptanceAfterRebase,
  // Card xu1nixv — the published red-main priority record (WE only); hermetic (null) inside a test run.
  readPriority = () => readMainRedPriority(),
} = {}) {
  const prs = readOpenPrs({ repo });
  // soak-main-red — judge every REQUIRED check (live branch-protection list when readable, else
  // DEFAULT_MAIN_RED_ATTRIBUTED_CHECKS), so a `daemon-soak`-only red PR is refreshed like a `test`-red one.
  // The branch-protection read is paid only when some open PR has ANY failing check at all.
  const prList = Array.isArray(prs) ? prs : [];
  const anyRed = prList.some((pr) => collapseRollupToLatestPerName(pr?.statusCheckRollup).some((c) => isRequiredCheckFailed(pr, c?.name || c?.context)));
  const checks = requiredCheck ? [requiredCheck]
    : ((anyRed ? readRequiredContexts({ repo, branch: defaultBranch }) : null) ?? DEFAULT_MAIN_RED_ATTRIBUTED_CHECKS);
  // The `gh run list --branch main` read only matters when at least one PR has a failing required check to
  // judge against it — mirrors `reconcile-pass.mjs#enrichPrsWithMainRedFacts`'s own "pay for it only when needed".
  const needWindows = prList.some((pr) => isAnyRequiredCheckFailed(pr, checks));
  const mainRuns = needWindows ? readMainRuns({ repo, branch: defaultBranch, workflowName: DEFAULT_MAIN_WORKFLOW_NAME }) : [];
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
    if (!(c.aheadBy > 0)) return c;
    const attribution = classifyCiFailureAttribution({ failureCompletedAt: c.failureCompletedAt, mainRedWindows });
    let withFacts = c;
    let comments;
    if (attribution !== 'main-red') {
      const greenSha = mainLatestGreenShaForCheck({ failingCheckName: c.failingCheckName, mainLatestCheckRuns });
      if (greenSha) {
        withFacts = { ...c, ...readMainGreenFixFacts(c.headSha, { repo, greenSha, checkName: c.failingCheckName }) };
        // xo7mr6l: comments are also needed when merge base is green — a main-defect escalation bypasses that veto.
        // The gate is the shared classifier's own (never a private label signal: this pass does not fetch labels, so
        // the old `needsHuman` gate never fired and #4368's recorded main-defect escalation went unseen).
        if (classifierNeedsComments({ failingCheckName: c.failingCheckName, mainLatestCheckRuns, prContainsMainGreenSha: withFacts.prContainsMainGreenSha })) {
          comments = readComments(c.prNumber, { repo });
          withFacts.comments = comments;
        }
      }
      if (!classifyMainDefect({ requiredCheckCompletedAt: c.failureCompletedAt, mainRedWindows, mainLatestCheckRuns, ...withFacts }).mainDefect) {
        withFacts.mainFixedSignature = readMainFixedSignatureFacts({ repo, defaultBranch,
          detailsUrl: c.detailsUrl, failureCompletedAt: c.failureCompletedAt });
        if (!isMainFixedSignatureOwed(withFacts.mainFixedSignature)) return withFacts;
      }
    }
    comments ??= readComments(c.prNumber, { repo });
    return { ...withFacts, rebaseAttemptsForSha: countRebaseOntoMainComments(comments, c.headSha) };
  });
  // xd3dkzx — mainRuns (with per-check verdicts) so recovery is judged on the PR's own failing check.
  // Card xu1nixv — the red-main fix PRs (published priority record) are never told to wait for main.
  const prio = readPriority();
  const isWe = repo == null || repo === 'we' || repo === CONSTELLATION_REPOS.we.slug;
  const mainFixPrs = prio && prio.repo === 'we' && isWe ? (Array.isArray(prio.prs) ? prio.prs : [prio.pr]) : [];
  const plan = planMainRedRebases({ candidates, mainRedWindows, mainLatestCheckRuns, maxRebaseRetriesPerSha, mainRuns, mainFixPrs });

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
      const result = refresh(d.headRefName, { base: `origin/${defaultBranch}`, root: repoRoot });
      // Posted on EVERY attempt, success or failure — mirrors `sweepHungCiRecovery`'s own discipline: a
      // permanently-failing refresh must still trip {@link DEFAULT_MAX_REBASE_RETRIES_PER_SHA}'s cap, not
      // retry forever silently.
      postComment(d.prNumber, {
        repo, headRefName: d.headRefName, headSha: d.headSha, ok: result.ok, action: result.action, error: result.error ?? null,
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
  return { ...plan, applied, mainRedWindows, mainLatestCheckRuns };
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
 *   kind?:string, ok?:boolean, action?:string, error?:(string|null)}} o
 * @returns {string}
 */
export function buildHungCiComment({
  actor = 'conveyor CI-hung-recovery', runId = null, headSha = null, jobName = null,
  kind = 'hung-cancel-rerun', ok = true, action = 'cancelled-and-rerun', error = null,
} = {}) {
  const outcome = ok
    ? (kind === 'repeat-hang'
      ? `cancelled run ${runId ?? '?'} (job "${jobName ?? '?'}") and did NOT re-run it — this job has hung before on a different head, so this is handed to ci-heal for a real diagnosis instead of retried again.`
      : kind === 'hung-cap-escalate'
        ? `cancelled run ${runId ?? '?'} (job "${jobName ?? '?'}") and did NOT re-run it — this head sha's own hung-recovery retries are exhausted, so this is handed to ci-heal instead of left for GitHub's own job timeout-minutes, which this PR's branch predates.`
        : `found run ${runId ?? '?'} stuck in_progress/queued past the hung threshold; cancelled it and asked GitHub to re-run it.`)
    : `attempted "${action}" on run ${runId ?? '?'} and it FAILED: ${error ?? '(no error text captured)'} — this attempt still counts toward the retry cap so a permanently-failing action (e.g. a token missing \`actions:write\`) cannot retry forever.`;
  return [
    HUNG_CI_COMMENT_MARKER,
    '',
    `sha: ${headSha ?? '(unknown)'}`,
    `job: ${jobName ?? '(unknown)'}`,
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
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#defaultReadPrComments — read one PR's comment thread, the
 * narrow shape {@link countHungCiComments} needs. Called ONLY for a candidate this tick has already found
 * hung (see `sweepHungCiRecovery`'s own "pay for it only when needed" comment) — never for every open PR.
 * @param {number} prNumber
 * @param {{exec?:Function, repo?:string|null}} [o]
 * @returns {Array<object>}
 */
export function defaultReadPrComments(prNumber, { exec = execFileSyncThrottled, repo = null } = {}) {
  const argv = ['pr', 'view', String(prNumber), '--json', 'comments'];
  if (repo) argv.push('--repo', repo);
  const out = exec('gh', argv, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
    timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
  });
  const parsed = JSON.parse(String(out || '{}'));
  return Array.isArray(parsed?.comments) ? parsed.comments : [];
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
 *   jobName?:(string|null), kind?:string, ok?:boolean, action?:string, error?:(string|null)}} [o]
 */
export function defaultPostHungCiComment(prNumber, {
  exec = execFileSyncThrottled, repo = null, runId = null, headSha = null, jobName = null,
  kind = 'hung-cancel-rerun', ok = true, action = 'cancelled-and-rerun', error = null,
} = {}) {
  const argv = ['pr', 'comment', String(prNumber), '--body', buildHungCiComment({
    runId, headSha, jobName, kind, ok, action, error,
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
  const repoArgs = repo ? ['--repo', repo] : [];
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' };
  try {
    exec('gh', ['run', 'cancel', String(runId), ...repoArgs], opts);
  } catch (e) {
    return { ok: false, action: 'cancel-failed', error: describeExecError(e) };
  }
  return { ok: true, action: 'cancelled-no-rerun' };
}

/**
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#cancelAndRerunHungRun — the ONE real write the ordinary
 * (non-repeat-hang) hung-run dispatch performs: `gh run cancel <runId>`, a short bounded pause, then
 * `gh run rerun <runId>` (the WHOLE run — never `--failed`, which matches a `failure` conclusion, not the
 * `cancelled` one this pass's own cancel just produced, and would silently rerun nothing). Never a raw retry
 * of the still-hung attempt in place.
 * @param {number|string} runId
 * @param {{repo?:string|null, exec?:Function, sleepSync?:Function, waitMs?:number}} [o]
 * @returns {{ok:boolean, action:string, error?:string}}
 */
export function cancelAndRerunHungRun(runId, { repo = null, exec = execFileSyncThrottled, sleepSync = defaultSleepSync, waitMs = 5000 } = {}) {
  const repoArgs = repo ? ['--repo', repo] : [];
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' };
  try {
    exec('gh', ['run', 'cancel', String(runId), ...repoArgs], opts);
  } catch (e) {
    return { ok: false, action: 'cancel-failed', error: describeExecError(e) };
  }
  sleepSync(waitMs);
  try {
    exec('gh', ['run', 'rerun', String(runId), ...repoArgs], opts);
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
 * @param {{repo?:string|null, apply?:boolean, requiredCheck?:string, workflowName?:string, thresholdMs?:number,
 *   maxRetriesPerSha?:number, readOpenPrs?:Function, readComments?:Function, cancelAndRerun?:Function,
 *   cancelOnly?:Function, postComment?:Function, now?:number}} [o]
 * @returns {{dispatch:Array<object>, refusals:Array<object>, applied:Array<object>}}
 */
export function sweepHungCiRecovery({
  repo = null, apply = false, requiredCheck = DEFAULT_REQUIRED_CHECK, workflowName = DEFAULT_MAIN_WORKFLOW_NAME,
  thresholdMs = DEFAULT_HUNG_THRESHOLD_MS, maxRetriesPerSha = DEFAULT_MAX_HUNG_RETRIES_PER_SHA,
  readOpenPrs = defaultReadOpenPrs, readComments = defaultReadPrComments,
  cancelAndRerun = cancelAndRerunHungRun, cancelOnly = cancelHungRun, postComment = defaultPostHungCiComment, now = Date.now(),
} = {}) {
  const prs = readOpenPrs({ repo });
  const rawCandidates = buildHungCandidates(prs, { requiredCheck, workflowName });
  // The `gh pr view --json comments` read (to recover the durable per-sha AND per-job attempt counts) only
  // matters for a candidate this tick has ALREADY found hung — mirrors `sweepCiRedRecovery`'s own "pay for it
  // only when needed" discipline (there, gating the `gh run list --branch main` read on `candidates.length`).
  // ONE read serves both counts — never two separate `gh pr view` calls for the same PR.
  const candidates = rawCandidates.map((c) => {
    if (c.runId == null || !Number.isFinite(Date.parse(c.startedAt))) return c;
    const hungNow = (now - Date.parse(c.startedAt)) >= thresholdMs;
    if (!hungNow) return c;
    const comments = readComments(c.prNumber, { repo });
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
  });
  const plan = planHungCiRecoveries({
    candidates, now, thresholdMs, maxRetriesPerSha,
  });

  const applied = [];
  if (apply) {
    for (const d of plan.dispatch) {
      const result = d.runId == null
        ? { ok: false, action: 'no-run-id', error: `PR #${d.prNumber}'s hung check has no resolvable run id (detailsUrl missing/unparseable)` }
        // #4075/#3383, 2026-09-25 18:55 ET correction — `hung-cap-escalate` cancels only, exactly like
        // `repeat-hang`: both hand the PR to the existing ci-red -> ci-heal path rather than retrying.
        : ((d.kind === 'repeat-hang' || d.kind === 'hung-cap-escalate') ? cancelOnly(d.runId, { repo }) : cancelAndRerun(d.runId, { repo }));
      // Posted on EVERY attempt, success or failure — see this function's own docblock above for why.
      if (d.runId != null) {
        postComment(d.prNumber, {
          repo, runId: d.runId, headSha: d.headSha, jobName: d.jobName, kind: d.kind, ok: result.ok, action: result.action, error: result.error ?? null,
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
  for (const a of applied) lines.push(a.ok ? `  ✓ applied: ${a.action} run ${a.runId ?? '?'} (PR #${a.prNumber}) — ${a.why ?? '(no reason recorded)'}` : `  ✗ apply ${a.action} PR #${a.prNumber} run ${a.runId ?? '?'} — ${a.error} (reason it was attempted: ${a.why ?? '(none)'})`);
  return lines.join('\n');
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
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#defaultReadRequiredContexts — the LIVE required-check-name set
 * this pass watches, read off branch protection rather than hardcoded (`GET /repos/{repo}/branches/{branch}/
 * protection`'s own `required_status_checks.contexts`) — per this card's own scope ("read the required contexts
 * from branch protection"). Returns `null` (UNKNOWN) on a read failure (e.g. a token without the scope branch
 * protection needs) or with no `repo` to read — never a substituted default: a guessed set like `['test']` would
 * classify a PR that has already reported a DIFFERENT required context (`smoke`) as "missing every run" and
 * trigger CI it does not need (PR #2740 review). An explicitly empty/absent contexts list is preserved as `[]`
 * (no required context → nothing can be missing). On `null`, {@link buildMissingRunCandidates} falls back to its
 * narrower name-free "no CI-workflow check at all" test.
 * @param {{repo?:string|null, branch?:string, exec?:Function}} [o]
 * @returns {string[]|null}
 */
export function defaultReadRequiredContexts({ repo = null, branch = 'main', exec = execFileSyncThrottled } = {}) {
  if (!repo) return null;
  try {
    const out = exec('gh', ['api', `repos/${repo}/branches/${branch}/protection`, '--jq', '.required_status_checks.contexts'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
    });
    const parsed = JSON.parse(String(out || '').trim() || 'null');
    if (parsed === null) return [];
    return Array.isArray(parsed) ? parsed.filter((n) => typeof n === 'string' && n) : null;
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
  exec = execFileSyncThrottled, repo = null, headRefName = null, headSha = null, ok = true, action = 'pull-request-push', error = null,
  refresh = null, refreshError = null, newHeadSha = null,
} = {}) {
  const argv = ['pr', 'comment', String(prNumber), '--body', buildMissingRunComment({
    headRefName, headSha, ok, action, error, refresh, refreshError, newHeadSha,
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

/**
 * we:scripts/conveyor/ci-red-recovery-watch.mjs#sweepMissingRunRecovery — THE IO SHELL for the missing-run pass
 * (xi4od2p, #4075/#3383). Mirrors {@link sweepCiRedRecovery}/{@link sweepHungCiRecovery}'s own read/plan/act
 * shape and injectability exactly — every reader/writer is injectable so the whole sweep is exercisable with no
 * network and no credential.
 * @param {{repo?:string|null, apply?:boolean, defaultBranch?:string, readOpenPrs?:Function,
 *   readRequiredContexts?:Function, readHeadCommittedAt?:Function, readComments?:Function,
 *   trigger?:Function, postComment?:Function, clearLabel?:Function, thresholdMs?:number, maxRetriesPerSha?:number,
 *   now?:number}} [o]
 * @returns {{dispatch:Array<object>, refusals:Array<object>, applied:Array<object>}}
 */
export function sweepMissingRunRecovery({
  repo = null, apply = false, defaultBranch = 'main',
  readOpenPrs = defaultReadOpenPrs, readRequiredContexts = defaultReadRequiredContexts,
  readHeadCommittedAt = defaultReadHeadCommittedAt, readDeclaredContexts = defaultReadDeclaredContexts,
  readComments = defaultReadPrComments, trigger = triggerCiForPr, postComment = defaultPostMissingRunComment,
  clearLabel = clearStaleCheckingLabel, thresholdMs = DEFAULT_MISSING_RUN_THRESHOLD_MS,
  maxRetriesPerSha = DEFAULT_MAX_MISSING_RUN_RETRIES_PER_SHA, now = Date.now(),
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
  const rawCandidates = buildMissingRunCandidates(prs, { requiredContexts: requiredContexts ?? null, stalledPartialContexts });
  const prByNumber = new Map((Array.isArray(prs) ? prs : []).map((pr) => [Number(pr?.number), pr]));
  // Every per-candidate extra read below only runs for a PR {@link buildMissingRunCandidates} already narrowed
  // to (zero required-check rollup entries at all) — mirrors {@link sweepCiRedRecovery}/{@link sweepHungCiRecovery}'s
  // own "pay for it only when needed" discipline; never one extra `gh` call per ordinary open PR on every tick.
  const candidates = rawCandidates.map((c) => {
    const headCommittedAt = readHeadCommittedAt(c.headSha, { repo });
    const comments = readComments(c.prNumber, { repo });
    return {
      ...c, headCommittedAt, triggerAttemptsForSha: countMissingRunComments(comments, c.headSha, { baseRefName: c.baseRefName }),
    };
  });
  const plan = planMissingRunRecoveries({
    candidates, now, thresholdMs, maxRetriesPerSha,
  });

  const applied = [];
  if (apply) {
    for (const d of plan.dispatch) {
      const result = trigger(d, { repo, defaultBranch });
      // Unknown mergeability, a moving head or a held claim is not an attempt.
      if (result.deferred) {
        applied.push({ prNumber: d.prNumber, headRefName: d.headRefName, why: d.why, labelCleared: false, ...result });
        continue;
      }
      // Posted on EVERY attempt, success or failure — same discipline as every sibling durable marker in this
      // file: a permanently-failing trigger must still trip {@link DEFAULT_MAX_MISSING_RUN_RETRIES_PER_SHA}'s cap.
      postComment(d.prNumber, {
        repo, headRefName: d.headRefName, headSha: d.headSha, ok: result.ok, action: result.action, error: result.error ?? null,
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
  for (const a of applied) lines.push(a.ok ? `  ✓ applied: ${a.action} PR #${a.prNumber}${a.labelCleared ? ' (cleared stale checking label)' : ''} — ${a.why ?? '(no reason recorded)'}` : `  ✗ apply ${a.action} PR #${a.prNumber} — ${a.error} (reason it was attempted: ${a.why ?? '(none)'})`);
  return lines.join('\n');
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
  for (const a of applied) lines.push(a.ok ? `  ✓ applied: ${a.action} ${a.headRefName ?? '?'} onto main (PR #${a.prNumber})` : `  ✗ apply ${a.action} PR #${a.prNumber} ${a.headRefName ?? '?'} — ${a.error}`);
  return lines.join('\n');
}

async function main(argv) {
  const [verbRaw, ...rest] = argv;
  const verb = verbRaw && !verbRaw.startsWith('--') ? verbRaw : 'sweep';
  const flags = parseFlags(verbRaw && !verbRaw.startsWith('--') ? rest : argv);
  if (verb !== 'sweep') {
    writeLineSync(2, 'usage: ci-red-recovery-watch.mjs sweep [--repo=<owner/name>] [--apply] [--json]');
    process.exitCode = 2;
    return;
  }
  const repoFlag = typeof flags.repo === 'string' && flags.repo ? flags.repo : null;
  if (repoFlag && repoKeyForSlug(repoFlag) === null) {
    writeLineSync(2, `✗ ci-red-recovery-watch: --repo ${repoFlag} is not a constellation repo`);
    process.exitCode = 1;
    return;
  }
  const result = sweepCiRedRecovery({ repo: repoFlag, apply: !!flags.apply });
  // xd1sfms (#4075/#3383) — the hung-run pass runs in the SAME `sweep` invocation, never a separate CLI verb:
  // both watch the same open-PR listing for the same reason (a PR wrongly stuck on `checking`), and a daemon
  // manifest entry that already schedules this script (see `we:skills-src/conveyor/daemon-manifest.mjs`'s own
  // `ci-red-recovery-watch` entries) gets the hung-run fix for free rather than needing a second entry.
  const hungResult = sweepHungCiRecovery({ repo: repoFlag, apply: !!flags.apply });
  // xi4od2p (#4075/#3383) — the missing-run pass runs in the SAME `sweep` invocation too, for the identical
  // reason the hung-run pass was folded in above rather than given a second CLI verb: both watch the same
  // open-PR listing for the same reason (a PR wrongly stuck on `checking`), and the daemon-manifest entry that
  // already schedules this script gets the missing-run fix for free rather than needing a third entry.
  const missingRunResult = sweepMissingRunRecovery({ repo: repoFlag, apply: !!flags.apply });
  if (flags.json) {
    writeAllSync(1, `${JSON.stringify({ mainRedRecovery: result, hungRecovery: hungResult, missingRunRecovery: missingRunResult })}\n`);
  } else {
    writeLineSync(2, formatReport(result));
    writeLineSync(2, formatHungReport(hungResult));
    writeLineSync(2, formatMissingRunReport(missingRunResult));
  }
  process.exitCode = 0;
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (IS_CLI) {
  main(process.argv.slice(2)).catch((e) => {
    writeLineSync(2, `✗ ci-red-recovery-watch error: ${String((e && e.stack) || e)}`);
    process.exit(1);
  });
}
