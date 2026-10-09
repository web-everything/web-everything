#!/usr/bin/env node
/**
 * @file scripts/conveyor/parked-pr-conflict-watch.mjs
 * @description The PARKED-PR CONFLICT WATCH (`#xw0odtv`) — a standing, mechanical pass that catches an open,
 *   review-parked PR (`review:human` / `review:pending` / an uncleared `review:changes`) drifting into a REAL
 *   merge conflict against `main` while nobody is actively looking at it, and makes that impossible to miss.
 *
 * WHY THIS EXISTS. Live incident, WE PR #1920: opened parked under `review:human` (a gate-self/statute edit —
 * the conflict-of-interest label), `main` advanced 16 merge commits including one other #2412 sub-slice
 * touching the SAME file, and the PR silently went `mergeable: CONFLICTING` / `mergeStateStatus: DIRTY`. The
 * operator discovered it only by chance, about to clear the `review:human` gate. Traced every existing sweep
 * that reads `mergeable`: `we:scripts/merge-ai-prs.mjs`'s `classifyPr` computes it but a `skip` verdict for a
 * non-rebase-drop-eligible PR is silently discarded (`continue`, no comment, no label);
 * `we:scripts/conveyor/pr-watch.mjs`'s `EXIT_PARKED` is a ONE-SHOT poll that exits the instant a PR first parks
 * and never resumes; `we:scripts/conveyor/branch-drift.mjs` (#3464) watches exactly one named long-lived
 * branch, not the population of open PRs; `#2824` (`we:backlog/2824-launch-agnostic-freshness-gate-any-open-pr-
 * behind-main.md`, still `status: open`) is the closest prior art but is deliberately scoped to
 * `mergeStateStatus === 'BEHIND'` ONLY — its own design explicitly excludes `CONFLICTING`/`DIRTY` ("a
 * real-conflict case… stays left to `/finish`"). Nothing anywhere watches THIS axis. See `#xw0odtv`'s own card
 * for the full reconstruction (merge-base, the overlapping #1911 commit, the backlog search ruling out a
 * duplicate).
 *
 * ALERT-ONLY WAS THE ORIGINAL DESIGN; `#xu2krte` (ratified 2026-09-06,
 * `docs/agent/platform-decisions.md#parked-pr-conflict-dispatched-not-scripted`) NARROWED THAT, NOT REVERSED IT.
 * A real content conflict has no single mechanically-correct resolution for a deterministic SCRIPT: resolving it
 * means choosing which side's edit wins in the overlapping region, exactly the judgment #2824's own design
 * already refuses to automate for this same CONFLICTING/DIRTY case. That reasoning does not extend to
 * dispatching a real AGENT at the same conflict, though — the agent's output still lands through the identical
 * independent-review gate this file's own alert protects (`review:human`/`review:pending`/`review:changes` is
 * never touched by a fix agent, conflict or otherwise). So on a FRESH conflict this pass now does TWO things,
 * not one: it still applies the informative label + one-time alert (below, unchanged), AND it hands the PR to
 * the SAME bounce+fix-dispatch pipeline `we:scripts/conveyor/reconcile-fix-dispatch.mjs` already runs for an
 * ordinary reviewer finding — via `we:scripts/conveyor/reconcile-finding.mjs` ({@link postConflictFinding}) —
 * UNLESS the conflict sits in a declarative-leash/statute-tier file ({@link isStatuteTierConflict}), in which
 * case it routes straight to a human via `we:scripts/conveyor/stand-down.mjs --reason=conflict`
 * ({@link postConflictStandDown}) with no dispatch attempt at all. This file itself still never resolves a
 * conflict or writes a fix — it only decides which of the two existing downstream pipelines a fresh conflict
 * reaches.
 *
 * RESOLVED CONFLICTS OWE A FRESH REVIEW. Once GitHub confirms `mergeable: MERGEABLE` on a previously
 * flagged PR still carrying `review:changes`, hand it to `we:scripts/conveyor/rearm-review.mjs` — the SAME
 * sanctioned hand-back an ordinary repaired bounce uses. Removing only the conflict label stranded this
 * pass's bounce forever; resurrecting an old `review:accepted` would certify a diff predating the resolution.
 * The watcher still posts no clearance comment of its own: rearm owns the durable comment and the
 * `review:changes → review:pending` swap, preserving `review:human`. UNKNOWN is not proof of resolution.
 *
 * PURE-CORE / IO-SHELL SPLIT (mirrors `we:scripts/conveyor/branch-drift.mjs` and
 * `we:scripts/conveyor/review-status-tag.mjs`):
 *   • {@link isParkedConflictTarget} and {@link planConflictLabelChange} are PURE — no fs/git/gh/clock.
 *   • The IO shell ({@link defaultListParkedPrs}, {@link watchParkedPrConflicts}, the CLI) owns every `gh` call,
 *     via `we:scripts/lib/review-label-provider.mjs`'s already-tested, injectable provider port — no new
 *     `execFileSync('gh', …)` call site is hand-rolled here.
 *
 * IDEMPOTENCY, NO SEPARATE STORE. The `merge-status:conflicting` label's own presence/absence on the PR IS the
 * durable marker (mirrors `we:scripts/conveyor/review-status-tag.mjs`'s own "the label is the state" contract):
 * a comment is posted only on the transition from absent→present, never repeated while the label already sits
 * on the PR, and the label is removed (self-healing, no comment) the tick the conflict clears — no git note, no
 * `.claude/locks` entry, no new JSON store (per the #2612 "no parallel state store" ruling).
 *
 * APPROVED PRS TOO (x832e2v, live 2026-09-23). An approved/queued PR (`review:accepted` / `ready-to-merge`)
 * that drifts into a conflict used to be skipped by this pass AND silently skipped by the drain. It is now
 * labelled at once but bounced only after {@link QUEUED_CONFLICT_GRACE_MS}, giving the drain first try at
 * the one conflict it heals itself; the bounce strips the old approval, so the resolved diff is re-reviewed.
 *
 * THE CADENCE. Each constellation repo runs this as its own resident `pass-daemon` watcher
 * (`we:skills-src/conveyor/daemon-manifest.mjs`, `parked-pr-conflict-watch-<repo>`); the headless runner's
 * `makeCliMechanicalPasses` also calls it when that runner is up.
 *
 * THE THIRD, PREVIOUSLY-INVISIBLE POPULATION — UNOWNED (#xs81oxb, parent #4075/#3383). Live-caught,
 * `web-everything/web-everything#2709` (`fix(#4138)`, stacked on #2708 which merged at 02:13Z 2026-09-26): a DIRTY PR
 * carrying NO review-workflow label at all — not `review:human`/`pending`/`changes` (the PARKED population above)
 * and not `review:accepted`/`ready-to-merge` (the QUEUED population above) — matched neither. `classifyPr`
 * (`we:progress-board.mjs`) still reads it as `conflicted`, so `we:scripts/conveyor/reconcile-core.mjs` keeps
 * refusing it `owed-elsewhere` ("the branch needs a rebase") every tick, forever — the fix-dispatch daemon's own
 * log for this exact PR. Nothing else in this repo will ever pick it up: the drain only lands a QUEUED PR (this
 * one carries neither go-ahead label, so it is never even considered for a landing attempt, let alone the
 * rebase-drop the drain tries as part of landing); `we:scripts/conveyor/ci-red-recovery-watch.mjs` /
 * `we:scripts/conveyor/main-red-recovery.mjs` only act on a FAILING required check (this PR is not `ci-red`);
 * and `reconcile-core.mjs`'s own STACKED-BASE CONFLICT branch (`#3383`) only fires when `baseRefName !==
 * defaultBranch` — GitHub already retargeted this PR's base to `main` once its stacked base (#2708) merged and
 * its branch was deleted, so that branch never even sees it either.
 *
 * {@link isUnownedConflictTarget} names this population precisely: `mergeable === 'CONFLICTING'`, a base equal
 * to `main` (or unknown — a stacked base is the OTHER branch's job, unchanged), and NEITHER
 * {@link isParkedConflictTarget} NOR {@link isQueuedConflictTarget} already claims it. UNLIKE the queued
 * population, it gets NO grace period — {@link QUEUED_CONFLICT_GRACE_MS} exists to give the drain first try at
 * a conflict it might rebase-drop while LANDING a queued PR, and this population is never queued, so there is no
 * drain turn to wait out. On the very sweep that detects it, this file ATTEMPTS THE MECHANICAL FIX ITSELF
 * ({@link defaultAttemptUnownedConflictRebase}) before ever bouncing anyone: it reuses the SAME proven,
 * no-checkout plumbing the drain and `ci-red-recovery-watch.mjs` already trust
 * (`we:scripts/lib/rebase-drop-manifest.mjs#rebaseDropManifest`) — DELIBERATELY NEVER the GitHub `PUT
 * repos/{repo}/pulls/{n}/update-branch` REST endpoint, which `main-red-recovery.mjs`'s own file header already
 * recorded (2026-09-25) reintroduces the exact shared `.lane-manifest.json` collision this plumbing exists to
 * drop — a lesson this repo already paid for once, not one to re-learn on a third population. When the conflict
 * turns out to be the shared-manifest shape (or the tip was merely behind), the rebuilt tip is pushed for real
 * and nothing further happens — no label, no bounce, no fix agent spent on a conflict a two-line rebuild already
 * cleared. Only when `rebaseDropManifest` itself reports a REAL (non-manifest) conflict does this population
 * fall through into the SAME bounce+fix-dispatch pipeline the parked path already runs
 * ({@link defaultPostConflictFinding} — `review:changes` + `CONFLICT_LABEL`, "reason: conflict" on the thread),
 * which `reconcile-core.mjs`'s own `isConflictBounce` carve-out already caps on `CONFLICT_FIX_ROUND_CAP` and
 * dispatches a real fix agent for, exactly like an ordinary reviewer-flagged conflict — so this never refuses
 * forever, it just stops being silent about who owes the rebase.
 *
 * WHY HERE, NOT A NEW WATCHER OR A CHANGE TO `reconcile-core.mjs`'s ROUTING TABLE. This file already owns every
 * piece the fix needs — the git-level manifest-vs-real disposition check ({@link defaultComputeConflictDisposition}
 * already exists for the queued population), the label lifecycle, and the bounce-to-fix pipeline — so extending
 * it is additive, not a new parallel mechanism. `reconcile-core.mjs`'s `owed-elsewhere` refusal for a `conflicted`
 * PR remains factually TRUE even after this fix (a rebase genuinely is owed elsewhere) — the change is that
 * "elsewhere" now has an owner, exactly the same shape `owed-ci-rerun` already has against
 * `ci-red-recovery-watch.mjs`: that refusal never needed `reconcile-core.mjs` itself to change either, only a
 * watcher that makes the thing it names actually happen. No new per-head-sha counter was added for the
 * escalation cap either: `reconcile-core.mjs`'s existing liveness check already refuses a second fix dispatch
 * while one is live on this exact PR, and `CONFLICT_FIX_ROUND_CAP` already bounds repeated real-conflict rounds
 * — inventing a parallel per-sha marker here would duplicate a cap this population already inherits for free.
 */
import { isGhDeferred } from '../lib/gh-deferred.mjs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { readSharedOpenPrs } from '../lib/pr-snapshot.mjs';
import { readPrsFromFile } from './open-pr-fetch.mjs';

import { createGhProvider } from '../lib/review-label-provider.mjs';
import { REVIEW_LABELS, hasReviewLabel, hasUnclearedReviewLabel, isDeclarativeLeashPath, isStatutePath } from '../lib/review-escalation.mjs';
import { writeAllSync, writeLineSync } from '../lib/write-all-sync.mjs';
import { REPO_ROOT } from '../operations/dispatch-lane-io.mjs';
import {
  standDownComments, WATCHER_STAND_DOWN_ACTOR, STAND_DOWN_MARKER, SUPERSEDE_STAND_DOWN_MARKER, isStandDownSuperseded,
} from './stand-down.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
import { scopePrsToQueue } from './queue-scope.mjs';
import { parseMergeTree, manifestConflictDisposition, rebaseDropManifest } from '../lib/rebase-drop-manifest.mjs';
// #xu38vlf (epic #4075/#3383) — the two gap fixes below (cap the unowned rebase-drop retry; bound the
// rearm-deferred wait) both surface through the SAME two operator-visible channels every sibling cap-exhaustion
// note in this repo already uses: the #2725 reconcile-notes durable PR comment, and the health-watch desktop
// notify. Neither is heavy — `reconcile-note-comment.mjs` is itself a leaf-light `gh pr comment` IO shell
// (mirrors `ci-heal-mark.mjs`), and `notifyDesktopChecked` is `branch-sync.mjs`'s own already-tested,
// best-effort macOS notify (never throws; a delivery failure must never break the sweep).
import { planNoteComment, postNoteComment } from './reconcile-note-comment.mjs';
import { notifyDesktopChecked } from './branch-sync.mjs';
import { UNOWNED_REBASE_ATTEMPT_MARKER, UNOWNED_REBASE_ATTEMPT_CAP, countUnownedRebaseAttempts } from './unowned-rebase-attempt-count.mjs';
import { countConflictFixComments, CONFLICT_FIX_COMMENT_MARKER } from './conflict-fix-round-count.mjs';
// #4118 (c) — the SAME name-based, gh-agents-truth liveness check `review-status-tag.mjs` already uses, and for
// the identical reason its own docblock states: staying independent of `reconcile-core.mjs#assessLiveness`'s
// much heavier transitive import graph (`rearm-review.mjs` → `review-set-label.mjs` → `merge-ai-prs.mjs`, which
// calls `promisify(execFile)` at module load — the exact hazard `stuck-pr-dispatch-marker.mjs`'s own header
// documents avoiding). `defaultListAgents` is already this file's own sibling import (`REPO_ROOT` already comes
// from the same module) — no new heavy dependency, just one more named export off it.
import { defaultListAgents } from '../operations/dispatch-lane-io.mjs';
import { deriveReviewStatus } from './review-status-tag.mjs';
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';
// #4118 review finding (security/authz) — the SAME `author.login`-gated trust rule #3383 already put behind
// every OTHER durable marker reader in this file's sibling modules (`stand-down.mjs#isTrustedMarkerAuthor` call
// sites, `rearm-review.mjs`, `ci-heal-mark.mjs`, `advisory-fix-mark.mjs`, `conflict-fix-round-count.mjs`,
// `advisory-round-count.mjs`, `reconcile-core.mjs`) — see this file's own `hasRecentConflictAlertComment` /
// `latestConflictAlertCreatedAtMs` / `hasRecentConflictFindingComment` for why these three, uniquely in this
// file, were missing it.
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { operatorAnswerForStandDown } from './stand-down-answer-core.mjs';

// #xkmu3gv — single-sourced in the new leaf `we:scripts/conveyor/conflict-label.mjs` (a genuine pure leaf, no
// imports) so `we:scripts/conveyor/reconcile-core.mjs` can read the label with no heavier pull-in than this
// file's own fs/gh/network graph. IMPORTED (not `export … from`, which binds no local name) AND re-exported so
// this file's OWN detection/posting logic below keeps working unchanged, and every existing importer of this
// module's `CONFLICT_LABEL`/`CONFLICT_LABEL_META` (`reconcile-fix-dispatch.mjs`) needs no edit either. See that
// leaf's own header for the full reasoning and the original docblock this text used to carry.
import { CONFLICT_LABEL, CONFLICT_LABEL_META } from './conflict-label.mjs';
// Card xkugvzd — the idle re-assert for an already-labelled, still-conflicting `review:human` PR (live: #4481).
import { CONFLICT_REASSERT_OFF, decideConflictReassert, resolveConflictReassertSettings } from './conflict-reassert-rule.mjs';

export { CONFLICT_LABEL, CONFLICT_LABEL_META };

/** How many open PRs one `gh pr list` call reads per repo — generous relative to any repo's live parked count. */
export const PR_LIST_LIMIT = 200;

// ── PURE CORE (no fs / git / gh / clock — every input is injected) ─────────────────────────────────────────

/**
 * Is this open PR a PARKED-CONFLICT target — a REAL merge conflict (`mergeable === 'CONFLICTING'`) sitting on a
 * PR that is ALSO parked for review (an uncleared `review:human` / `review:pending` / `review:changes` hold)?
 * PURE. Reuses the SAME canonical hold predicate `classifyPr` / `#2824`'s own `isFreshnessRefreshTarget` use
 * (`hasUnclearedReviewLabel`, `we:scripts/lib/review-escalation.mjs`), not a re-declared local check.
 *
 * Deliberately narrower than `we:scripts/merge-ai-prs.mjs#isRebaseDropCandidate`, which also fires on BEHIND/
 * DIRTY for a CERTIFIED+green PR queued to merge — that is a different population (queued, mechanically
 * healable) from this one (parked for human judgment, a real content conflict). `allowPending: false` so a
 * plain `review:pending` park counts too, not just `review:human` — matching the task's own framing of "a
 * slow human/review step", not only the conflict-of-interest gate.
 * @param {{mergeable?:string, labels?:Array}} pr
 * @returns {boolean}
 */
export function isParkedConflictTarget(pr) {
  const mergeable = String(pr?.mergeable || '').toUpperCase();
  if (mergeable !== 'CONFLICTING') return false;
  return hasUnclearedReviewLabel(pr?.labels, { allowPending: false });
}

/** How long an APPROVED/queued PR may sit conflicting before it is bounced to a fix agent. The drain runs every
 *  minute or so but a pass can take many minutes; this gives it a real chance at the one conflict it heals on
 *  its own (a shared-manifest-only conflict, rebase-dropped on land) before the PR is sent back through fix
 *  and review. */
export const QUEUED_CONFLICT_GRACE_MS = 30 * 60 * 1000;

/**
 * Is this an APPROVED/queued PR (`review:accepted` or `ready-to-merge`, no uncleared hold) that has drifted into
 * a real conflict? PURE. Live-caught 2026-09-23: four approved PRs (#2503, #2505, #2514, #2515) sat DIRTY with
 * nothing acting on them — the parked predicate above skips a cleared PR, and the drain silently skips a
 * conflict it cannot rebase-drop. Such a PR is not bounced at once (the drain gets {@link QUEUED_CONFLICT_GRACE_MS}
 * first); once bounced, its old approval is stripped and it goes through fix and re-review like any other.
 * @param {{mergeable?:string, labels?:Array}} pr
 * @returns {boolean}
 */
export function isQueuedConflictTarget(pr) {
  if (String(pr?.mergeable || '').toUpperCase() !== 'CONFLICTING') return false;
  if (hasUnclearedReviewLabel(pr?.labels, { allowPending: false })) return false; // the parked path owns it
  return hasReviewLabel(pr?.labels, REVIEW_LABELS.accepted) || hasReviewLabel(pr?.labels, 'ready-to-merge');
}

/**
 * Is this an UNOWNED conflicting PR — `mergeable === 'CONFLICTING'`, based on `main` (or an unknown base; a
 * STACKED base is `reconcile-core.mjs#3383`'s STACKED-BASE CONFLICT branch's job, unchanged), and claimed by
 * NEITHER {@link isParkedConflictTarget} (no uncleared `review:human`/`pending`/`changes` hold) NOR
 * {@link isQueuedConflictTarget} (no `review:accepted`/`ready-to-merge` go-ahead either)? PURE. #xs81oxb
 * (parent #4075/#3383) — live-caught on `web-everything/web-everything#2709`: a formerly-stacked PR whose base merged
 * and was retargeted to `main`, left carrying only an unrelated `checking` label. See this file's own header,
 * "THE THIRD, PREVIOUSLY-INVISIBLE POPULATION", for the full incident and why this population gets no grace
 * period (unlike {@link isQueuedConflictTarget}'s own `QUEUED_CONFLICT_GRACE_MS}` wait).
 * @param {{mergeable?:string, labels?:Array, baseRefName?:string|null}} pr
 * @returns {boolean}
 */
export function isUnownedConflictTarget(pr) {
  if (String(pr?.mergeable || '').toUpperCase() !== 'CONFLICTING') return false;
  const baseRefName = pr?.baseRefName ?? null;
  if (baseRefName && baseRefName !== 'main') return false; // stacked base — reconcile-core.mjs#3383 owns it
  if (isParkedConflictTarget(pr) || isQueuedConflictTarget(pr)) return false; // already owned elsewhere
  return true;
}

/**
 * How long ago the conflict label was last applied to this PR, from the issue's own event timeline. Returns
 * `null` when it cannot tell — the caller then waits rather than bouncing (the safe direction).
 * @returns {number|null} milliseconds since the label was applied
 */
export function defaultConflictLabelAgeMs({ pr, repo, exec = execFileSyncThrottled, now = Date.now() }) {
  try {
    // Events come oldest-first and a busy PR can span pages: paginate, one line per page, keep the latest date.
    const path = `repos/${repo}/issues/${pr?.number}/events?per_page=100`;
    // #x5n4zn3 — was bare (no timeout).
    const out = exec('gh', ['api', '--paginate', path, '--jq',
      `[.[] | select(.event=="labeled" and .label.name=="${CONFLICT_LABEL}") | .created_at] | last`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
    const times = String(out || '').split('\n').map((l) => Date.parse(l.trim())).filter(Number.isFinite);
    return times.length ? now - Math.max(...times) : null;
  } catch {
    return null;
  }
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#defaultConflictLabelRemovedAtMs — #4118 round 2: when the
 * CONFLICT_LABEL was last REMOVED from this PR (the end of its previous conflict episode), from the same issue
 * event timeline {@link defaultConflictLabelAgeMs} reads. This is the episode boundary the marker dedups key on
 * (see the section above `CONFLICT_RETRY_WINDOW_MS`): unlike the `labeled` event, it exists even on a
 * crash-recovery retry, because it belongs to the PREVIOUS episode, not the one being retried.
 * @returns {number|null} epoch ms of the latest removal; `0` if the label was never removed; `null` if unreadable
 */
export function defaultConflictLabelRemovedAtMs({ pr, repo, exec = execFileSyncThrottled }) {
  try {
    const path = `repos/${repo}/issues/${pr?.number}/events?per_page=100`;
    const out = exec('gh', ['api', '--paginate', path, '--jq',
      `[.[] | select(.event=="unlabeled" and .label.name=="${CONFLICT_LABEL}") | .created_at] | last`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
    const times = String(out || '').split('\n').map((l) => Date.parse(l.trim())).filter(Number.isFinite);
    return times.length ? Math.max(...times) : 0;
  } catch {
    return null;
  }
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#gitMergeTreeParsed — the shared fetch + WORKING-TREE-FREE
 * `git merge-tree --write-tree` probe both {@link defaultComputeConflictDisposition} and
 * {@link defaultConflictingFilePaths} run — factored out (#xconflres1) so the two can never drift on the
 * fetch/exec shape, and so a conflicting PR's OWN path list ({@link parseMergeTree}'s `conflictPaths`) is
 * available to a caller that needs the paths themselves, not just the manifest-vs-real disposition string.
 * `git fetch` both refs is best-effort (mirrors `we:scripts/conveyor/branch-drift.mjs#computeDrift`'s own
 * fetch-then-probe shape exactly: a stale local ref still answers; a genuinely unresolvable one fails the
 * probe closed, below).
 *
 * Returns `null` on ANY failure to resolve/fetch/probe (no `headRefName`, both `git` calls throwing with no
 * parseable output, an unparseable `merge-tree` result) — every caller reads `null` as "cannot tell" and keeps
 * its own existing safe-direction fallback (an unnarrowed wait, or the full changed-file list) unchanged.
 * @param {{pr:{headRefName?:string, baseRefName?:string}, cwd?:string, exec?:Function}} o
 * @returns {?{tree:string, clean:boolean, conflictPaths:string[]}}
 */
function gitMergeTreeParsed({ pr, cwd = REPO_ROOT, exec = execFileSyncThrottled } = {}) {
  const head = pr?.headRefName;
  if (typeof head !== 'string' || head === '') return null;
  const base = (typeof pr?.baseRefName === 'string' && pr.baseRefName) || 'main';
  const childOpts = { cwd, timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' };
  try {
    exec('git', ['fetch', 'origin', '--quiet',
      `+${base}:refs/remotes/origin/${base}`, `+${head}:refs/remotes/origin/${head}`],
    { ...childOpts, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch { /* best-effort — a stale local ref may still resolve below */ }
  let stdout = '';
  let exitCode = 0;
  try {
    stdout = exec('git', ['merge-tree', '--write-tree', `origin/${base}`, `origin/${head}`],
      { ...childOpts, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // A conflicting merge-tree exits non-zero, which execFileSync/execFileSyncThrottled THROWS on — the
    // conflicted-file-info output is on the thrown error's own `.stdout`, exactly like every other `merge-tree`
    // caller in this repo (`rebase-drop-manifest.mjs`'s own real runner reads it the same way).
    stdout = typeof e?.stdout === 'string' ? e.stdout : (e?.stdout ? String(e.stdout) : '');
    exitCode = typeof e?.status === 'number' ? e.status : 1;
    if (!stdout) return null; // a transient/resolution error, not a parseable conflict — cannot tell
  }
  const parsed = parseMergeTree(stdout, exitCode);
  if (!parsed.tree) return null;
  return parsed;
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#defaultComputeConflictDisposition — #xngv3vn (the queued-
 * conflict grace was wasted on a conflict the drain can never heal). A LOCAL, git-level classification of what
 * is ACTUALLY conflicting, reusing the EXACT plumbing the drain itself uses to decide whether it can heal a
 * conflict at all — `we:scripts/lib/rebase-drop-manifest.mjs`'s {@link parseMergeTree}/
 * {@link manifestConflictDisposition}, via the shared {@link gitMergeTreeParsed} probe — never a second,
 * independently-drifting opinion of "drain-resolvable".
 *
 * WHY THIS MATTERS: `we:scripts/conveyor/parked-pr-conflict-watch.mjs#QUEUED_CONFLICT_GRACE_MS` gives the
 * drain 30 minutes before bouncing an approved/queued conflicting PR to a fix agent — reasonable ONLY for the
 * one conflict shape the drain can actually rebase-drop on its own (`.lane-manifest.json` alone,
 * `we:scripts/lib/rebase-drop-manifest.mjs`'s whole reason to exist). A PR conflicting on real content has NO
 * chance of resolving in that window no matter how long it waits — the drain has no code path that touches
 * anything but the manifest — so waiting out the full grace on it is pure delay with no upside. This function
 * is what lets the caller tell the two shapes apart BEFORE the wait, not just after it expires.
 *
 * Returns `null` on ANY failure to resolve/fetch/probe — the caller reads `null` as "cannot tell" and keeps
 * the EXISTING wait unchanged (the safe direction: a probe hiccup costs at most the pre-#xngv3vn wait, never a
 * wrongly-skipped grace on a conflict that might in fact be manifest-only).
 * @param {{pr:{headRefName?:string, baseRefName?:string}, cwd?:string, exec?:Function}} o
 * @returns {?('clean'|'manifest-only'|'real')}
 */
export function defaultComputeConflictDisposition({ pr, cwd = REPO_ROOT, exec = execFileSyncThrottled } = {}) {
  const parsed = gitMergeTreeParsed({ pr, cwd, exec });
  if (!parsed) return null;
  return manifestConflictDisposition(parsed);
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#defaultConflictingFilePaths — #xconflres1 (live incident,
 * `web-everything/web-everything#2772` — see {@link isStatuteTierConflict}'s own docblock for the full incident this
 * closes). The CONTENT-BASED, PRECISE alternative {@link isStatuteTierConflict}'s own docblock already named as
 * future work: rather than reading the PR's WHOLE changed-file set (an over-cautious approximation that routes a
 * PR to a human whenever a leash/statute file merely SITS IN the diff, whether or not it is any part of the
 * actual same-line conflict), this reads the git-level `git merge-tree` conflict-path list — the SAME probe
 * {@link defaultComputeConflictDisposition} runs, via the shared {@link gitMergeTreeParsed} — so a caller can
 * narrow the statute-tier check to the file(s) ACTUALLY in conflict.
 *
 * CONFIRMED LIVE 2026-09-27: PR #2772 (`fix(gh-shim): resolve GH_THROTTLE_CLI through primaryCheckout, never a
 * lane`) touched `scripts/lib/__tests__/gate-invariants.test.mjs` (a `POLICY_SPEC` / declarative-leash basename)
 * ELSEWHERE in its diff, with NO conflict there at all — a real `git merge-tree --write-tree origin/main
 * origin/lane/fix-gh-shim-stable-path` (no writes) resolves the ONE actually-conflicting path as
 * `scripts/conveyor/health-smells/index.mjs`, an ordinary ENGINE-tier file. The whole-diff heuristic stood the
 * PR down as a "genuine same-line conflict" needing a human, when the real conflict was a purely mechanical
 * rebase/resolve a fix agent could (and, once this fix landed, did) run.
 *
 * Returns `null` on ANY failure to resolve/fetch/probe (the same {@link gitMergeTreeParsed} cases) — the caller
 * reads `null` as "cannot tell which files conflict" and falls back to its OWN existing whole-file-set check,
 * the safe direction (over-cautious never under-cautious). Returns `[]` when the probe ran clean (`disposition`
 * would read `'clean'`/no parseable conflict path at all) — a caller that narrows on an empty list would wrongly
 * clear a PR that GitHub itself still reports `CONFLICTING`, so every call site here treats an EMPTY array
 * exactly like `null` (fall back to the full file set), never as "definitely nothing statute-tier conflicts".
 * @param {{pr:{headRefName?:string, baseRefName?:string}, cwd?:string, exec?:Function}} o
 * @returns {?string[]}
 */
export function defaultConflictingFilePaths({ pr, cwd = REPO_ROOT, exec = execFileSyncThrottled } = {}) {
  const parsed = gitMergeTreeParsed({ pr, cwd, exec });
  return parsed ? parsed.conflictPaths : null;
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#defaultAttemptUnownedConflictRebase — THE REAL MECHANICAL FIX
 * for {@link isUnownedConflictTarget} (#xs81oxb). Reuses the SAME proven, no-checkout plumbing the drain and
 * `we:scripts/conveyor/ci-red-recovery-watch.mjs` already trust
 * (`we:scripts/lib/rebase-drop-manifest.mjs#rebaseDropManifest`) — deliberately NEVER the GitHub `PUT
 * repos/{repo}/pulls/{n}/update-branch` REST endpoint, which `we:scripts/conveyor/main-red-recovery.mjs`'s own
 * file header already recorded (2026-09-25) reintroduces the exact shared `.lane-manifest.json` collision this
 * plumbing exists to drop. Injectable (the `run` a caller's test double supplies flows straight through to
 * `rebaseDropManifest`, which is itself already unit-tested against a fake runner — no real `git`/`gh` call is
 * ever made from a test that injects one here).
 * @param {{pr:{headRefName?:string}, cwd?:string, run?:Function}} o
 * @returns {{action:('rebased'|'current'|'skip'|'error'), [key:string]:*}} rebaseDropManifest's own result shape
 */
export function defaultAttemptUnownedConflictRebase({ pr, cwd = REPO_ROOT, run } = {}) {
  return rebaseDropManifest({ laneRef: pr?.headRefName, base: 'origin/main', cwd, ...(run ? { run } : {}) });
}

/**
 * PURE: add the conflict marker on detection, remove it on confirmed resolution, and report the transition.
 * `isResolved` comes from GitHub's
 * mergeable field, independently of the parked-review predicate; an unknown result must keep the marker
 * so a later confirmed resolution can still trigger the hand-back. Mirrors
 * `we:scripts/conveyor/review-status-tag.mjs#planStatusLabelChange`'s add/remove shape.
 * @param {{isConflicting:boolean, isResolved?:boolean, currentLabels?:Array<{name?:string}|string>}} o
 * @returns {{add:string|null, remove:string[], newlyDetected:boolean, newlyResolved?:boolean}}
 */
export function planConflictLabelChange({ isConflicting, isResolved = false, currentLabels = [] } = {}) {
  const names = currentLabels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
  const already = names.includes(CONFLICT_LABEL);
  if (isConflicting && !already) return { add: CONFLICT_LABEL, remove: [], newlyDetected: true };
  if (!isConflicting && already && isResolved) return { add: null, remove: [CONFLICT_LABEL], newlyDetected: false, newlyResolved: true };
  return { add: null, remove: [], newlyDetected: false };
}

// ── #4118 — crash-safety idempotency for the one-time alert + fix/stand-down dispatch ──────────────────────
//
// THE CARD (bornAs x3zr5tu): a crash between `provider.setLabels` (the label write) and `provider.postComment`
// (the alert) used to lose the alert FOREVER — the label's own presence was this file's ONLY durable marker
// (see this file's header, "IDEMPOTENCY, NO SEPARATE STORE"), so the next sweep read "already labelled" and
// skipped the PR for good. FOLDED IN, same root cause, from the adversarial review: a crash between the label
// and the DISPATCH (`postFinding`/`postStandDown`) left the routing decision unmade forever too — the next
// sweep's `plan.add` reads null (already labelled) and the PR is skipped, never retried (finding (a)).
//
// THE FIX ({@link watchParkedPrConflicts}): apply the label LAST, only once the alert comment and the dispatch
// have both either just succeeded or were already found on the PR's own thread. A crash before the label lands
// leaves `plan.add` truthy on the NEXT sweep, so this whole branch retries — cheaply, because the marker checks
// below skip whatever already landed instead of reposting/re-dispatching it.
//
// WHICH MARKERS COUNT: an EPISODE BOUNDARY plus a TIME WINDOW. A marker comment counts only when it was posted
// AFTER the CONFLICT_LABEL was last removed ({@link defaultConflictLabelRemovedAtMs}) AND within the last
// {@link CONFLICT_RETRY_WINDOW_MS}.
// - The boundary is the end of the PREVIOUS episode, not the start of this one. The start ("labeled" event) is
//   unusable here: on a crash-recovery retry the label was never applied, so that event never fired. The end
//   ("unlabeled" event) does exist, because the watch removes the label when a conflict resolves. This is what
//   stops a RAPID re-conflict (resolved and conflicting again inside the window) from reading the previous
//   episode's alert/finding/stand-down as its own (#4118 round-2 review).
// - The window is a second guard for the one case the boundary cannot see: an episode that never got its label
//   (crashed) and then resolved with no label to remove. Its markers age out after the window.
// - An UNREADABLE boundary counts no marker at all. That costs at most one duplicate post (the label lands right
//   after, closing the branch); the opposite error would silently drop a fresh conflict's alert or dispatch.
export const CONFLICT_RETRY_WINDOW_MS = 20 * 60 * 1000;

/** PURE: does a comment's `createdAt` fall inside the current episode ({@link CONFLICT_RETRY_WINDOW_MS} section)? */
function isInCurrentEpisode(c, { now, windowMs, sinceMs }) {
  const ms = Date.parse((typeof c === 'string' ? null : c?.createdAt) ?? '');
  return Number.isFinite(ms) && ms > sinceMs && Math.abs(now - ms) <= windowMs;
}

/** The fixed lead-in {@link buildConflictComment} always renders first (only the "parked"/"approved" word
 *  varies) — matched, never re-rendered, by {@link hasRecentConflictAlertComment} / {@link latestConflictAlertCreatedAtMs}. */
export const CONFLICT_ALERT_MARKER_RE = /^⚠️ \*\*This (?:parked|approved) PR has drifted into a real merge conflict against `main`\*\*/;

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#hasRecentConflictAlertComment — #4118's crash-safety dedup
 * for the one-time alert comment: has THIS WATCH already posted {@link buildConflictComment}'s alert, recently
 * enough that it can only be the SAME still-open detection retrying after a crash (see the `CONFLICT_RETRY_
 * WINDOW_MS` section above for why "recently" substitutes for an exact episode boundary)? PURE.
 *
 * #4118 review finding (security/authz) — ALSO requires {@link isTrustedMarkerAuthor}: WE's PRs are public, so
 * without this any other GitHub login could post a comment whose body matches {@link CONFLICT_ALERT_MARKER_RE}
 * and make this function (and, downstream, the label-applies-last dispatch this fix exists to protect) read the
 * real alert as already-posted — silently skipping it, then still applying CONFLICT_LABEL, exactly the crash
 * failure mode this whole card fixes, now reachable with no crash at all. The SAME two-principal trust rule
 * (`we:scripts/lib/marker-authorship.mjs`) every sibling marker reader in this repo already applies
 * (`stand-down.mjs`, `rearm-review.mjs`, `ci-heal-mark.mjs`, `advisory-fix-mark.mjs`,
 * `conflict-fix-round-count.mjs`, `advisory-round-count.mjs`, `reconcile-core.mjs`) — this file's own three
 * #4118 marker readers were the one place it had not yet been applied.
 * @param {Array<{body?:string, createdAt?:string, author?:{login?:string}, viewerDidAuthor?:boolean}|string>|null|undefined} comments
 * @param {{now?:number, windowMs?:number, sinceMs?:number}} [o] `sinceMs` — the episode boundary (epoch ms of
 *   the last CONFLICT_LABEL removal); only markers posted strictly after it count.
 * @returns {boolean}
 */
export function hasRecentConflictAlertComment(comments, { now = Date.now(), windowMs = CONFLICT_RETRY_WINDOW_MS, sinceMs = -Infinity } = {}) {
  if (!Array.isArray(comments)) return false;
  for (const c of comments) {
    const body = typeof c === 'string' ? c : c?.body;
    if (typeof body !== 'string' || !CONFLICT_ALERT_MARKER_RE.test(body.trimStart()) || !isTrustedMarkerAuthor(c)) continue;
    if (isInCurrentEpisode(c, { now, windowMs, sinceMs })) return true;
  }
  return false;
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#latestConflictAlertCreatedAtMs — the MOST RECENT alert
 * comment's own timestamp, UNSCOPED by recency (unlike {@link hasRecentConflictAlertComment} above) — used only
 * as a fallback age source for the grace-expiry check ({@link watchParkedPrConflicts}) when
 * {@link defaultConflictLabelAgeMs} itself cannot answer (adversarial-review finding (b): an unreadable events
 * API used to leave that check waiting FOREVER, with no fallback). Safe to trust WITHOUT recency scoping there
 * specifically because the CONFLICT_LABEL is already confirmed present at that call site — and by this file's
 * own effect ordering (the label applies LAST, only once the alert has landed), the label cannot still be
 * sitting on a PR from an episode whose alert-then-label sequence never completed. PURE.
 *
 * #4118 review finding (security/authz) — ALSO requires {@link isTrustedMarkerAuthor}, for the same reason as
 * {@link hasRecentConflictAlertComment}: without it, an attacker who keeps posting fresh forged alert-marker
 * comments could hold the fallback `age` near zero forever, indefinitely suppressing the post-drain-grace
 * dispatch for a genuinely conflicting PR.
 * @param {Array<{body?:string, createdAt?:string, author?:{login?:string}, viewerDidAuthor?:boolean}|string>|null|undefined} comments
 * @returns {?number}
 */
export function latestConflictAlertCreatedAtMs(comments) {
  if (!Array.isArray(comments)) return null;
  let best = null;
  for (const c of comments) {
    const body = typeof c === 'string' ? c : c?.body;
    if (typeof body !== 'string' || !CONFLICT_ALERT_MARKER_RE.test(body.trimStart()) || !isTrustedMarkerAuthor(c)) continue;
    const ms = Date.parse((typeof c === 'string' ? null : c?.createdAt) ?? '');
    if (Number.isFinite(ms) && (best === null || ms > best)) best = ms;
  }
  return best;
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#CONFLICT_FIX_ROUND_CAP — DUPLICATED, not imported, from
 * `we:scripts/conveyor/reconcile-core.mjs#CONFLICT_FIX_ROUND_CAP` (3) — same value, same reasoning that file's
 * own docblock gives, mirrored here for the SAME reason `reconcile-core.mjs` itself duplicates rather than
 * imports `CI_HEAL_ROUND_CAP` from `tick-core.mjs`: importing `reconcile-core.mjs` here would pull its own wide,
 * heavy import graph (`progress-board.mjs`, `pr-status.mjs`, `jury-core.mjs`, `rearm-review.mjs`, …) into a file
 * that (per this file's own header) deliberately stays lighter. The two floors move together by hand; a test in
 * each file pins its own copy so a drift between them fails loud rather than silently diverging. ONE CAP, ONE
 * POPULATION regardless of which code path is driving the round — {@link watchParkedPrConflicts}'s own
 * idle-conflict-bounce re-assertion (below) and `reconcile-core.mjs`'s `isConflictBounce` dispatch both bind on
 * this same number, so a PR can never get more mechanical conflict-resolution attempts by however many times its
 * ownership ping-pongs between the two passes (landing-freeze fix, web-everything/web-everything#2793, 2026-09-27).
 */
export const CONFLICT_FIX_ROUND_CAP = 3;

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#latestConflictFixMarkerCreatedAtMs — the MOST RECENT
 * completed mechanical conflict-fix round's own timestamp (`we:scripts/conveyor/conflict-fix-round-count.mjs
 * #CONFLICT_FIX_COMMENT_MARKER`, posted by `rearm-review.mjs --round=conflict` the moment a fix agent rearms a
 * `review:changes` bounce back to `review:pending`). PURE. Used ONLY as the idle-conflict-bounce episode
 * boundary (see that branch's own docblock in {@link watchParkedPrConflicts}) — mirrors
 * {@link latestConflictAlertCreatedAtMs}'s own shape exactly, over a different marker.
 * @param {Array<{body?:string, createdAt?:string, author?:{login?:string}}|string>|null|undefined} comments
 * @returns {?number}
 */
export function latestConflictFixMarkerCreatedAtMs(comments) {
  if (!Array.isArray(comments)) return null;
  let best = null;
  for (const c of comments) {
    const body = typeof c === 'string' ? c : c?.body;
    if (typeof body !== 'string' || !body.trimStart().startsWith(CONFLICT_FIX_COMMENT_MARKER) || !isTrustedMarkerAuthor(c)) continue;
    const ms = Date.parse((typeof c === 'string' ? null : c?.createdAt) ?? '');
    if (Number.isFinite(ms) && (best === null || ms > best)) best = ms;
  }
  return best;
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#REARM_DEFERRED_BOUND_MS — #xu38vlf (epic #4075/#3383): the
 * bound on how long a rearm can sit withheld on the name-based `deriveReviewStatus` liveness check (see
 * {@link watchParkedPrConflicts}'s `deferRearm` branch) before this file surfaces it to an operator rather than
 * silently deferring forever. Mirrors `we:scripts/conveyor/reconcile-core.mjs#LIVE_SESSION_OVERRUN_MS`'s own
 * value (90 minutes) and its exact reasoning — a name-based "is a fix session still live" read that stays true
 * this long is far more likely a STALE/misnamed agent-listing entry than a real 90-minute-long fix round — but
 * defined LOCALLY rather than imported: this file deliberately stays independent of `reconcile-core.mjs`'s own
 * (much heavier) transitive import graph, the same reasoning `deriveReviewStatus`'s own import comment already
 * gives for why THIS file's liveness check is a separate, name-based one to begin with.
 *
 * PAST THE BOUND, THIS FILE SURFACES — IT DOES NOT FORCE A REARM. Auto-rearming past the bound would race the
 * exact case #4118 finding (c) introduced this wait to avoid (a fix agent genuinely still mid-push) — the risk
 * this file's own comments already flag as unruled-out by a bare `mergeable` read. Surfacing an operator-visible
 * note is the safe direction: a human can then confirm the liveness read is stale (and clear it, e.g. via
 * `/finish`) or that the fixer really is still working — never a script guessing which.
 */
export const REARM_DEFERRED_BOUND_MS = 90 * 60 * 1000;

/** The fixed lead-in {@link REARM_DEFERRED_MARKER} always renders first — matched, never re-rendered, by
 *  {@link firstRearmDeferredCreatedAtMs}. */
export const REARM_DEFERRED_MARKER_RE = /^⏳ conveyor — rearm withheld, fix session appears live \(#xu38vlf\)/;

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#REARM_DEFERRED_MARKER — #xu38vlf: the durable, one-time
 * comment this file posts the FIRST sweep it observes `deferRearm` for the CURRENT conflict episode — its own
 * `createdAt`, read back by {@link firstRearmDeferredCreatedAtMs}, is the "since" this wait is bounded against.
 * Posted once per episode (like every other marker in this file); a later sweep that still finds `deferRearm`
 * true reads this same comment back instead of posting another one.
 */
export const REARM_DEFERRED_MARKER = '⏳ conveyor — rearm withheld, fix session appears live (#xu38vlf)';

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#firstRearmDeferredCreatedAtMs — the EARLIEST
 * {@link REARM_DEFERRED_MARKER} comment posted after `sinceMs` (the current conflict episode's own boundary —
 * the most recent {@link CONFLICT_ALERT_MARKER_RE} comment's `createdAt`, via
 * {@link latestConflictAlertCreatedAtMs}, so a FRESH conflict cycle always starts a fresh wait even if an old
 * marker from a prior episode is still sitting on the thread). PURE. Requires {@link isTrustedMarkerAuthor} for
 * the identical reason every other marker reader in this file does.
 * @param {Array<{body?:string, createdAt?:string, author?:{login?:string}, viewerDidAuthor?:boolean}|string>|null|undefined} comments
 * @param {number} sinceMs
 * @returns {?number}
 */
export function firstRearmDeferredCreatedAtMs(comments, sinceMs = -Infinity) {
  if (!Array.isArray(comments)) return null;
  let best = null;
  for (const c of comments) {
    const body = typeof c === 'string' ? c : c?.body;
    if (typeof body !== 'string' || !REARM_DEFERRED_MARKER_RE.test(body.trimStart()) || !isTrustedMarkerAuthor(c)) continue;
    const ms = Date.parse((typeof c === 'string' ? null : c?.createdAt) ?? '');
    if (Number.isFinite(ms) && ms > sinceMs && (best === null || ms < best)) best = ms;
  }
  return best;
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#hasRecentConflictFindingComment — the SAME crash-safety dedup
 * as {@link hasRecentConflictAlertComment}, over {@link buildConflictFindingBody}'s own fixed footer text
 * instead of the alert's header — a finding is posted by `reconcile-finding.mjs` through `defaultPostConflict
 * Finding`, not this file's own `provider.postComment`, so it carries THIS text on the thread, not the alert's.
 * PURE. #4118 review finding (security/authz) — ALSO requires {@link isTrustedMarkerAuthor}, for the identical
 * reason stated on {@link hasRecentConflictAlertComment}.
 * @param {Array<{body?:string, createdAt?:string, author?:{login?:string}, viewerDidAuthor?:boolean}|string>|null|undefined} comments
 * @param {{now?:number, windowMs?:number, sinceMs?:number}} [o]
 * @returns {boolean}
 */
export function hasRecentConflictFindingComment(comments, { now = Date.now(), windowMs = CONFLICT_RETRY_WINDOW_MS, sinceMs = -Infinity } = {}) {
  if (!Array.isArray(comments)) return false;
  for (const c of comments) {
    const body = typeof c === 'string' ? c : c?.body;
    if (typeof body !== 'string' || !body.includes('Auto-detected by the parked-PR conflict watch')
      || !body.includes('dispatched per `#xu2krte`') || !isTrustedMarkerAuthor(c)) continue;
    if (isInCurrentEpisode(c, { now, windowMs, sinceMs })) return true;
  }
  return false;
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#hasRecentConflictStandDownComment — #4118 round 2: the SAME
 * episode-scoped dedup as {@link hasRecentConflictFindingComment}, for the fresh-detection stand-down. Replaces
 * a bare `countStandDownComments(...) > 0`, which let ANY stand-down ever posted on the PR (a long-closed
 * episode's) silently suppress a new episode's stand-down. Trust rule and leading-line match come from
 * `stand-down.mjs#standDownComments`, never re-derived. PURE.
 * @param {Array<{body?:string, createdAt?:string, author?:{login?:string}}|string>|null|undefined} comments
 * @param {{now?:number, windowMs?:number, sinceMs?:number}} [o]
 * @returns {boolean}
 */
export function hasRecentConflictStandDownComment(comments, { now = Date.now(), windowMs = CONFLICT_RETRY_WINDOW_MS, sinceMs = -Infinity } = {}) {
  return standDownComments(comments).some((c) => isInCurrentEpisode(c, { now, windowMs, sinceMs }));
}

/**
 * The one-time alert comment posted on the transition to `newlyDetected`. PURE (a string builder — the actual
 * `gh pr comment` write is the IO shell's job).
 * @param {{num:number|string, headRefName?:string}} pr
 * @returns {string}
 */
export function buildConflictComment(pr, { isStatuteTier = false, deferredToDrain = false, appendOnlyStatute = false, reviewHumanFixable = false } = {}) {
  const ref = pr?.headRefName ? ` (\`${pr.headRefName}\`)` : '';
  // Precedence mirrors the IO shell's routing EXACTLY (PR #2531 review, extended by #xu2krte Fork 2): stand-down
  // (`isStatuteTier`) wins, then an append-only statute conflict, then the review-human statute-amendment
  // exception, then the queued drain grace, then an ordinary dispatch — dispatched AT ONCE, bypassing the
  // queued-PR drain grace, so neither exception can get the drain-grace wording. The watch never passes more
  // than one of `isStatuteTier`/`appendOnlyStatute`/`reviewHumanFixable` true at a time; if a caller does,
  // stand-down wins first, append-only next, so the comment can never claim two outcomes at once.
  const appendOnly = appendOnlyStatute && !isStatuteTier;
  const reviewHumanAmendment = reviewHumanFixable && !isStatuteTier && !appendOnly;
  const nextStep = isStatuteTier
    ? 'Left as a **judgment call for a human or `/finish`**, not auto-resolved: the conflicting hunk touches a ' +
      "declarative-leash/statute-tier file, so choosing which side's edit wins is drafting principle content, " +
      'not ordinary code — exactly the judgment this repo reserves for a person (`#xu2krte` Fork 2).'
    : appendOnly
    ? (deferredToDrain
        ? 'A fix agent is being dispatched now to resolve it (`#xu2krte`), with no drain grace period: the drain ' +
          'only auto-rebases a shared-manifest conflict, which this is not. The PR is bounced to `review:changes` ' +
          'and re-reviewed once resolved: the old approval does not cover the resolved diff.'
        : 'A fix agent is being dispatched now to resolve it (`#xu2krte`). The SAME independent-review gate this ' +
          'PR is already parked behind still applies before anything lands.')
    : reviewHumanAmendment
    ? 'A fix agent is being dispatched to resolve the CONFLICT ONLY (`#xu2krte` Fork 2): this PR already carries ' +
      '`review:human`, so a human reviews the final merged result regardless — `review:human` is never cleared ' +
      'or downgraded by the fix.'
    : deferredToDrain
    ? 'This PR is already approved/queued, so the drain gets the first try — it auto-rebases a PR whose only ' +
      `conflict is the shared manifest. If it is still conflicting in ${QUEUED_CONFLICT_GRACE_MS / 60000} minutes, ` +
      'it is bounced to `review:changes` for a fix agent to resolve, then re-reviewed: the old approval does not ' +
      'cover the resolved diff.'
    : 'A fix agent is being dispatched to resolve it (`#xu2krte`) — the SAME independent-review gate this PR ' +
      'is already parked behind still applies before anything lands; nobody is rewriting this content ' +
      'unreviewed. If it cannot be resolved safely, it stands down to a human instead of guessing.';
  // #3383-append-only-statute — this touches a statute file, but ONLY because both sides independently appended a
  // NEW `### ` section at the same spot; no existing rule text is in dispute. Said explicitly, beside `nextStep`
  // rather than folded into it, so a reader sees at a glance this is a MECHANICAL resolution with a re-review
  // still owed, not a silent downgrade of the statute-tier care this PR would otherwise get.
  const appendOnlyNote = appendOnly
    ? '\n\n**This is being resolved mechanically, not by a human judgment call.** Both sides only ADDED separate ' +
      'new rule sections at the same insertion point — nobody edited any existing rule text — so this is being ' +
      'handled as an append-only statute conflict (keep both sections) and will go through a fresh independent ' +
      'review once resolved, exactly like any other bounce.'
    : reviewHumanAmendment
    ? '\n\n**The conflict is being resolved mechanically; the amendment itself is not.** `main` did not ' +
      "independently change the SAME hunk this PR amends (verified by comparing diff hunks against the merge " +
      "base), so this is a git-proximity conflict, not a competing edit — the fixer resolves the conflict only, " +
      'makes no other change, and never touches a `review:*` label. A fresh independent review is still owed ' +
      'once resolved, exactly like any other bounce.'
    : '';
  return [
    `⚠️ **This ${deferredToDrain ? 'approved' : 'parked'} PR has drifted into a real merge conflict against \`main\`**`,
    '',
    `GitHub reports \`mergeable: CONFLICTING\` on this PR${ref} while it is ${deferredToDrain ? 'queued to land' : 'parked for review'} — it will not ` +
      'resolve on its own. One or more PRs merged to `main` since this one opened touched overlapping content.',
    '',
    nextStep + appendOnlyNote,
    '',
    '_Auto-detected by the parked-PR conflict watch (`we:scripts/conveyor/parked-pr-conflict-watch.mjs`, `#xw0odtv`). ' +
      `This will self-clear (the \`${CONFLICT_LABEL}\` label is removed, no further comment) once the conflict resolves._`,
  ].join('\n');
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#isStatuteTierConflict — Fork 2's (`#xu2krte`) content-based
 * exception: does ANY file this PR touches sit in the declarative-leash or statute tier
 * (`we:scripts/lib/review-escalation.mjs#isDeclarativeLeashPath` / `#isStatutePath` — the SAME predicates
 * `deriveCareLevel`'s own `humanRequired` derivation keys on)? PURE.
 *
 * A CONSERVATIVE, SAFE-DIRECTIONED APPROXIMATION of "the CONFLICTING hunk itself". Isolating the exact
 * overlapping region would need a real three-way merge of the PR's head against `main` (fetching a ref this
 * pass does not otherwise fetch, then a `git merge-tree`) — this reads the PR's WHOLE changed-file set instead
 * (`gh pr list --json files`, a plain `gh` read, no fetch/clone needed). That can occasionally route a PR to a
 * human over a leash/statute file present in the diff but not actually part of the conflicting region — the
 * OVER-cautious direction, never the unsafe one, and it never blocks the PR from a normal review; it only
 * withholds the agent-dispatch shortcut for THIS conflict.
 *
 * CALLER OWES A COMPLETE LIST — see `#xgfzlj1`. `gh pr list --json ...,files` resolves `files` over `gh`'s own
 * GraphQL query, which hardcodes `files(first: 100)` with no pagination (confirmed live against `gh` 2.95.0 /
 * `cli/cli@trunk`'s `api/query_builder.go`, and tracked upstream as a bug, not a documented cap — cli/cli
 * discussion #6930 / issue #5368). A PR touching ≥100 files gets a SILENTLY truncated `files` array with no
 * error — this function has no way to tell "100 files, complete" from "100 files, truncated" from the array
 * alone, so the caller ({@link watchParkedPrConflicts}) is the one that must re-fetch a verified-complete list
 * (`defaultListPrFiles`, paginated `gh api .../pulls/{n}/files`) before trusting a ≥100-length array here.
 * @param {Array<{path?:string}|string>} files - a COMPLETE changed-file list (verified, not gh's capped one).
 * @returns {boolean}
 */
export function isStatuteTierConflict(files) {
  return (Array.isArray(files) ? files : [])
    .map((f) => (typeof f === 'string' ? f : f?.path))
    .filter(Boolean)
    .some((p) => isDeclarativeLeashPath(p) || isStatutePath(p));
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#isAppendOnlyStatuteChange — the PURE classifier behind the
 * append-only statute exception (live 2026-09-23, PR #2505). A concurrent statute-tier PR conflicts with `main`
 * ONLY because both sides independently appended a NEW `### ` rule section at the same insertion point (the tail
 * of a `##` section, right before the next one) — nobody edited any EXISTING rule text. That is mechanically
 * resolvable (keep both sections); an edit that touches shared rule text is not, and must still stand down to a
 * human. Every concurrent statute PR collides this exact way, since they all append at the same spot (#2524 will
 * too) — this exists so that shape stops costing a human review each time.
 *
 * Given ONE file's unified-diff `patch` (the per-file field `gh api .../pulls/{n}/files` returns — a bare hunk
 * body, no `--- a/`/`+++ b/` file-header lines), returns true ONLY if:
 *   (a) the patch removes NOTHING — any `-`-prefixed line fails it outright, whatever it says;
 *   (b) EVERY contiguous run of `+`-prefixed lines, once blank lines and lone `---` separator lines are trimmed
 *       off its own top/bottom edge, BEGINS with a `### ` heading line — proving the run is a WHOLE inserted
 *       section, never a line spliced into an existing one's body;
 *   (c) the first non-blank UNCHANGED (context) line following each such run — if the hunk has one at all — is
 *       itself a `---`, a `### ` or a `## ` line, proving the insertion point is a real section BOUNDARY, not the
 *       middle of a rule.
 * Anything the parser cannot make sense of (not a string, no hunk header at all, a run that trims to nothing) reads
 * as false — the safe direction: false only ever costs the stand-down that was already today's behaviour.
 * @param {string} patch
 * @returns {boolean}
 */
export function isAppendOnlyStatuteChange(patch) {
  if (typeof patch !== 'string' || patch === '') return false;
  const lines = patch.split('\n');
  if (!lines.some((l) => l.startsWith('@@'))) return false; // no hunk at all — unparseable
  if (lines.some((l) => l.startsWith('-'))) return false; // (a) — any removal fails it outright, full stop

  const isBlankOrRule = (s) => { const t = s.trim(); return t === '' || t === '---'; };

  // Split into hunks so "the next context line" can never cross a `@@` boundary into an unrelated hunk.
  const hunks = [];
  let hunkStart = -1;
  lines.forEach((l, i) => {
    if (l.startsWith('@@')) { if (hunkStart !== -1) hunks.push(lines.slice(hunkStart, i)); hunkStart = i; }
  });
  if (hunkStart !== -1) hunks.push(lines.slice(hunkStart));

  let sawAnyRun = false;
  for (const hunk of hunks) {
    let i = 1; // index 0 is the `@@ … @@` header line itself
    while (i < hunk.length) {
      if (!hunk[i].startsWith('+')) { i += 1; continue; }
      const runStart = i;
      while (i < hunk.length && hunk[i].startsWith('+')) i += 1;
      const runEnd = i; // exclusive
      sawAnyRun = true;

      const content = hunk.slice(runStart, runEnd).map((l) => l.slice(1));
      let lo = 0;
      let hi = content.length;
      while (lo < hi && isBlankOrRule(content[lo])) lo += 1;
      while (hi > lo && isBlankOrRule(content[hi - 1])) hi -= 1;
      if (lo >= hi) return false; // (b) — trims to nothing, no heading in this run at all
      if (!content[lo].startsWith('### ')) return false; // (b) — not a whole-section insert

      // (c) — the first non-blank CONTEXT line after the run, within this same hunk. A `\ No newline…` meta line
      // is skipped without counting; no other line kind can occur here (a `+`-run is maximal by construction and
      // removals were already ruled out above), so hitting anything else just means "no context line follows".
      let j = runEnd;
      let nextContext = null;
      while (j < hunk.length) {
        const l = hunk[j];
        if (l.startsWith('\\')) { j += 1; continue; }
        if (l.startsWith(' ')) {
          const c = l.slice(1);
          if (c.trim() !== '') { nextContext = c; break; }
          j += 1; continue;
        }
        break;
      }
      if (nextContext != null) {
        const t = nextContext.trim();
        if (!(t === '---' || nextContext.startsWith('### ') || nextContext.startsWith('## '))) return false;
      }
    }
  }
  return sawAnyRun;
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#isAppendOnlyStatuteConflict — lifts
 * {@link isAppendOnlyStatuteChange} from "one file's patch" to "this conflict's whole statute-tier file set".
 * PURE — `patchesByFile` is supplied by the caller (the IO shell fetches it via {@link defaultListPrPatches}).
 *
 * Dispatchable ONLY when EVERY statute-tier file in the conflict is BOTH a statute-path `.md` file (never a
 * declarative-leash file — those are code/contracts with no such thing as an append-only edit) AND its own patch
 * is append-only. A missing/non-string patch entry reads as a fetch failure for THAT file and fails the whole
 * conflict closed — the safe direction, matching {@link isAppendOnlyStatuteChange}'s own contract.
 * @param {string[]} statuteTierFiles - the subset of the conflict's file list that is statute-tier (leash or
 *   statute path) — the same predicate {@link isStatuteTierConflict} already applies.
 * @param {Record<string,string>} patchesByFile - path → that file's unified-diff patch text.
 * @returns {boolean}
 */
export function isAppendOnlyStatuteConflict(statuteTierFiles, patchesByFile) {
  const files = Array.isArray(statuteTierFiles) ? statuteTierFiles : [];
  if (files.length === 0) return false;
  const patches = patchesByFile && typeof patchesByFile === 'object' ? patchesByFile : {};
  return files.every((p) => {
    if (isDeclarativeLeashPath(p)) return false; // leash files are never append-only-eligible
    if (!isStatutePath(p) || !String(p).toLowerCase().endsWith('.md')) return false;
    const patch = patches[p];
    return typeof patch === 'string' && isAppendOnlyStatuteChange(patch);
  });
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#parseHunkOldRanges — parse a unified-diff patch's `@@ -a,b
 * +c,d @@` hunk headers into the OLD-file line ranges they cover, `[start, end)` (half-open, so a length-0 hunk —
 * a pure insertion, `,0`/omitted length at that point — still yields an empty-but-valid `[start, start)` range).
 * Both {@link isAppendOnlyStatuteChange}'s own patch (the PR's hunks against the merge base) and a comparison
 * patch for `main`'s own changes since that SAME merge base describe positions in the SAME original file, so
 * their old-file ranges are directly comparable — the basis {@link doesConflictOverlapMainEdits} compares on.
 * PURE.
 * @param {string} patch
 * @returns {Array<[number, number]>}
 */
export function parseHunkOldRanges(patch) {
  if (typeof patch !== 'string') return [];
  const ranges = [];
  for (const line of patch.split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))?/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const len = m[2] !== undefined ? Number(m[2]) : 1;
    ranges.push([start, start + len]);
  }
  return ranges;
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#hunkRangesOverlap — do any two `[start, end)` ranges from the
 * two given lists intersect? PURE, O(n·m) — both lists are always "one small statute file's hunk count", never
 * large enough for this to matter.
 * @param {Array<[number, number]>} rangesA
 * @param {Array<[number, number]>} rangesB
 * @returns {boolean}
 */
export function hunkRangesOverlap(rangesA, rangesB) {
  const a = Array.isArray(rangesA) ? rangesA : [];
  const b = Array.isArray(rangesB) ? rangesB : [];
  for (const [aStart, aEnd] of a) {
    for (const [bStart, bEnd] of b) {
      if (aStart < bEnd && bStart < aEnd) return true;
    }
  }
  return false;
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#doesConflictOverlapMainEdits — the TRUE semantic-clash test
 * behind the `review:human` statute-amendment exception (`#xu2krte` Fork 2). A non-append-only statute-tier
 * conflict is safe to hand a fixer ONLY when `main` never independently touched the SAME hunk region of the SAME
 * file since the merge base — i.e. the git-level conflict is a PROXIMITY artifact (the two diffs sit close enough
 * that git refuses to auto-merge them), not two sides genuinely competing over the same rule text. When they DO
 * overlap, resolving it means choosing which side's edit wins — exactly the judgment this repo reserves for a
 * person, unchanged from today.
 *
 * FAILS CLOSED in every ambiguous direction. Only a file with NO KEY in `mainPatchesByFile` counts as "main never
 * touched it" and is skipped. A file that IS keyed there is a real main edit, so it must be readable to be cleared:
 *   - main's patch is empty or not a string — GitHub's compare API omits `.patch` for a binary file or a diff too
 *     large to render, and the fetcher's `.patch // ""` turns that into `''` (PR #2577 review finding 2);
 *   - main's patch, or the PR's own patch, carries no parseable `@@` hunk header (nothing to compare);
 *   - the PR's own patch is missing or empty.
 * Each of those is treated as an overlap (stand down) rather than silently cleared.
 * @param {string[]} statuteTierFiles
 * @param {Record<string,string>} prPatchesByFile - this PR's own per-file patch (against the merge base).
 * @param {Record<string,string>} mainPatchesByFile - `main`'s own per-file patch SINCE THE SAME merge base.
 * @returns {boolean} true = a true semantic clash (stand down); false = safe to dispatch mechanically.
 */
export function doesConflictOverlapMainEdits(statuteTierFiles, prPatchesByFile, mainPatchesByFile) {
  const files = Array.isArray(statuteTierFiles) ? statuteTierFiles : [];
  const prPatches = prPatchesByFile && typeof prPatchesByFile === 'object' ? prPatchesByFile : {};
  const mainPatches = mainPatchesByFile && typeof mainPatchesByFile === 'object' ? mainPatchesByFile : {};
  for (const path of files) {
    if (!Object.prototype.hasOwnProperty.call(mainPatches, path)) continue; // main never independently touched this file
    const mainRanges = parseHunkOldRanges(mainPatches[path]);
    if (mainRanges.length === 0) return true; // main changed it but we cannot see how — fail closed
    const prRanges = parseHunkOldRanges(prPatches[path]);
    if (prRanges.length === 0) return true; // no readable PR patch to compare — fail closed
    if (hunkRangesOverlap(prRanges, mainRanges)) return true;
  }
  return false;
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#findWatcherStandDownComment — does this PR's comment thread
 * already carry a stand-down THIS WATCH ITSELF posted (`we:scripts/conveyor/stand-down.mjs#WATCHER_STAND_DOWN_
 * ACTOR`), as opposed to a fix agent's own judgment stand-down or a human's `/finish` one? PURE. Narrowly keyed
 * on the actor string {@link defaultPostConflictStandDown} always posts with — never guesses from context.
 * @param {Array<{body?:string}|string>|null|undefined} comments
 * @returns {?{body:string, createdAt:?string}}
 */
export function findWatcherStandDownComment(comments) {
  return standDownComments(comments).find((c) => c.body.includes(WATCHER_STAND_DOWN_ACTOR)) ?? null;
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#isWatcherStandDownOperatorAnswered — has the operator
 * recorded a stand-down ANSWER (`we:scripts/conveyor/stand-down-answer-core.mjs`, marker
 * `conveyor-stand-down-answer:v1`) for the LATEST watcher stand-down on this thread? PURE. The answer is
 * authenticated by `parseOperatorAnswer` (operator/automation login + a re-built body that must match exactly)
 * and must name that stand-down's own comment id, so a stale answer to an older stand-down never lifts a newer
 * one. A later operator answer lifts the stand-down for that episode: the watch re-derived "still a judgment
 * call" every sweep and never looked at it (live: web-everything/web-everything#3771, 2026-10-03).
 * @param {Array<object>|null|undefined} comments
 * @returns {boolean}
 */
export function isWatcherStandDownOperatorAnswered(comments) {
  if (!Array.isArray(comments)) return false;
  let last = -1;
  for (let i = 0; i < comments.length; i += 1) {
    const c = comments[i];
    const body = typeof c === 'string' ? c : c?.body;
    if (typeof body === 'string' && body.trimStart().startsWith(STAND_DOWN_MARKER)
      && body.includes(WATCHER_STAND_DOWN_ACTOR)) last = i;
  }
  return last !== -1 && operatorAnswerForStandDown(comments, last) !== null;
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#isWatcherMarkerAlreadySuperseded — has a supersede comment
 * ({@link SUPERSEDE_STAND_DOWN_MARKER}) already been posted AFTER the latest watcher stand-down on this thread?
 * PURE. The re-check's idempotency read: without it every sweep re-posted the supersede comment and a fresh
 * `review:changes` finding (live on web-everything/web-everything#2549, 2026-09-24, one pair every ~2 minutes).
 *
 * Body-only on purpose. This read only ever SUPPRESSES a re-dispatch, so a forged supersede comment can do no
 * worse than leave the PR stood down (the safe direction). The dispatch gate that could be unblocked by a forgery
 * (`we:scripts/conveyor/stand-down.mjs#isStandDownSuperseded`) checks authorship too.
 * @param {Array<{body?:string}|string>|null|undefined} comments
 * @returns {boolean}
 */
export function isWatcherMarkerAlreadySuperseded(comments) {
  if (!Array.isArray(comments)) return false;
  const bodyAt = (i) => { const c = comments[i]; return typeof c === 'string' ? c : c?.body; };
  let lastMarker = -1;
  for (let i = 0; i < comments.length; i += 1) {
    const body = bodyAt(i);
    if (typeof body === 'string' && body.trimStart().startsWith(STAND_DOWN_MARKER)
      && body.includes(WATCHER_STAND_DOWN_ACTOR)) lastMarker = i;
  }
  if (lastMarker === -1) return false;
  for (let j = lastMarker + 1; j < comments.length; j += 1) {
    const body = bodyAt(j);
    if (typeof body === 'string' && body.trimStart().startsWith(SUPERSEDE_STAND_DOWN_MARKER)) return true;
  }
  return false;
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#buildSupersedeStandDownComment — posted (best-effort, never
 * blocking the dispatch that follows it) when a re-check finds the WATCH'S OWN prior stand-down no longer holds
 * under the narrower `#xu2krte` Fork 2 rule. Explains the earlier marker is now stale rather than silently
 * leaving two contradictory comments on the thread with no link between them. Says plainly that the marker
 * itself could not be safely deleted (no sanctioned comment-delete primitive exists yet — see the follow-up
 * card) rather than pretending it is gone. PURE.
 * @param {{num?:number|string}} [pr]
 * @returns {string}
 */
export function buildSupersedeStandDownComment(pr) {
  return [
    SUPERSEDE_STAND_DOWN_MARKER,
    '',
    'An earlier sweep of the parked-PR conflict watch stood this PR down because its statute-tier conflict was ' +
      'not append-only. Under the narrower `#xu2krte` Fork 2 rule, a `review:human` PR (a human reviews the ' +
      'result regardless) whose conflicting statute hunk does NOT overlap what `main` independently changed since ' +
      'the merge base is now routed to a fix agent instead: `review:human` is never cleared or downgraded, and a ' +
      'human still reviews the final merged result through the normal review flow before it can land.',
    '',
    '_The earlier stand-down comment above is now stale. This pass could not safely delete it — no sanctioned ' +
      'comment-delete primitive exists yet (tracked as a follow-up) — so it is being explicitly superseded here ' +
      'instead of silently left to contradict this one._',
  ].join('\n');
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#defaultPostSupersedeComment — the IO shell for
 * {@link buildSupersedeStandDownComment}. Uses the SAME injected `provider.postComment` every other comment in
 * this file posts through — no new `gh` call site.
 * @param {{pr:object, repo:string|null, provider:object}} o
 */
export function defaultPostSupersedeComment({ pr, repo, provider }) {
  provider.postComment(repo, pr?.number, buildSupersedeStandDownComment(pr));
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#defaultListMainStatutePatchesSinceMergeBase — the fetch
 * {@link doesConflictOverlapMainEdits} needs: `main`'s own per-file patch, since the SAME merge base the PR's own
 * `listPrPatches` patch is computed against, keyed by filename. Two plain `gh api` reads, no local git clone/fetch
 * needed (mirrors this file's existing "gh only" IO-shell discipline):
 *   1. `pulls/{n}` → this PR's base ref name and head sha.
 *   2. `compare/{base}...{headSha}` → `.merge_base_commit.sha`, the REAL three-way merge base (not just the base
 *      branch's tip at PR-open time).
 *   3. `compare/{mergeBaseSha}...{base}` → every file `main` changed since that merge base, with its own patch —
 *      exactly "what main did independently", the SAME `@tsv`-projected, {@link unescapeTsvField}-decoded shape
 *      {@link defaultListPrPatches} already uses for the PR's own side.
 * Deliberately only called for the narrow population that can actually change an outcome ({@link
 * classifyStatuteConflict}'s own gating) — the common non-statute, non-`review:human` tick never pays for this.
 * THROWS on any resolution failure (an empty base ref/head sha, an empty merge-base sha, or a failed `gh` call) —
 * never returns an empty map on failure, so the caller's fail-closed `catch` (stand down, the safe direction)
 * actually fires instead of silently reading "main touched nothing" from a call that never really answered.
 * @param {{number:number|string, repo?:string|null, exec?:Function}} o
 * @returns {Record<string,string>} filename → main's own patch text since the merge base (possibly `""`)
 */
export function defaultListMainStatutePatchesSinceMergeBase({ number, repo, exec = execFileSyncThrottled }) {
  const viewPath = repo ? `repos/${repo}/pulls/${number}` : `repos/{owner}/{repo}/pulls/${number}`;
  const viewOut = exec('gh', ['api', '--method', 'GET', viewPath, '--jq', '[.base.ref, .head.sha] | @tsv'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
  const [baseRef, headSha] = String(viewOut || '').trim().split('\t');
  if (!baseRef || !headSha) throw new Error(`could not resolve base/head for PR #${number}`);

  const cmpHeadPath = repo ? `repos/${repo}/compare/${baseRef}...${headSha}` : `repos/{owner}/{repo}/compare/${baseRef}...${headSha}`;
  const mbOut = exec('gh', ['api', '--method', 'GET', cmpHeadPath, '--jq', '.merge_base_commit.sha // ""'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
  const mergeBaseSha = String(mbOut || '').trim();
  if (!mergeBaseSha) throw new Error(`could not resolve a merge base for PR #${number}`);

  const cmpMainPath = repo ? `repos/${repo}/compare/${mergeBaseSha}...${baseRef}` : `repos/{owner}/{repo}/compare/${mergeBaseSha}...${baseRef}`;
  const filesOut = exec('gh', ['api', '--method', 'GET', cmpMainPath, '--jq', '.files[]? | [.filename, (.patch // "")] | @tsv'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
  const patches = {};
  let rows = 0;
  for (const line of String(filesOut || '').split('\n')) {
    if (line === '') continue;
    const tab = line.indexOf('\t');
    if (tab === -1) throw new Error(`unreadable compare row for PR #${number}`); // never drop a main-touched file
    rows += 1;
    // An omitted `.patch` stays an EMPTY-STRING entry: the key alone says "main touched this file", and
    // {@link doesConflictOverlapMainEdits} fails closed on a keyed file it cannot read.
    patches[unescapeTsvField(line.slice(0, tab))] = unescapeTsvField(line.slice(tab + 1));
  }
  // The compare API lists at most COMPARE_FILES_CAP files and silently drops the rest, so a full list may be
  // missing a file main really touched — which would read as "untouched". Treat it as a failed read.
  if (rows >= COMPARE_FILES_CAP) throw new Error(`main's comparison for PR #${number} hit the ${COMPARE_FILES_CAP}-file compare cap`);
  return patches;
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#COMPARE_FILES_CAP — GitHub's REST `compare` endpoint returns
 * at most this many changed files, with no pagination of `.files` and no truncation flag. A list this long is
 * indistinguishable from a truncated one (the same reasoning as {@link GH_FILES_GRAPHQL_CAP}).
 */
export const COMPARE_FILES_CAP = 300;

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#GH_FILES_GRAPHQL_CAP — `#xgfzlj1`. The exact, confirmed
 * hard cap `gh`'s own `files(first: 100)` GraphQL query imposes on `--json files` (`gh pr list`/`gh pr view`),
 * with NO pagination and NO truncation signal — a PR with exactly this many or more changed files returns an
 * array capped at this length regardless of the real count. A returned `files` array whose length is `<` this
 * cap is therefore PROVABLY complete (gh would have returned every file); a length `>=` this cap is
 * INDISTINGUISHABLE from truncation and must not be trusted for a safety decision.
 */
export const GH_FILES_GRAPHQL_CAP = 100;

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#defaultListPrFiles — `#xgfzlj1`'s verified-complete fallback:
 * a FULLY PAGINATED read of the REST `pulls/{number}/files` endpoint (`gh api ... --paginate`), which follows
 * every page via the response `Link` header rather than `gh`'s own single-shot, 100-capped GraphQL `files`
 * field. Only called when {@link watchParkedPrConflicts} suspects the cheap `gh pr list --json files` read may
 * be truncated (its length hit {@link GH_FILES_GRAPHQL_CAP}) — the common small-PR tick never pays for it.
 *
 * `--method GET` IS LOAD-BEARING, not decoration. `gh api`'s documented default method is `GET`, UNLESS the
 * invocation ALSO passes an `-f`/`-F` parameter, in which case `gh` silently switches to `POST` — and
 * `pulls/{n}/files` has no `POST` handler, so the call fails `404 Not Found` on EVERY invocation, paginated or
 * not. Confirmed live 2026-09-23 against real PR #2514: `gh api --paginate -F per_page=100
 * repos/.../pulls/2514/files` returns `404`; adding `--method GET` (unchanged otherwise) returns the file list.
 * Because {@link watchParkedPrConflicts}'s queued-grace path reads a `listPrFiles` failure as "assume
 * statute-tier, stand down" (the safe direction), this silently meant NO approved/queued conflicting PR had EVER
 * actually been bounced past its `#2412` GRAPHQL-cap check — #2503/#2514/#2515 sat well past
 * {@link QUEUED_CONFLICT_GRACE_MS} with the grace path quietly refusing every one of them.
 * @param {{number:number|string, repo?:string|null, exec?:Function}} o
 * @returns {string[]} every changed file's path, real pagination applied — no cap.
 */
export function defaultListPrFiles({ number, repo, exec = execFileSyncThrottled }) {
  const path = repo ? `repos/${repo}/pulls/${number}/files` : `repos/{owner}/{repo}/pulls/${number}/files`;
  const argv = ['api', '--paginate', '--method', 'GET', '-F', 'per_page=100', path, '--jq', '.[].filename'];
  // #x5n4zn3 — was bare (no timeout).
  const out = exec('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
  return String(out || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Undo jq's `@tsv` per-field escaping (`\\`, `\t`, `\n`, `\r`) — the inverse of what {@link defaultListPrPatches}'s
 *  own jq filter applies to reconstitute a multi-line patch onto one output line. */
function unescapeTsvField(s) {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const n = s[i + 1];
      if (n === 'n') { out += '\n'; i += 1; continue; }
      if (n === 't') { out += '\t'; i += 1; continue; }
      if (n === 'r') { out += '\r'; i += 1; continue; }
      if (n === '\\') { out += '\\'; i += 1; continue; }
    }
    out += s[i];
  }
  return out;
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#defaultListPrPatches — the fetch {@link isAppendOnlyStatuteConflict}
 * needs: a COMPLETE, injectable read of every changed file's own unified-diff `patch` text, keyed by filename.
 * Paginated REST (`pulls/{number}/files`), mirroring {@link defaultListPrFiles}'s own shape/cap concerns exactly
 * — same endpoint, same `-F per_page=100` + `--paginate`, no `gh pr view`/`gh pr list` 100-file GraphQL cap here.
 *
 * PROJECTS VIA `@tsv`, NOT `tojson`/a bare JSON object per line — a `patch` legitimately spans many source lines,
 * and jq's default (non-`-c`) object rendering is pretty-printed across MULTIPLE output lines, which would break
 * any "one record per line" reader silently. `@tsv` escapes each field's own newlines/tabs/backslashes to a
 * literal `\n`/`\t`/`\\` so one file's whole patch always reaches this process as ONE line; {@link unescapeTsvField}
 * undoes that escaping to recover the real multi-line patch text `isAppendOnlyStatuteChange` expects.
 *
 * A file with no `patch` (binary, a pure rename, or one whose diff GitHub declined to compute) projects `.patch`
 * as `null` — mapped to `""` before `@tsv` (which cannot render `null`) so it still reads as ONE empty field
 * rather than corrupting the row; the caller/classifier already treats a non-append/empty patch as ineligible.
 * @param {{number:number|string, repo?:string|null, exec?:Function}} o
 * @returns {Record<string,string>} filename → that file's own patch text (possibly `""`)
 */
export function defaultListPrPatches({ number, repo, exec = execFileSyncThrottled }) {
  const path = repo ? `repos/${repo}/pulls/${number}/files` : `repos/{owner}/{repo}/pulls/${number}/files`;
  // `--method GET` is required whenever `-F`/`-f` is present — see {@link defaultListPrFiles}'s docblock for the
  // confirmed-live 404-on-POST failure this avoids.
  const argv = ['api', '--paginate', '--method', 'GET', '-F', 'per_page=100', path, '--jq', '.[] | [.filename, (.patch // "")] | @tsv'];
  // #x5n4zn3 — was bare (no timeout).
  const out = exec('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
  const patches = {};
  for (const line of String(out || '').split('\n')) {
    if (line === '') continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const filename = unescapeTsvField(line.slice(0, tab));
    patches[filename] = unescapeTsvField(line.slice(tab + 1));
  }
  return patches;
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#defaultListPrComments — `#3383`'s idempotency read for the
 * grace-expired stand-down routing: a COMPLETE, injectable read of every issue comment on the PR, so
 * {@link standDownComments} (`we:scripts/conveyor/stand-down.mjs`) can tell "did a fixer already stand down
 * here" from the PR itself before posting a SECOND one. Unlike the fresh-detection stand-down (naturally
 * one-shot: it only fires on the label's absent→present transition), the grace-expired check re-evaluates on
 * EVERY sweep for as long as the PR stays queued+conflicting+labelled — a stand-down leaves no label change
 * (`we:scripts/conveyor/stand-down.mjs`'s own contract), so without this read it would re-post every tick.
 *
 * Same paginated-REST shape as {@link defaultListPrPatches} (`issues/{number}/comments`, not `pulls/{n}/files` —
 * comments live on the issue side of a PR) and the same `@tsv`-then-{@link unescapeTsvField} round trip, for the
 * same reason: a comment body legitimately spans many lines, and jq's default per-line JSON rendering would
 * break a "one record per line" reader.
 * `.created_at` (#4118) is projected alongside `.body` — {@link hasRecentConflictAlertComment} /
 * {@link hasRecentConflictFindingComment} / {@link latestConflictAlertCreatedAtMs} need a comment's own
 * timestamp to tell a still-in-progress crash-retry from a past, already-resolved episode's leftover marker.
 * `.user.login` (also #4118, review finding security/authz) is projected too, reshaped to the `author: {login}`
 * field {@link isTrustedMarkerAuthor}/`we:scripts/lib/marker-authorship.mjs` reads on every OTHER marker counter
 * in this repo — the REST issue-comments endpoint this function calls names the poster `.user.login`, not
 * `.author.login` (that is the GraphQL `gh pr view --json comments` shape's own naming, used by this file's
 * siblings) — so callers see the ONE shape `isTrustedMarkerAuthor` already expects either way. This was NOT
 * purely additive the way `.created_at` was: `standDownComments` (`we:scripts/conveyor/stand-down.mjs`),
 * already read on this function's own output at both this file's `graceDue` stand-down check and the
 * newly-detected `standDown` path, itself requires `isTrustedMarkerAuthor` (#3383) — with no `author` field to
 * read, EVERY comment this function returned failed that check, so `alreadyStoodDown`/the fresh-path stand-down
 * dedup silently never matched a real stand-down at all. Adding `.user.login` here fixes that latent gap too,
 * not only the three #4118 marker readers it was added for.
 * @param {{number:number|string, repo?:string|null, exec?:Function}} o
 * @returns {Array<{body:string, createdAt:?string, author:?{login:string}}>}
 */
export function defaultListPrComments({ number, repo, exec = execFileSyncThrottled }) {
  const path = repo ? `repos/${repo}/issues/${number}/comments` : `repos/{owner}/{repo}/issues/${number}/comments`;
  const argv = ['api', '--paginate', '--method', 'GET', '-F', 'per_page=100', path, '--jq', '.[] | [.body, .created_at, .user.login, .node_id] | @tsv'];
  // #x5n4zn3 — was bare (no timeout).
  const out = exec('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
  return String(out || '').split('\n').filter((l) => l !== '').map((line) => {
    const tab1 = line.indexOf('\t');
    if (tab1 === -1) return { body: unescapeTsvField(line), createdAt: null, author: null };
    const rest = line.slice(tab1 + 1);
    const tab2 = rest.indexOf('\t');
    const createdAtRaw = tab2 === -1 ? rest : rest.slice(0, tab2);
    const afterCreated = tab2 === -1 ? '' : rest.slice(tab2 + 1);
    const tab3 = afterCreated.indexOf('\t');
    const loginRaw = tab3 === -1 ? afterCreated : afterCreated.slice(0, tab3);
    // The GraphQL node id (`IC_kwDO…`) — the id an operator stand-down answer names in `Supersedes stand-down
    // comment \`<id>\``. Without it the answer can never be matched to the stand-down it resolves.
    const idRaw = tab3 === -1 ? '' : afterCreated.slice(tab3 + 1);
    const login = unescapeTsvField(loginRaw) || null;
    const id = unescapeTsvField(idRaw) || null;
    return {
      body: unescapeTsvField(line.slice(0, tab1)),
      createdAt: unescapeTsvField(createdAtRaw) || null,
      author: login ? { login } : null,
      ...(id ? { id } : {}),
    };
  });
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#buildConflictFindingBody — the write-up handed to
 * `we:scripts/conveyor/reconcile-finding.mjs --body-file=` for a DISPATCHABLE (non-statute-tier) fresh
 * conflict (Fork 4). PURE.
 *
 * Says plainly what an ordinary reconcile-finding does not have to: there is no separate reviewer comment to
 * read here — resolving the conflict IS the whole task this bounce exists for.
 * @param {{num:number|string, headRefName?:string}} pr
 * @returns {string}
 */
export function buildConflictFindingBody(pr, { appendOnlyStatute = false, reviewHumanFixable = false, resync = false } = {}) {
  const ref = pr?.headRefName ? ` (\`${pr.headRefName}\`)` : '';
  // #3383-append-only-statute — an EXPLICIT, narrower instruction for the one case this file's classifier proves
  // mechanical: both sides only ADDED a new `### ` section at the same spot in a statute doc. Stated as its own
  // paragraph, ahead of the generic "read both sides' intent" instruction, so a fixer never has to re-derive from
  // the raw conflict markers that no existing rule text is actually in dispute here.
  const appendOnlyInstruction = appendOnlyStatute
    ? [
      '',
      "**Append-only statute conflict: resolve by keeping `main`'s version of the file unchanged and " +
        "re-inserting this PR's new `###` section(s), in the same place relative to the neighbouring sections, " +
        "after `main`'s new ones. Change no existing rule text.**",
    ]
    : [];
  // #xu2krte Fork 2 (review-human statute amendment) — this PR already carries `review:human`: a human reviews
  // the FINAL merged result regardless, so resolving the git-level conflict mechanically does not skip that
  // ceremony. Stated as its own explicit instruction (mirrors the append-only case above) so a fixer never has
  // to guess it is allowed to touch a statute file here, or forgets the scope boundary.
  const reviewHumanInstruction = reviewHumanFixable
    ? [
      '',
      '**Review-human statute amendment: resolve the CONFLICT ONLY.** `main` did not independently touch the ' +
        "same hunk this PR amends — verified by comparing diff hunks, not guessed — so keep this PR's own " +
        "intended amendment and reconcile it against whatever ELSE `main` added nearby. Make NO other edits " +
        'beyond resolving this conflict, and do **not** touch any `review:*` label — `review:human` stays; a ' +
        'human still reviews the final merged result before it can land. **Post a comment showing the ' +
        'conflicting hunk BEFORE your resolution and the resolved hunk AFTER** as before/after evidence of what ' +
        'you changed.',
    ]
    : [];
  if (resync) {
    return [
      `PR #${pr?.num ?? pr?.number ?? '?'}${ref} is behind \`main\`: GitHub reports \`mergeable: CONFLICTING\`, ` +
        'but `git merge-tree` finds NO conflict against current `main`. This is the WHOLE finding.',
      '',
      '**Re-sync with `main` — nothing to resolve.** Merge `main` into this branch (no rebase, no force-push), ' +
        'push it, and let GitHub recompute mergeability and run CI on the new head. If the merge unexpectedly ' +
        'conflicts, resolve only that conflict. Make no other edits and touch no `review:*` label.',
      '',
      '_Auto-detected by the parked-PR conflict watch (`we:scripts/conveyor/parked-pr-conflict-watch.mjs`)._',
    ].join('\n');
  }
  return [
    `PR #${pr?.num ?? pr?.number ?? '?'}${ref} has drifted into a real GIT merge conflict against \`main\` — ` +
      "GitHub reports `mergeable: CONFLICTING`. This is the WHOLE finding; there is no separate reviewer comment " +
      'to read on this PR for it.',
    '',
    '**Resolving the conflict IS the task.** Rebase or merge `main` into this branch, resolve every conflicted ' +
      "hunk by reading BOTH sides' intent (this diff's own and whatever landed on `main` since), push the " +
      'resolution, and let the normal fix-agent flow (this bounce) carry it back to independent review.',
    ...appendOnlyInstruction,
    ...reviewHumanInstruction,
    '',
    '_Auto-detected by the parked-PR conflict watch (`we:scripts/conveyor/parked-pr-conflict-watch.mjs`, ' +
      '`#xw0odtv`), dispatched per `#xu2krte`._',
  ].join('\n');
}

// ── IO SHELL (gh only past this point — the CLI, gated on the main-module check) ───────────────────────────

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#narrowToConflictingFiles — #xconflres1 review round 1. Narrow
 * the PR's changed-file list to the git-level conflict paths ONLY when EVERY conflict path matches a changed
 * file's plain path exactly; otherwise return `files` unchanged (the whole-diff check, the safe direction). PURE.
 *
 * `git merge-tree` does not always name a path the way GitHub's `.filename` does: it C-quotes a path with a
 * non-ASCII byte, a backslash, a `"` or a control byte (`"dir/w\303\253ird.md"`), and a rename conflict can be
 * reported under the OLD path while GitHub lists only the NEW one. Before this, an unmatched conflict path was
 * silently dropped, so a statute-tier conflict under such a name narrowed to `[]` and was routed to a fixer
 * instead of a human. Any unmatched path now means "narrowing failed", exactly like a null/empty probe result.
 * @param {Array<{path?:string}|string>} files
 * @param {?string[]} conflictingPaths
 * @returns {Array<{path?:string}|string>}
 */
export function narrowToConflictingFiles(files, conflictingPaths) {
  if (!Array.isArray(conflictingPaths) || conflictingPaths.length === 0 || !Array.isArray(files)) return files;
  const pathOf = (f) => (typeof f === 'string' ? f : f?.path);
  const changed = new Set(files.map(pathOf));
  if (!conflictingPaths.every((p) => changed.has(p))) return files;
  return files.filter((f) => conflictingPaths.includes(pathOf(f)));
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#classifyStatuteConflict — the ONE place BOTH the
 * fresh-detection routing and the grace-expired routing decide "does this conflict touch a statute-tier file
 * at all, and if so is it ENTIRELY append-only". Factored out at `#3383` — the grace path used to skip this
 * classification altogether, on the false assumption ("a statute-tier conflict was already handed to a human at
 * detection") that does not hold for a QUEUED PR: the fresh path defers a NON-statute-tier queued conflict to
 * the drain (`routedTo: 'deferred-to-drain'`), never to a human, so a conflict that only becomes recognizably
 * statute-tier by the time grace expires reaches this exact code path for the FIRST time. Sharing one function
 * means the two call sites can never compute this differently again.
 *
 * `files` MUST already be the verified-complete list ({@link defaultListPrFiles}'s pagination, never the
 * possibly gh-capped `pr.files`) — the caller owns that check ({@link GH_FILES_GRAPHQL_CAP}); this trusts what
 * it is given.
 *
 * #xconflres1 — `conflictingPaths`, when given as a NON-EMPTY array ({@link defaultConflictingFilePaths}'s own
 * output), narrows `files` down to ONLY the paths actually in the same-line git conflict BEFORE ever computing
 * `isStatuteTierConflict` — the precise alternative to reading the PR's whole changed-file set (see that
 * function's own docblock for the live incident, `web-everything/web-everything#2772`, this closes). `null`/`undefined`/
 * an EMPTY array (the probe could not tell, or found no parseable conflict path), or any conflict path that does
 * not match a changed file exactly ({@link narrowToConflictingFiles}), leaves `files` UNNARROWED — today's
 * whole-diff behaviour, the safe/over-cautious fallback direction.
 * `#xu2krte` Fork 2 (review-human statute amendment) EXTENDS this: when the conflict is statute-tier, NOT
 * append-only, and the caller says the PR already carries `review:human` (`hasReviewHuman`), it is worth the
 * extra `listMainStatutePatches` round trip (`main`'s own patch for the same files, since the SAME merge base) to
 * ask {@link doesConflictOverlapMainEdits} whether `main` independently touched the SAME hunk region — a TRUE
 * semantic clash still stands down (unchanged), but a proximity-only conflict is `reviewHumanFixable`. Gated on
 * `hasReviewHuman` and `!appendOnlyStatute` so the common non-`review:human` / already-mechanical tick never pays
 * for the extra fetch, and any fetch/parse failure fails CLOSED (`reviewHumanFixable` stays `false` — stand down).
 * @param {Array<{path?:string}|string>} files
 * @param {{number:number|string, repo?:string|null, listPrPatches:Function, hasReviewHuman?:boolean, listMainStatutePatches?:Function, conflictingPaths?:?string[]}} o
 * @returns {{isStatuteTier:boolean, appendOnlyStatute:boolean, reviewHumanFixable:boolean}}
 */
function classifyStatuteConflict(files, {
  number, repo, listPrPatches, hasReviewHuman = false, listMainStatutePatches, conflictingPaths = null,
}) {
  const filesToCheck = narrowToConflictingFiles(files, conflictingPaths);
  const isStatuteTier = isStatuteTierConflict(filesToCheck);
  let appendOnlyStatute = false;
  let reviewHumanFixable = false;
  if (isStatuteTier) {
    const statuteTierFiles = (Array.isArray(filesToCheck) ? filesToCheck : [])
      .map((f) => (typeof f === 'string' ? f : f?.path))
      .filter((p) => p && (isDeclarativeLeashPath(p) || isStatutePath(p)));
    let patches = null;
    try {
      patches = listPrPatches({ number, repo });
      appendOnlyStatute = isAppendOnlyStatuteConflict(statuteTierFiles, patches);
    } catch {
      appendOnlyStatute = false; // fetch failure → stand down, the safe direction
    }
    if (!appendOnlyStatute && hasReviewHuman && typeof listMainStatutePatches === 'function') {
      try {
        const mainPatches = listMainStatutePatches({ number, repo });
        reviewHumanFixable = patches != null && !doesConflictOverlapMainEdits(statuteTierFiles, patches, mainPatches);
      } catch {
        reviewHumanFixable = false; // fetch failure → stand down, the safe direction
      }
    }
  }
  return { isStatuteTier, appendOnlyStatute, reviewHumanFixable };
}

/**
 * The open-PR discovery query. `exec` is injectable so the argv is assertable with no `gh` on PATH. Narrower
 * `--json` than `we:scripts/merge-ai-prs.mjs`'s main listing — this pass never classifies for merge, so it
 * needs no `body`/`statusCheckRollup`. `files` was added by `#xu2krte` — {@link isStatuteTierConflict} reads
 * it to decide whether a fresh conflict is dispatchable at all; it costs nothing on the common no-conflict tick
 * since it is read off the same `gh pr list` call this pass already makes.
 * @param {{exec?:Function, repo?:string|null}} [o]
 * @returns {Array<object>}
 */
export function defaultListParkedPrs({ exec = execFileSyncThrottled, repo = null } = {}) {
  // #gh-graphql-budget — read the host-shared open-PR snapshot (one right-sized list per repo per TTL for the
  // whole fleet) instead of a private `gh pr list`; null = not applicable (tests, cwd repo) → the direct read below.
  if (exec === execFileSyncThrottled) { const shared = readSharedOpenPrs({ repo, fields: 'number,headRefName,baseRefName,mergeable,mergeStateStatus,labels,files', allowDeferred: true }); if (shared) return shared; }
  // `baseRefName` (#3383) — the queued-grace routing below reads it to tell a STACKED PR (base isn't `main`, the
  // drain will never land it regardless of labels) apart from an ordinary conflict against `main`; costs nothing
  // extra since it comes off the same `gh pr list` call this pass already makes.
  const argv = ['pr', 'list', '--state', 'open', '--limit', String(PR_LIST_LIMIT),
    '--json', 'number,headRefName,baseRefName,mergeable,mergeStateStatus,labels,files'];
  if (repo) argv.push('--repo', repo);
  // #x5n4zn3 — was bare (no timeout).
  const out = exec('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL', throttle: { deferrable: true } });
  if (isGhDeferred(out)) return JSON.parse(String(out));
  const parsed = JSON.parse(String(out || '[]'));
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#defaultPostConflictFinding — Fork 4's dispatch entry point:
 * shell `we:scripts/conveyor/reconcile-finding.mjs` (a real subprocess, NOT an in-process call — that file's
 * own CLI harness calls `process.exit(0)` on success, which would kill this pass's own tick if invoked
 * in-process) to post the fresh conflict as a `review:changes` bounce. The body is written to an allowed temp
 * path (`we:scripts/review-set-label.mjs#bodyFileRoots`) and removed afterward either way.
 * @param {{pr:object, repo:string|null, exec?:Function}} o
 */
export function defaultPostConflictFinding({ pr, repo, exec = execFileSync, appendOnlyStatute = false, reviewHumanFixable = false, resync = false }) {
  const bodyPath = join(tmpdir(), `reconcile-finding-conflict-${pr?.number}-${randomUUID()}.md`);
  writeFileSync(bodyPath, buildConflictFindingBody({ num: pr?.number, headRefName: pr?.headRefName }, { appendOnlyStatute, reviewHumanFixable, resync }), 'utf8');
  try {
    const argv = [
      join(REPO_ROOT, 'scripts', 'conveyor', 'reconcile-finding.mjs'), String(pr?.number),
      `--body-file=${bodyPath}`, '--agent=parked-pr-conflict-watch', '--channel=the parked-PR conflict watch (#xw0odtv, dispatched per #xu2krte)',
    ];
    if (repo) argv.push(`--repo=${repo}`);
    // #x5n4zn3 — was bare (no timeout).
    exec('node', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024, timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
  } finally {
    try { unlinkSync(bodyPath); } catch { /* best-effort cleanup only */ }
  }
}

/**
 * we:scripts/conveyor/parked-pr-conflict-watch.mjs#defaultPostConflictStandDown — Fork 2's exception path: a
 * fresh conflict touching a declarative-leash/statute file routes straight here instead of
 * {@link defaultPostConflictFinding}. Shells `we:scripts/conveyor/stand-down.mjs --reason=conflict`, which posts
 * the durable `STAND_DOWN_MARKER` comment `we:scripts/conveyor/reconcile-core.mjs`'s `stood-down` refusal reads
 * FIRST, before phase/findings are even examined — so this PR is refused a fix dispatch no matter what review
 * label it carries, until a human clears the marker.
 * @param {{pr:object, repo:string|null, exec?:Function}} o
 */
export function defaultPostConflictStandDown({ pr, repo, exec = execFileSync }) {
  const argv = [join(REPO_ROOT, 'scripts', 'conveyor', 'stand-down.mjs'), String(pr?.number),
    '--reason=conflict', `--actor=${WATCHER_STAND_DOWN_ACTOR}`];
  if (repo) argv.push(`--repo=${repo}`);
  // #x5n4zn3 — was bare (no timeout).
  exec('node', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024, timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
}

/**
 * Hand a resolved conflict back through the existing repaired-bounce CLI for a fresh independent review.
 * @param {{pr:object, repo:string|null, exec?:Function}} o
 */
export function defaultPostConflictRearm({ pr, repo, exec = execFileSync }) {
  const argv = [join(REPO_ROOT, 'scripts', 'conveyor', 'rearm-review.mjs'), String(pr?.number),
    '--actor=parked-pr-conflict-watch (conflict resolved)'];
  if (repo) argv.push(`--repo=${repo}`);
  // #x5n4zn3 — was bare (no timeout).
  exec('node', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024, timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
}

/**
 * THE IO SHELL. Lists open PRs, classifies each, applies the label change + posts the one-time comment when a
 * PR newly transitions into conflict, and reports what happened. Never throws on a per-PR write failure — one
 * bad `gh` call must not stop the sweep from checking the rest (mirrors this file's siblings' best-effort
 * contract); the failure is reported in the per-PR result instead.
 * `#xu2krte`'s Fork 2/4 addition: on `newlyDetected`, ALSO route the PR to exactly one of
 * {@link defaultPostConflictFinding} (dispatchable — becomes a `review:changes` bounce the existing
 * fix-dispatch pipeline picks up) or {@link defaultPostConflictStandDown} ({@link isStatuteTierConflict} —
 * straight to a human, no dispatch attempt). Best-effort like every other write here: a failure is reported on
 * the entry, never thrown, and never stops the sweep from checking the rest of the PRs.
 * On `newlyResolved`, a remaining `review:changes` bounce goes to {@link defaultPostConflictRearm} — UNLESS
 * (#4118 finding (c)) a fix-agent session is still LIVE on this exact PR (`deriveReviewStatus`, name-based —
 * see the import comment at the top of this file), in which case the rearm (and the CONFLICT_LABEL removal
 * that would otherwise make it unretryable) is deferred to a later sweep instead of racing the fixer.
 * `queueScope` (epic #3383) — see {@link ./queue-scope.mjs}. DEFAULT OFF: with no marker and no env override
 * `scopePrsToQueue` is the IDENTITY function and this sweep stays repo-wide, exactly as it has always been. A
 * scoped checkout only labels/comments on the PRs its own queue names.
 * #4118 — on a fresh detection, the CONFLICT_LABEL is now applied LAST, only once the alert comment and the
 * dispatch/stand-down have each either just succeeded or were already found (via the `CONFLICT_RETRY_WINDOW_MS`
 * marker checks) on the PR's own thread. See the section above `CONFLICT_RETRY_WINDOW_MS` for the full reasoning.
 * @param {{repo?:string|null, listPrs?:Function, provider?:object, dryRun?:boolean, postFinding?:Function, postStandDown?:Function, postRearm?:Function, postSupersedeComment?:Function, listPrFiles?:Function, listPrPatches?:Function, listMainStatutePatches?:Function, computeConflictingPaths?:Function, listAgents?:Function, now?:number, queueScope?:object}} [o]
 * @returns {Array<{num:number, isConflicting:boolean, add:string|null, remove:string[], newlyDetected:boolean, newlyResolved?:boolean, commented:boolean, error?:string, routedTo?:string, supersededStandDown?:boolean, conflictDisposition?:string}>}
 */
export function watchParkedPrConflicts({
  repo = null, listPrs = defaultListParkedPrs, provider = createGhProvider(), dryRun = false,
  postFinding = defaultPostConflictFinding, postStandDown = defaultPostConflictStandDown,
  postRearm = defaultPostConflictRearm,
  postSupersedeComment = defaultPostSupersedeComment,
  listPrFiles = defaultListPrFiles,
  listPrPatches = defaultListPrPatches,
  listMainStatutePatches = defaultListMainStatutePatchesSinceMergeBase,
  listPrComments = defaultListPrComments,
  labelAgeMs = defaultConflictLabelAgeMs,
  labelRemovedAtMs = defaultConflictLabelRemovedAtMs,
  computeConflictDisposition = defaultComputeConflictDisposition,
  // #xconflres1 — the precise, content-based narrowing {@link classifyStatuteConflict} uses in place of the
  // PR's whole changed-file set wherever it can tell which file(s) actually conflict. Best-effort at every call
  // site below (a probe failure/`null`/empty result falls back to the existing whole-file check, unchanged).
  computeConflictingPaths = defaultConflictingFilePaths,
  attemptMechanicalRebase = defaultAttemptUnownedConflictRebase,
  listAgents = defaultListAgents,
  now = Date.now(),
  queueScope = {},
  // Card xkugvzd — the declared setting (`conflict-reassert-settings.json`, env `WE_CONFLICT_REASSERT_REVIEW_HUMAN`).
  // The CLI (the daemon's own invocation) resolves it once per sweep; an in-process caller that passes nothing gets
  // `off`, exactly the behaviour before this card.
  conflictReassertSettings = CONFLICT_REASSERT_OFF,
} = {}) {
  const listed = listPrs({ repo });
  if (isGhDeferred(listed)) return []; // throttle already logged the skipped pass
  const prs = scopePrsToQueue(listed, { label: 'parked-pr-conflict-watch', ...queueScope });
  const results = [];
  // xoh8fkw — resolved LAZILY, only once, only when a real write is about to happen (the common empty-sweep tick
  // never pays for the extra `gh repo view` call). `defaultListParkedPrs` above works fine with a null `repo`
  // (`gh pr list` derives it from cwd when `--repo` is omitted), but `review-label-provider.mjs`'s own
  // `GH_ARGV.ensureLabel`/`setLabels`/`postComment` always splice `'--repo', repo` into their argv
  // UNCONDITIONALLY — a null `repo` reaching them becomes a literal `"null"` argument once it hits `gh`.
  // Confirmed live 2026-09-05 on PR #1932: `gh label create … --repo null …` failing
  // `expected the "[HOST/]OWNER/REPO" format, got "null"` — this pass correctly detected the newly-conflicting
  // PR every tick but had NEVER actually applied a label, because the runner's own default invocation
  // (`runQuiet('conveyor/parked-pr-conflict-watch.mjs', ['sweep'])`) never passes `--repo` unless the runner
  // itself was started with one. Mirrors `we:scripts/review-set-label.mjs`'s own `repoOptional` resolution —
  // the provider's `currentRepo()` exists exactly for this ("fires only when `--repo` was omitted", its own
  // docblock) and was simply never called here.
  let resolvedRepo = repo;
  for (const pr of Array.isArray(prs) ? prs : []) {
    const parked = isParkedConflictTarget(pr);
    const queued = !parked && isQueuedConflictTarget(pr);
    // #xs81oxb — the THIRD population: neither parked nor queued (no review-workflow label at all). Folded into
    // `isConflicting` so it shares the SAME label lifecycle (apply on detect, clear on resolve) as the other two;
    // its own routing (mechanical rebase first, never a grace wait) is handled inside the `plan.add` branch below.
    const unowned = !parked && !queued && isUnownedConflictTarget(pr);
    const isConflicting = parked || queued || unowned;
    const plan = planConflictLabelChange({
      isConflicting, isResolved: String(pr?.mergeable || '').toUpperCase() === 'MERGEABLE', currentLabels: pr?.labels,
    });
    // An approved PR already flagged on an earlier sweep: bounce it once the drain's grace window has passed.
    const graceDue = queued && !plan.add && hasReviewLabel(pr?.labels, CONFLICT_LABEL);
    // #xu2krte Fork 2 (review-human statute amendment) — a PARKED (not queued) `review:human` PR that is ALREADY
    // labelled + still conflicting used to be permanently skipped here: the fresh-detection path decides ONCE,
    // at the absent→present label transition, and a non-append-only statute conflict routed straight to
    // `postStandDown` back then — with no rule this file knows about today, that PR sits invisible to every sweep
    // after. Re-check ONLY the narrow population this fork can change the answer for (already labelled, still
    // conflicting, parked, carrying `review:human`); the actual re-classification only fires below if that PR's
    // thread still carries THIS WATCH'S OWN prior marker (never a fix agent's or human's judgment stand-down),
    // so an already-correctly-dispatched or genuinely-still-standing-down PR costs nothing extra per sweep.
    const recheckCandidate = parked && !queued && !plan.add && plan.remove.length === 0
      && hasReviewLabel(pr?.labels, REVIEW_LABELS.human) && hasReviewLabel(pr?.labels, CONFLICT_LABEL);
    // #2793 (landing-freeze fix, 2026-09-27) — THE OTHER already-labelled population `recheckCandidate` above
    // does not cover: a PARKED PR (NOT `review:human` — an ordinary `review:pending` parked PR) that is ALREADY
    // labelled, STILL conflicting, and carries NO live `review:changes` bounce right now. Before this, such a PR
    // was invisible to every sweep after the first (this file's own "IDEMPOTENCY, NO SEPARATE STORE" header rule
    // — a comment posts only on the absent→present label transition, never again while the label sits on the
    // PR), while `reconcile-core.mjs`'s `OWED_ELSEWHERE.conflicted` refusal assumes THIS file owns re-attempting
    // it — a ping-pong with no owner. Confirmed live: `web-everything/web-everything#2793` sat exactly here
    // (`review:pending` + `review-round:2` + `merge-status:conflicting`, `mergeable: CONFLICTING`, no
    // `review:changes`) — the finding that once bounced it to `review:changes` had already been rearmed
    // (`review:changes → review:pending`) by a completed mechanical conflict-fix round that did not actually
    // clear the conflict (or raced a later push to `main`), and nothing ever re-asserted ownership after that.
    // Bound on {@link CONFLICT_FIX_ROUND_CAP} — the SAME cap `reconcile-core.mjs`'s own `isConflictBounce`
    // dispatch binds on — so re-asserting ownership here can never grant a PR more mechanical attempts than one
    // continuous ping-pong-free episode would have gotten.
    const idleConflictBounce = parked && !queued && !plan.add && plan.remove.length === 0
      && !hasReviewLabel(pr?.labels, REVIEW_LABELS.human) && hasReviewLabel(pr?.labels, CONFLICT_LABEL)
      && !hasReviewLabel(pr?.labels, REVIEW_LABELS.changes);
    if (!plan.add && plan.remove.length === 0 && !graceDue && !recheckCandidate && !idleConflictBounce) continue;
    const entry = { num: pr?.number, isConflicting, ...plan, commented: false };
    // The #2793 idle re-assert, shared with card xkugvzd's `review:human` case (`variant` only names the route).
    // Same round cap, same once-per-round guard, same `postFinding` (which keeps `review:human`). Pushes `entry`.
    const reassertIdleConflict = (comments, variant) => {
      try {
        const conflictFixRoundsSpent = countConflictFixComments(comments);
        if (conflictFixRoundsSpent >= CONFLICT_FIX_ROUND_CAP) {
          // Never loop forever past the shared cap — surface it once via the same reconcile-notes channel the
          // unowned population's own rebase-attempt cap already uses, then leave it (a person must take it).
          const note = {
            kind: 'round-cap-exhausted', prNumber: pr?.number, attempts: conflictFixRoundsSpent, cap: CONFLICT_FIX_ROUND_CAP,
            capKind: 'conflict-fix',
            text: `PR #${pr?.number}: mechanical conflict-fix rounds exhausted (${conflictFixRoundsSpent}/${CONFLICT_FIX_ROUND_CAP}) while still conflicting and idle (no live review:changes bounce) — a person must take it over`,
          };
          const notePlan = planNoteComment(note, comments);
          if (!notePlan.alreadyPosted && !dryRun) {
            if (resolvedRepo == null) resolvedRepo = provider.currentRepo();
            postNoteComment({ repo: resolvedRepo, pr: pr?.number, body: notePlan.body });
            try { notifyDesktopChecked({ title: 'Conveyor: conflict-fix cap exhausted', body: note.text }); } catch { /* best-effort */ }
          }
          entry.routedTo = `cap-exhausted (conflict-fix, idle${variant ? `, ${variant}` : ''})`;
          entry.conflictFixRoundsSpent = conflictFixRoundsSpent;
          results.push(entry);
          return;
        }
        // The episode boundary for THIS narrow population is the last completed conflict-fix round (if any) —
        // never the label-removal boundary `sinceMs` uses elsewhere in this file, because the label here has
        // never been removed at all (still conflicting). No prior round at all → `-Infinity` (the function's own
        // "no boundary, judge the whole window" default), so a first-ever idle bounce (finding never posted, no
        // rearm either) behaves exactly like a fresh episode.
        const lastRearmAtMs = latestConflictFixMarkerCreatedAtMs(comments);
        const sinceMs = Number.isFinite(lastRearmAtMs) ? lastRearmAtMs : -Infinity;
        if (hasRecentConflictFindingComment(comments, { now, sinceMs })) {
          // Already re-asserted for this round within the retry window — avoid reposting every tick.
          entry.routedTo = `reconcile-finding (idle conflict-bounce${variant ? `, ${variant}` : ''}, already re-asserted this round)`;
          results.push(entry);
          return;
        }
        if (resolvedRepo == null) resolvedRepo = provider.currentRepo();
        if (!dryRun) postFinding({ pr, repo: resolvedRepo });
        entry.routedTo = variant
          ? `reconcile-finding (idle conflict-bounce re-asserted, ${variant} — xkugvzd)`
          : 'reconcile-finding (idle conflict-bounce re-asserted — #2793)';
        entry.conflictFixRoundsSpent = conflictFixRoundsSpent;
        results.push(entry);
      } catch (e) {
        entry.error = String((e && e.message) || e).split('\n')[0];
        results.push(entry);
      }
    };
    if (idleConflictBounce && !recheckCandidate && !graceDue) {
      // Same lazy-read discipline as `recheckCandidate` just below — this narrow, otherwise-invisible
      // population costs nothing extra on every OTHER tick.
      let comments = [];
      try { comments = listPrComments({ number: pr?.number, repo }); } catch { comments = []; }
      reassertIdleConflict(comments, null);
      continue;
    }
    if (recheckCandidate && !graceDue) {
      try {
        // `repo` (possibly null) is enough for this READ — `defaultListPrComments` falls back to gh's own
        // `{owner}/{repo}` template exactly like `defaultListParkedPrs` does. `currentRepo()` is only resolved
        // below, and ONLY once a watcher marker is actually found, so the common "nothing to recheck" tick never
        // pays for it (mirrors this file's existing xoh8fkw discipline elsewhere in this loop).
        let comments = [];
        try { comments = listPrComments({ number: pr?.number, repo }); } catch { comments = []; }
        const watcherMarker = findWatcherStandDownComment(comments);
        if (!watcherMarker) {
          // Card xkugvzd (live: #4481) — no watcher stand-down, so the statute recheck below has nothing to change.
          // A `review:human` PR still conflicting with no live `review:changes` used to be skipped here forever (the
          // #2793 idle path excludes `review:human`). The declared rule decides whether to re-assert the idle
          // conflict finding; off, a live bounce, or any stand-down on the thread (a fix agent's own judgment call)
          // leaves it exactly as before.
          const decision = decideConflictReassert({
            labels: pr?.labels, hasLiveWatcherMarker: false, hasStandDown: standDownComments(comments).length > 0,
            settings: conflictReassertSettings,
          });
          if (!decision.reassert) continue;
          reassertIdleConflict(comments, 'review-human');
          continue;
        }
        // Already superseded (and dispatched) on an earlier sweep — the supersede comment is the durable record,
        // so re-posting it and a fresh finding every tick is pure noise (live on #2549, 2026-09-24).
        if (isWatcherMarkerAlreadySuperseded(comments)) continue;
        if (resolvedRepo == null) resolvedRepo = provider.currentRepo();
        let filesForCheck = null;
        try { filesForCheck = listPrFiles({ number: pr?.number, repo: resolvedRepo }); } catch { /* handled below */ }
        // #xconflres1 — best-effort; a probe failure/null/empty result leaves `classifyStatuteConflict` unnarrowed.
        let conflictingPaths = null;
        try { conflictingPaths = computeConflictingPaths({ pr, repo: resolvedRepo }); } catch { conflictingPaths = null; }
        const { isStatuteTier, appendOnlyStatute, reviewHumanFixable } = filesForCheck == null
          ? { isStatuteTier: true, appendOnlyStatute: false, reviewHumanFixable: false } // fetch failure → over-cautious
          : classifyStatuteConflict(filesForCheck, {
              number: pr?.number, repo: resolvedRepo, listPrPatches, hasReviewHuman: true, listMainStatutePatches, conflictingPaths,
            });
        // Two reasons the judgment stand-down must NOT stand even though the whole-diff heuristic still reads
        // statute-tier (live: web-everything/web-everything#3771, stuck for hours):
        //  - the operator recorded an answer to THIS stand-down (`isWatcherStandDownOperatorAnswered`);
        //  - `git merge-tree` finds NO conflict at all while GitHub still says CONFLICTING (a rename/modify main
        //    resolves cleanly, or GitHub's cached mergeability is stale). There is no hunk to judge, so
        //    `conflictingPaths` was `[]`, the narrowing fell back to the whole diff, and a statute file merely
        //    SITTING in the diff stood the PR down. That is a plain re-sync with main, never a judgment call.
        const operatorAnswered = isWatcherStandDownOperatorAnswered(comments);
        let gitClean = false;
        if (isStatuteTier && !appendOnlyStatute && !reviewHumanFixable && !operatorAnswered) {
          try { gitClean = computeConflictDisposition({ pr, repo: resolvedRepo }) === 'clean'; } catch { gitClean = false; }
        }
        const resync = gitClean;
        if (isStatuteTier && !appendOnlyStatute && !reviewHumanFixable && !operatorAnswered && !gitClean) {
          // Still a genuine judgment call — the earlier stand-down stands; never re-post, never duplicate the marker.
          entry.routedTo = 'stand-down (unchanged)';
          results.push(entry);
          continue;
        }
        // #xconflres1 — `!isStatuteTier` (the narrower conflict-path check found the real same-line conflict sits
        // OUTSIDE any leash/statute file entirely) is now ALSO dispatchable here, not just the append-only/
        // review-human-fixable sub-cases: the earlier stand-down was a false positive from the whole-diff
        // heuristic, exactly like the live #2772 incident {@link isStatuteTierConflict}'s own docblock records.
        let superseded = true;
        if (!dryRun) {
          // Finding FIRST, supersede SECOND. The supersede comment is what the next sweep's idempotency read
          // (`isWatcherMarkerAlreadySuperseded`) and the dispatch gate (`isStandDownSuperseded`) key on, so it must
          // only exist once the finding really went out. If `postFinding` throws, no supersede is posted and the
          // next sweep retries — instead of a "routed to a fix agent" note with no fix request behind it.
          postFinding({ pr, repo: resolvedRepo, appendOnlyStatute, reviewHumanFixable: isStatuteTier && !appendOnlyStatute && !operatorAnswered && !resync, ...(resync ? { resync: true } : {}) });
          // A missing supersede leaves the marker unsuperseded, so this same branch re-runs next sweep (the PR still
          // carries `review:human` + the conflict label) — only report it as superseded once it really posted.
          try { postSupersedeComment({ pr, repo: resolvedRepo, provider }); } catch { superseded = false; }
        }
        if (superseded) entry.supersededStandDown = true;
        entry.routedTo = resync
          ? 'reconcile-finding (git sees no conflict, GitHub does — plain re-sync with main, marker superseded)'
          : operatorAnswered && isStatuteTier && !appendOnlyStatute && !reviewHumanFixable
          ? 'reconcile-finding (operator answer lifted the stand-down, marker superseded)'
          : !isStatuteTier
          ? 'reconcile-finding (no longer statute-tier — #xconflres1, marker superseded)'
          : appendOnlyStatute
          ? 'reconcile-finding (append-only statute, marker superseded)'
          : 'reconcile-finding (review-human statute amendment, marker superseded)';
        results.push(entry);
      } catch (e) {
        entry.error = String((e && e.message) || e).split('\n')[0];
        results.push(entry);
      }
      continue;
    }
    // #3383 — the grace-expiry routing decision below is READ-ONLY (label age, then file/patch/comment fetches;
    // no label/comment write happens until the branches further down call `postStandDown`/`postFinding`, which
    // are themselves gated on `!dryRun`). So `graceDue` is handled BEFORE the dry-run bail, in both modes, and
    // dry-run reports the SAME routing decision a real sweep would take instead of silently skipping this whole
    // branch — which is exactly how a queued, approved, statute-tier-conflicting PR (PR #2505, live 2026-09-23)
    // could sit forever with dry-run never once surfacing what was actually happening to it.
    if (graceDue) {
      try {
        if (resolvedRepo == null) resolvedRepo = provider.currentRepo();
        // #xngv3vn — classify what is ACTUALLY conflicting BEFORE waiting on age at all. The 30-minute grace
        // exists to give the drain a chance to auto-heal the ONE shape it can rebase-drop on its own (a
        // conflict confined to the shared `.lane-manifest.json`, `we:scripts/lib/rebase-drop-manifest.mjs`) —
        // waiting the SAME window on a REAL content conflict wastes the whole grace on a repair the drain has
        // no code path for at all. `null` (cannot classify — no headRefName, an unresolvable ref, a git error)
        // keeps the EXISTING age-gated wait unchanged, the safe direction.
        const disposition = computeConflictDisposition({ pr, repo: resolvedRepo });
        const manifestOnly = disposition == null || disposition === 'manifest-only' || disposition === 'clean';
        if (manifestOnly) {
          // #4118 (b) — a PERSISTENTLY unreadable events API must not wait FOREVER: `labelAgeMs` returning
          // `null` on every sweep (a real, repeatable `gh` failure, not a one-off blip) used to leave this PR
          // waiting past grace with nothing ever nudging it forward — the same "silently stuck" shape the
          // #2503/#2514/#2515 incidents this file exists to catch. Fall back to this watch's OWN durable alert
          // comment timestamp (posted at detection, always present once the CONFLICT_LABEL is — see this file's
          // `#4118` effect ordering above `CONFLICT_RETRY_WINDOW_MS`) before giving up and waiting another tick.
          let age = labelAgeMs({ pr, repo: resolvedRepo });
          if (age == null) {
            let fallbackComments = [];
            try { fallbackComments = listPrComments({ number: pr?.number, repo: resolvedRepo }); } catch { fallbackComments = []; }
            const alertMs = latestConflictAlertCreatedAtMs(fallbackComments);
            if (alertMs != null) age = now - alertMs;
          }
          if (age == null || age < QUEUED_CONFLICT_GRACE_MS) continue; // the drain still has its turn
        } else {
          // A REAL (non-manifest) conflict — never worth waiting out the drain's turn on. Surfaced on the
          // entry even in dry-run (mirrors this whole branch's own dry-run-visibility discipline) so a sweep
          // is never silent about WHY a fresh-looking conflict was routed immediately instead of deferred.
          entry.conflictDisposition = disposition;
        }

        // #3383 — a STACKED PR (`baseRefName` isn't `main`) is never landed by the drain no matter how long it
        // waits here (`#poc-branch-declared-delivery-mode` clause 5: "base is not <default>"), so the drain-grace
        // reasoning this whole branch exists for ("give the drain first try") does not apply to it at all — there
        // is no drain turn to wait out. Worse, falling through to the generic `postFinding` bounce below would
        // strip `review:accepted` and force a fresh human review for what is ordinarily a purely mechanical
        // rebase against the PR's OWN base, never a real reviewer-facing content conflict. Deferred here instead:
        // `we:scripts/conveyor/reconcile-core.mjs`'s own STACKED-BASE CONFLICT branch dispatches the mechanical
        // rebase directly from the `conflicted` phase, on the SAME `CONFLICT_FIX_ROUND_CAP`/marker floor, with
        // review labels left completely untouched. This file posts no comment and touches no label for this
        // population — it only reports the deferral so a dry-run sweep is never silent about what is actually
        // happening to it (mirrors this whole branch's own dry-run-visibility discipline just above).
        //
        // CONFIRMED LIVE 2026-09-24: `web-everything/web-everything#2578` (base `lane/3681-ratify-daemon-lifecycle`)
        // is exactly this population — see `reconcile-core.mjs`'s own docblock for the full incident.
        const baseRefName = pr?.baseRefName ?? null;
        if (baseRefName && baseRefName !== 'main') {
          entry.routedTo = 'deferred-to-reconcile (stacked base — see reconcile-core.mjs#3383, review labels untouched)';
          results.push(entry);
          continue;
        }

        // Same verified-complete file fetch the fresh-detection path re-fetches on a suspected-truncated `pr.files`
        // — this path never reads `pr.files` at all, so it always pays for the paginated, uncapped read.
        let filesForCheck = null;
        try { filesForCheck = listPrFiles({ number: pr?.number, repo: resolvedRepo }); } catch { /* handled below */ }
        // #xconflres1 — best-effort narrowing to the actually-conflicting path(s); `disposition` already told us
        // this is a REAL (non-manifest) conflict, so a second, independent merge-tree probe is worth its cost
        // here specifically (an infrequent, already-git-bound branch) to avoid trusting the whole diff.
        let conflictingPaths = null;
        try { conflictingPaths = computeConflictingPaths({ pr, repo: resolvedRepo }); } catch { conflictingPaths = null; }
        const hasReviewHuman = hasReviewLabel(pr?.labels, REVIEW_LABELS.human);
        const { isStatuteTier, appendOnlyStatute, reviewHumanFixable } = filesForCheck == null
          ? { isStatuteTier: true, appendOnlyStatute: false, reviewHumanFixable: false } // fetch failure → over-cautious, the safe direction
          : classifyStatuteConflict(filesForCheck, {
              number: pr?.number, repo: resolvedRepo, listPrPatches, hasReviewHuman, listMainStatutePatches, conflictingPaths,
            });

        // #xconflres1 (live incident `web-everything/web-everything#2772`) — a QUEUED PR re-evaluated here every sweep
        // may already carry a stand-down THIS WATCH posted on an EARLIER sweep, back when it was still `parked`
        // and the whole-diff heuristic over-fired. If the narrower check above now says the conflict is
        // dispatchable, that earlier marker must be explicitly SUPERSEDED (never silently left to contradict a
        // fresh finding, and never re-derived a second time — reuses {@link findWatcherStandDownComment}/
        // {@link isWatcherMarkerAlreadySuperseded}, the SAME watcher-authored, not-yet-superseded check the
        // `recheckCandidate` branch above already runs) — this is what mechanically picks the PR back up with no
        // separate re-arm step. Read once, best-effort: a failure here just means no supersede is attempted (the
        // dispatch below still happens; `reconcile-core.mjs`'s stood-down refusal then keeps the PR terminal
        // until a later sweep's read succeeds).
        let priorWatcherStandDown = false;
        try {
          const threadComments = listPrComments({ number: pr?.number, repo: resolvedRepo });
          priorWatcherStandDown = Boolean(findWatcherStandDownComment(threadComments)) && !isWatcherMarkerAlreadySuperseded(threadComments);
        } catch { priorWatcherStandDown = false; }

        if (isStatuteTier && !appendOnlyStatute && !reviewHumanFixable) {
          // #3383 fix — this is NO LONGER assumed to have already reached a human at detection: the fresh path
          // only stands down IMMEDIATELY when the conflict is ALREADY statute-tier at that moment; a queued,
          // non-statute-tier conflict is deferred to the drain instead (`routedTo: 'deferred-to-drain'`) and can
          // only be classified as statute-tier here, for the first time, once grace expires. So hand it to a
          // human — the SAME stand-down the detection path uses — but idempotently: read the PR's own comment
          // thread for an existing stand-down marker first, since (unlike a label-transition-gated dispatch)
          // `graceDue` recomputes true on EVERY sweep for as long as the PR stays queued+conflicting+labelled
          // (`stand-down.mjs` makes no label change), so without this check it would re-post every tick.
          //
          // #4118 round 2 — only a stand-down from THIS episode counts: one posted before the CONFLICT_LABEL was
          // last removed belongs to a closed episode and must not silence this one. No recency window here (this
          // path re-runs for hours by design). An unreadable boundary, or an undated comment, keeps the old
          // "any stand-down counts" reading, so a `gh` hiccup can never turn into a re-post every sweep.
          //
          // A watcher stand-down this watch has since SUPERSEDED no longer counts (the same `isStandDownSuperseded`
          // predicate `reconcile-core.mjs`'s gate uses): otherwise a conflict that turns human-only AFTER a
          // supersede would never get a fresh stand-down, leaving the PR with no live marker and no finding.
          let alreadyStoodDown = false;
          try {
            const thread = listPrComments({ number: pr?.number, repo: resolvedRepo });
            const standDowns = standDownComments(Array.isArray(thread) ? thread.filter((_, i) => !isStandDownSuperseded(thread, i)) : thread);
            alreadyStoodDown = standDowns.length > 0;
            if (alreadyStoodDown) {
              let removedAt = null;
              try { removedAt = labelRemovedAtMs({ pr, repo: resolvedRepo }); } catch { removedAt = null; }
              if (Number.isFinite(removedAt) && removedAt > 0) {
                alreadyStoodDown = standDowns.some((c) => {
                  const ms = Date.parse(c.createdAt ?? '');
                  return !Number.isFinite(ms) || ms > removedAt;
                });
              }
            }
          } catch { /* read failure → assume not yet stood down: a duplicate comment beats silent starvation */ }
          if (alreadyStoodDown) continue; // already handed to a human — never re-post
          if (!dryRun) postStandDown({ pr, repo: resolvedRepo });
          entry.routedTo = 'stand-down (after drain grace)';
        } else {
          // #gh-write-burst (live 2026-09-27 03:5x-04:00Z) — the SAME episode-scoped re-post dedup the
          // fresh-detection path already applies to its own identical three branches (`hasRecentConflictFindingComment`,
          // used just below at line ~1493/1496/1501) was MISSING here for all three. `graceDue` recomputes true on
          // EVERY sweep for as long as a real (non-manifest), non-statute-tier conflict sits past the drain's grace
          // window (`stand-down.mjs` makes no label change, so nothing here ever went false on its own) — so, unlike
          // the `alreadyStoodDown`-guarded stand-down branch just above, these three calls fired `postFinding`
          // UNCONDITIONALLY on every 120s tick, for as long as the PR stayed stuck: a fresh `review:changes` label
          // write (`gh pr edit`) PLUS a fresh finding comment (`gh pr comment`) every tick, per stuck PR, per repo.
          // Confirmed live: `calls.jsonl` shows ~300 `pr edit`/`pr comment`/`api --method` mutations in the ten
          // minutes before GitHub's secondary rate limit tripped and froze landing for 04:04-04:33Z. Read the
          // thread ONCE (mirrors the fresh-detection path's own `#4118` "read once, both dedups share it" note)
          // so a genuinely NEW episode (label removed and re-applied since the last finding) still gets posted —
          // this is a re-post GUARD, not a permanent silence.
          let graceComments = [];
          try { graceComments = listPrComments({ number: pr?.number, repo: resolvedRepo }); } catch { graceComments = []; }
          let graceSinceMs = -Infinity;
          if (Array.isArray(graceComments) && graceComments.length) {
            let removedAt = null;
            try { removedAt = labelRemovedAtMs({ pr, repo: resolvedRepo }); } catch { removedAt = null; }
            graceSinceMs = Number.isFinite(removedAt) ? removedAt : Infinity;
          }
          const graceMarkerScope = { now, sinceMs: graceSinceMs };
          const alreadyBounced = hasRecentConflictFindingComment(graceComments, graceMarkerScope);

          // Dispatch to the fixer. The bounce strips review:accepted + ready-to-merge, so this PR is no longer a
          // queued target next sweep — which is why, on THIS path, the supersede goes FIRST (#xconflres1 review
          // round 1). Finding-first would strand the PR if the supersede then failed: the old stand-down would
          // still block the dispatch, and nothing would ever pick the PR up again. Supersede-first keeps a retry:
          // a failed supersede posts no finding (the PR stays queued and the next sweep retries both); a failed
          // finding after a good supersede leaves the PR queued too, and the next sweep (now reading the marker
          // as superseded) posts just the finding. `supersededStandDown` is only reported once it really posted.
          // #xconflres1 — includes the "no longer statute-tier at all" outcome (the false-positive stand-down this
          // whole card exists to unblock, e.g. `web-everything/web-everything#2772`).
          // #gh-write-burst — only the finding is skipped when `alreadyBounced`; the supersede needs no guard of its
          // own (`priorWatcherStandDown` already reads false once a supersede is on the thread).
          if (!dryRun) {
            if (priorWatcherStandDown) postSupersedeComment({ pr, repo: resolvedRepo, provider });
            if (alreadyBounced) { /* this episode's finding is already on the thread — never re-post */ }
            else if (isStatuteTier && appendOnlyStatute) postFinding({ pr, repo: resolvedRepo, appendOnlyStatute: true });
            else if (isStatuteTier) postFinding({ pr, repo: resolvedRepo, reviewHumanFixable: true });
            else postFinding({ pr, repo: resolvedRepo });
          }
          if (priorWatcherStandDown) entry.supersededStandDown = true;
          entry.routedTo = (isStatuteTier && appendOnlyStatute)
            ? 'reconcile-finding (append-only statute, after drain grace)'
            : isStatuteTier
            ? 'reconcile-finding (review-human statute amendment, after drain grace)'
            : priorWatcherStandDown
            ? 'reconcile-finding (no longer statute-tier — #xconflres1, marker superseded, after drain grace)'
            : 'reconcile-finding (after drain grace)';
        }
        results.push(entry);
      } catch (e) {
        entry.error = String((e && e.message) || e).split('\n')[0];
        results.push(entry);
      }
      continue;
    }
    if (dryRun) { results.push(entry); continue; }
    try {
      if (resolvedRepo == null) resolvedRepo = provider.currentRepo();
      if (plan.add) {
        // #3383 / xaer296 — STACKED-BASE, deferred BEFORE any alert/statute-tier classification, mirroring the
        // `graceDue` path's own placement (added by #2581) for the IDENTICAL reason stated there: a STACKED PR
        // (`baseRefName` isn't `main`) is never landed by the drain no matter what this path decides, so there
        // is no drain turn to wait out and no ordinary main-conflict story to tell. `reconcile-core.mjs`'s own
        // STACKED-BASE CONFLICT branch is the ONLY place this PR's conflict gets a comment or a dispatch, off
        // the SAME live `baseRefName` — nothing here is multi-step for this population, so (unlike the ordinary
        // path below) the label applies immediately: there is no alert/dispatch behind it to lose on a crash.
        const baseRefName = pr?.baseRefName ?? null;
        if (baseRefName && baseRefName !== 'main') {
          provider.ensureLabel(resolvedRepo, CONFLICT_LABEL, CONFLICT_LABEL_META);
          provider.setLabels(resolvedRepo, pr?.number, { add: CONFLICT_LABEL, remove: [] });
          entry.routedTo = 'deferred-to-reconcile (stacked base — see reconcile-core.mjs#3383, review labels untouched)';
          results.push(entry);
          continue;
        }

        // #4118 — read the thread ONCE, up front, so both the alert-comment dedup and the dispatch/stand-down
        // dedup below (and a resumed-after-crash retry on the NEXT sweep) work off the SAME snapshot. #xu38vlf
        // moved this read earlier than #4118 originally placed it, so the unowned-population attempt cap just
        // below can reuse the SAME snapshot — no extra `gh` cost on the common (non-retry) path.
        let existingComments = [];
        try { existingComments = listPrComments({ number: pr?.number, repo: resolvedRepo }); } catch { existingComments = []; }
        // The episode boundary every marker dedup below is scoped to (see the `CONFLICT_RETRY_WINDOW_MS`
        // section). Read only when there is a thread to judge; unreadable → `Infinity`, so no marker counts.
        let sinceMs = -Infinity;
        if (Array.isArray(existingComments) && existingComments.length) {
          let removedAt = null;
          try { removedAt = labelRemovedAtMs({ pr, repo: resolvedRepo }); } catch { removedAt = null; }
          sinceMs = Number.isFinite(removedAt) ? removedAt : Infinity;
        }
        const markerScope = { now, sinceMs };

        // #xs81oxb — UNOWNED gets NO grace period (unlike `queued`, just below): nothing else will ever attempt
        // this PR's rebase, so the mechanical fix runs on the SAME sweep that first detects it, before any label
        // or bounce. `computeConflictDisposition` is the SAME read-only git-level check the queued-conflict grace
        // path above already trusts; only on a genuinely mechanical shape (`clean`/`manifest-only`) is the REAL
        // rebuild-and-push attempted. A `null` disposition (unreadable — no headRefName, an unresolvable ref, a
        // git error) falls through to the ordinary bounce below unchanged, the safe direction: never invent a
        // mechanical success from a probe that could not actually tell.
        if (unowned) {
          const disposition = computeConflictDisposition({ pr, repo: resolvedRepo });
          entry.conflictDisposition = disposition;
          if (disposition === 'clean' || disposition === 'manifest-only') {
            // #xu38vlf (epic #4075/#3383) — CAP THE RETRY. Before this fix, an `action:'skip'`/`'error'` result
            // fell through to the ordinary bounce below in the SAME sweep, which already exits this population
            // (CONFLICT_LABEL applies before the sweep ends) — but a THROW from the git-level attempt itself (a
            // stale lock, a corrupted ref, a protected-branch push denial) aborted the WHOLE per-PR handler
            // before any label ever applied, so the PR stayed unowned and this same attempt retried again next
            // sweep — unbounded, forever, with nothing durable recording it. `countUnownedRebaseAttempts` reads
            // this population's OWN durable per-attempt marker (posted below, the MOMENT the outcome is known
            // to be a retry-worthy one — `'skip'`/`'error'`, INCLUDING a caught throw — never on a clean
            // `rebased`/`current` success, so the common healthy path stays exactly as quiet as before this
            // fix) — once it reaches the cap, this file stops attempting the rebase and surfaces it once via
            // the reconcile-notes channel + a desktop notify, then falls through to the ordinary bounce, exactly
            // like a `skip`/`error` disposition already does.
            const attemptsSoFar = countUnownedRebaseAttempts(existingComments);
            if (attemptsSoFar >= UNOWNED_REBASE_ATTEMPT_CAP) {
              entry.unownedRebaseAttempts = attemptsSoFar;
              entry.unownedRebaseCapExhausted = true;
              const note = {
                kind: 'round-cap-exhausted', prNumber: pr?.number, attempts: attemptsSoFar, cap: UNOWNED_REBASE_ATTEMPT_CAP,
                capKind: 'unowned-mechanical-rebase',
                text: `PR #${pr?.number}: unowned-mechanical-rebase auto-repair rounds exhausted (${attemptsSoFar}/${UNOWNED_REBASE_ATTEMPT_CAP}) — a person must take it over`,
              };
              const notePlan = planNoteComment(note, existingComments);
              if (!notePlan.alreadyPosted) {
                postNoteComment({ repo: resolvedRepo, pr: pr?.number, body: notePlan.body });
                try { notifyDesktopChecked({ title: 'Conveyor: unowned rebase cap exhausted', body: note.text }); } catch { /* best-effort — health-watch's own notify never blocks a tick either */ }
              }
              entry.roundCapNote = notePlan.alreadyPosted ? null : notePlan.key;
              // Never keep silently retrying past the cap — fall through to the ordinary bounce below.
            } else {
              let result;
              try { result = attemptMechanicalRebase({ pr, repo: resolvedRepo }); }
              catch (eAttempt) { result = { action: 'error', reason: String((eAttempt && eAttempt.message) || eAttempt) }; }
              entry.mechanicalRebase = { action: result?.action, reason: result?.reason ?? null };
              if (result?.action === 'rebased' || result?.action === 'current') {
                // Resolved mechanically — no label, no bounce, no fix agent spent on a conflict a rebuild already
                // cleared. GitHub's own `mergeable` flips on the next read of the PR once the push is seen.
                entry.routedTo = 'mechanical-rebase';
                results.push(entry);
                continue;
              }
              // `action === 'skip'` (a REAL, non-manifest conflict the read-only probe missed — e.g. `main`
              // moved between the probe and the attempt), `'error'` (a plumbing failure), or the caught-throw
              // above — durably record this attempt BEFORE falling through, so the count advances even if the
              // fall-through below (the comment/dispatch/label writes) itself then throws.
              try { provider.postComment(resolvedRepo, pr?.number, UNOWNED_REBASE_ATTEMPT_MARKER); }
              catch { /* best-effort — worst case this ONE attempt goes uncounted, same exposure as before this fix */ }
            }
          }
        }

        // Computed ONCE, ahead of both the alert comment and the routing decision below, so the two can never
        // disagree about what happens next — PR #1966's own review found exactly that drift (the alert still
        // said "not auto-rebased, human/`/finish` only" for a conflict this same call was about to dispatch a
        // fix agent at).
        //
        // #xgfzlj1 — `pr.files` came off `gh pr list --json ...,files`, which resolves `files` over `gh`'s own
        // GraphQL query hardcoding `files(first: 100)` with NO pagination (confirmed against `gh` 2.95.0 /
        // `cli/cli@trunk`; tracked upstream as a bug, cli/cli #6930/#5368). A length under the cap is PROVABLY
        // complete; a length AT the cap is indistinguishable from truncated, so re-fetch a verified-complete
        // list via the paginated REST endpoint before trusting it for this safety decision. On the rare case
        // that re-fetch itself fails, fail OVER-cautious (treat as statute-tier → stand-down), matching this
        // whole predicate's documented safe direction — never silently fall back to the possibly-truncated list.
        const rawFiles = Array.isArray(pr?.files) ? pr.files : [];
        let filesForCheck = rawFiles;
        let statuteCheckFailed = false;
        if (rawFiles.length >= GH_FILES_GRAPHQL_CAP) {
          try {
            filesForCheck = listPrFiles({ number: pr?.number, repo: resolvedRepo });
          } catch (eFiles) {
            statuteCheckFailed = true;
          }
        }
        // #3383-append-only-statute — live 2026-09-23, PR #2505: a statute-tier conflict where BOTH sides only
        // appended a separate new `### ` section is mechanically resolvable (keep both) and does not need to cost
        // a human review the way an actual overlapping-content statute edit must. Shared with the grace-expired
        // routing below via {@link classifyStatuteConflict} so the two can never compute this differently
        // (`#3383`) — only checked when the file set already qualifies as statute-tier at all (the common
        // non-statute tick pays nothing extra), and only over the STATUTE-TIER subset of files: a
        // declarative-leash file anywhere in that subset, a non-`.md` statute path, or any patch-fetch failure
        // all fail this closed (stand-down), the safe direction.
        const hasReviewHuman = hasReviewLabel(pr?.labels, REVIEW_LABELS.human);
        // #xconflres1 — best-effort narrowing to the actually-conflicting path(s), the same probe used at the
        // `graceDue`/`recheckCandidate` call sites above; a failure/null/empty result leaves the check unnarrowed.
        let conflictingPaths = null;
        try { conflictingPaths = computeConflictingPaths({ pr, repo: resolvedRepo }); } catch { conflictingPaths = null; }
        const { isStatuteTier, appendOnlyStatute, reviewHumanFixable } = statuteCheckFailed
          ? { isStatuteTier: true, appendOnlyStatute: false, reviewHumanFixable: false }
          : classifyStatuteConflict(filesForCheck, {
              number: pr?.number, repo: resolvedRepo, listPrPatches, hasReviewHuman, listMainStatutePatches, conflictingPaths,
            });
        const standDown = isStatuteTier && !appendOnlyStatute && !reviewHumanFixable;

        // #4118 — the card's own fix: post the alert ONLY if it is not already sitting on the thread from a
        // still-in-progress detection this sweep is retrying after a crash (see `CONFLICT_RETRY_WINDOW_MS`).
        if (!hasRecentConflictAlertComment(existingComments, markerScope)) {
          provider.postComment(resolvedRepo, pr?.number,
            buildConflictComment(pr, {
              isStatuteTier: standDown, deferredToDrain: queued, appendOnlyStatute,
              reviewHumanFixable: isStatuteTier && reviewHumanFixable,
            }));
          entry.commented = true;
        }

        // Fork 2/4 (#xu2krte) — route to exactly one downstream pipeline. Failures here are reported on the
        // entry the SAME way a label/comment failure already is. An append-only statute conflict, or a
        // review-human statute amendment that does not overlap what `main` independently changed, is dispatched
        // AT ONCE, bypassing the queued-PR drain grace below: that grace exists to let the drain auto-rebase a
        // shared-manifest-only conflict, which is not this case (a real content change in a statute doc), so
        // waiting on it would only delay the mechanical fix.
        //
        // #4118 (a) — and the LABEL now applies ONLY once this succeeds (or was already done): a crash between
        // the alert and the dispatch, or between the dispatch and the label, used to leave `plan.add` reading
        // null forever on the next sweep (already labelled → skipped) with the routing decision never made or
        // never retried. Leaving the label unapplied on a throw here means the WHOLE branch — alert-dedup
        // included — retries cleanly on the next sweep instead.
        if (standDown) {
          if (!hasRecentConflictStandDownComment(existingComments, markerScope)) postStandDown({ pr, repo: resolvedRepo });
          entry.routedTo = 'stand-down';
        } else if (isStatuteTier && appendOnlyStatute) {
          if (!hasRecentConflictFindingComment(existingComments, markerScope)) postFinding({ pr, repo: resolvedRepo, appendOnlyStatute: true });
          entry.routedTo = 'reconcile-finding (append-only statute)';
        } else if (isStatuteTier && reviewHumanFixable) {
          if (!hasRecentConflictFindingComment(existingComments, markerScope)) postFinding({ pr, repo: resolvedRepo, reviewHumanFixable: true });
          entry.routedTo = 'reconcile-finding (review-human statute amendment)';
        } else if (queued) {
          entry.routedTo = 'deferred-to-drain'; // bounced by a later sweep once QUEUED_CONFLICT_GRACE_MS passes
        } else {
          if (!hasRecentConflictFindingComment(existingComments, markerScope)) postFinding({ pr, repo: resolvedRepo });
          entry.routedTo = 'reconcile-finding';
        }
        provider.ensureLabel(resolvedRepo, CONFLICT_LABEL, CONFLICT_LABEL_META);
        provider.setLabels(resolvedRepo, pr?.number, { add: CONFLICT_LABEL, remove: [] });
      } else if (plan.remove.length) {
        // `planConflictLabelChange` only ever returns a non-empty `remove` alongside `newlyResolved: true`.
        const needsRearm = hasReviewLabel(pr?.labels, REVIEW_LABELS.changes);
        let deferRearm = false;
        if (needsRearm) {
          // #4118 (c) — never hand a repaired bounce back for re-review while a fix agent is STILL actively
          // working this exact PR (it could be mid-push, or resolving something else on the same lane) — a
          // race a bare `mergeable: MERGEABLE` read cannot rule out. Name-based, independent of
          // `reconcile-core.mjs#assessLiveness` — see this file's own import comment for why.
          let agents = [];
          try { agents = listAgents(); } catch { agents = []; }
          let status = null;
          try {
            const repoKey = resolvedRepo ? repoKeyForSlug(resolvedRepo) : 'we';
            status = deriveReviewStatus({ pr: pr?.number, agents, repo: repoKey || 'we' });
          } catch { status = null; }
          deferRearm = status?.role === 'fix';
        }
        if (deferRearm) {
          // The CONFLICT_LABEL is deliberately left ON: removing it now would make `planConflictLabelChange`
          // stop emitting `newlyResolved` on the NEXT sweep (the label's own absence would already say
          // "resolved"), permanently losing the rearm this fixer is still owed once it finishes — the same
          // "lost forever" shape #4118 (a) names, one effect over.
          //
          // #xu38vlf (epic #4075/#3383) — BOUND THE WAIT. Read the thread once, lazily (only this less-common
          // branch pays for it — the ordinary rearm below never does), and read back this episode's OWN durable
          // "since" marker: the first sweep this deferral was observed for the CURRENT conflict episode (scoped
          // to it the same way every other marker here is — after the episode's own alert comment, so a fresh
          // conflict cycle always starts a fresh wait). Past REARM_DEFERRED_BOUND_MS, this file does NOT force a
          // rearm — that would race the exact liveness gap #4118 (c) introduced this wait to avoid — it
          // SURFACES the stale wait via the reconcile-notes channel + a desktop notify, once per episode, and
          // keeps deferring; a human decides whether the liveness read is stale or the fixer is genuinely still
          // working.
          let deferComments = [];
          try { deferComments = listPrComments({ number: pr?.number, repo: resolvedRepo }); } catch { deferComments = []; }
          const episodeSinceMs = latestConflictAlertCreatedAtMs(deferComments) ?? -Infinity;
          const firstDeferredAt = firstRearmDeferredCreatedAtMs(deferComments, episodeSinceMs);
          if (firstDeferredAt == null) {
            try { provider.postComment(resolvedRepo, pr?.number, REARM_DEFERRED_MARKER); }
            catch { /* best-effort — worst case the "since" clock restarts next sweep, the safe direction */ }
            entry.rearmDeferredSince = now;
          } else {
            const waitedMs = now - firstDeferredAt;
            entry.rearmDeferredSince = firstDeferredAt;
            entry.rearmDeferredWaitedMs = waitedMs;
            if (waitedMs >= REARM_DEFERRED_BOUND_MS) {
              const note = {
                kind: 'liveness-wait-exhausted', prNumber: pr?.number, since: new Date(firstDeferredAt).toISOString(),
                text: `PR #${pr?.number}: the rearm has been withheld on a "fix session still live" liveness read for over `
                  + `${Math.round(REARM_DEFERRED_BOUND_MS / 60000)} minutes — confirm the read is stale (and clear it, `
                  + 'e.g. via /finish) or that the fixer is genuinely still working',
              };
              const notePlan = planNoteComment(note, deferComments);
              if (!notePlan.alreadyPosted) {
                postNoteComment({ repo: resolvedRepo, pr: pr?.number, body: notePlan.body });
                try { notifyDesktopChecked({ title: 'Conveyor: rearm withheld past its bound', body: note.text }); }
                catch { /* best-effort — health-watch's own notify never blocks a tick either */ }
              }
              entry.rearmDeferredNote = notePlan.alreadyPosted ? null : notePlan.key;
            }
          }
          entry.routedTo = 'rearm-deferred (fix agent still live)';
        } else {
          // #4118 round 2 — rearm FIRST, remove the label LAST. The label's presence is what makes
          // `newlyResolved` fire again next sweep, so removing it before a rearm that then throws (or before a
          // crash) lost the rearm for good. A failed rearm now leaves the label on and the next sweep retries;
          // once a rearm lands, `review:changes` is gone, so a retry after a crash here only removes the label.
          // Known cost: a rearm that posts its comment but then fails the label swap is retried, posting a second
          // rearm comment (one extra negotiation round) — rare, and better than losing the rearm.
          if (needsRearm) {
            try {
              postRearm({ pr, repo: resolvedRepo });
              entry.routedTo = 'rearm-review';
            } catch (e2) {
              entry.error = String((e2 && e2.message) || e2).split('\n')[0];
            }
          }
          if (!entry.error) provider.setLabels(resolvedRepo, pr?.number, { add: undefined, remove: plan.remove });
        }
      }
    } catch (e) {
      entry.error = String((e && e.message) || e).split('\n')[0];
    }
    results.push(entry);
  }
  return results;
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const argv = process.argv.slice(2);
  const flag = (name) => (argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3) || undefined;
  const verb = argv.find((a) => !a.startsWith('--')) || 'sweep';
  const repo = flag('repo') || null;
  const dryRun = argv.includes('--dry-run');
  const prsFile = flag('prs-file');
  if (verb !== 'sweep') {
    writeLineSync(2, `usage: parked-pr-conflict-watch.mjs sweep [--repo=<owner/name>] [--dry-run] [--prs-file=<path>]`);
    process.exitCode = 2;
  } else {
    try {
      const results = watchParkedPrConflicts({
        repo, dryRun, ...(prsFile ? { listPrs: () => readPrsFromFile(prsFile) } : {}),
        conflictReassertSettings: resolveConflictReassertSettings(),
      });
      for (const r of results) {
        const verb2 = dryRun ? 'would' : r.error ? 'FAILED to' : 'did';
        const what = r.add ? `apply ${CONFLICT_LABEL}${r.commented ? ' + comment' : ''}` : `remove ${r.remove.join(',')}`;
        writeLineSync(2, `  ⚠ PR #${r.num}: ${verb2} ${what}${r.error ? ` (${r.error})` : ''}`);
      }
      writeAllSync(1, `${JSON.stringify({ checked: true, changed: results.length, results })}\n`);
    } catch (e) {
      writeLineSync(2, `error: ${String(e?.message ?? e)}`);
      process.exitCode = 1;
    }
  }
}
