#!/usr/bin/env node
/**
 * @file scripts/lib/daemon-rebuild.mjs
 * @description Module C (card 4044/xgomze7, "the heart") of the daemon-clone rebuild
 *   (docs/agent/platform-decisions.md#resident-daemon-reload-lifecycle clauses 2-5) — REBUILDS a daemon clone
 *   fresh from `origin/main` plus its registered overlay list (`daemon-overlays.mjs`, Module B) every tick,
 *   instead of the old "merge whatever's ahead into whatever's here" self-sync, which could drift a clone into
 *   a tree no single commit on GitHub ever represented (an overlay merged last week, main merged on top of it
 *   THIS week, in an order nobody could reconstruct from `origin` alone).
 *
 * WHY THE BUILD HAPPENS IN THE OBJECT DB, NOT THE WORKING TREE. `git merge-tree --write-tree` computes a merged
 * TREE object without touching the index or working tree at all; `git commit-tree` mints a commit object from
 * that tree with explicit parents — both are pure object-database operations that can run in a bare scratch
 * repo, can be retried freely, and can be killed mid-flight with ZERO effect on any real checkout (nothing on
 * disk outside `.git/objects` and a scratch dir is ever touched while the build is COMPUTED). The
 * adoption step, `git reset --hard <finalSha>`, moves the tracked working tree — and it moves it in ONE atomic jump
 * from the old good commit straight to the new one. A killed rebuild therefore never leaves a half-merge: either
 * the `reset --hard` completed (new tree, in full) or it didn't run yet (old tree, in full). `git clean` is
 * NEVER called anywhere in this file — a daemon clone can have build artifacts, node_modules, or other
 * gitignored state a bystander process depends on, and wiping it is not this module's business. The narrow
 * exception is post-fetch pruning of untracked provisional backlog cards proven landed on pinned main.
 *
 * DETERMINISM. The identity `daemon-rebuild <daemon-rebuild@localhost>` and `GIT_AUTHOR_DATE`/
 * `GIT_COMMITTER_DATE` pinned to `@<the later of the two parents' committer dates> +0000` (see
 * {@link REBUILD_IDENTITY_ENV} and the date computation in {@link planRebuild}) mean `commit-tree` is called
 * with the SAME five inputs (tree, two parents, message, identity+date) whenever the same overlay is applied
 * onto the same `main`, whatever machine or however many times it runs — git commit objects are content-
 * addressed, so identical inputs mint the IDENTICAL sha. This is what makes `rebuildClone`'s own idempotency
 * check ("already at `finalSha`? nothing to do") and the reject-cache ("already rejected these exact inputs?
 * don't re-smoke") both correct rather than approximate.
 *
 * PURE CORE / IO SHELL, same convention as every other file in this lifecycle: {@link planRebuild} and
 * {@link findUnsafeLocalState} take an injected `git(args)` callback (spawnSync-shaped, already bound to
 * cwd/env/timeout by the caller) and do no IO of their own beyond calling it — {@link rebuildClone} and
 * {@link dryRunRebuild} are the IO shells that construct that callback, hold the clone's write lock
 * (`daemon-clone-lock.mjs`, Module A), read/write the overlay list (`daemon-overlays.mjs`, Module B), and run
 * the live smoke (`daemon-live-smoke.mjs`, Module D).
 *
 * xa4qo7n (epic #4075/#3383) — THE SMOKE NEVER RUNS AGAINST `root`, AND NEVER HOLDS THE WRITE LOCK. Live
 * 2026-09-26 09:32 ET: the two checks #2691 added (`reconcile-dry-run`, `dispatch-dry-run`) pushed a routine
 * smoke to ~65s; since the OLD `rebuildClone` ran `git reset --hard <candidate>` (Step 5) and THEN the whole
 * live smoke (Step 6) inside ONE `withWriteLock` hold, every daemon sharing the clone was refused its read lock
 * (`writer-active`) and ticked 0 dispatches for that whole ~65s, every time main moved — the same class of bug
 * #2625 fixed for the smoke's OWN duration, but #2625 never moved the smoke OFF the lock. `rebuildClone` now
 * splits into three steps, only the first and third of which ever touch `root`'s working tree or take its
 * write lock:
 *   1. {@link prepareRebuild} (locked, fast — recovery/safety/fetch/`planRebuild`, all object-DB-only or plain
 *      reads until the very last instant): computes `plan.finalSha` and returns EITHER a terminal result (same
 *      short-circuit reasons as before: dirty, up-to-date, still-rejected, a pinned-overlay refusal, …) or a
 *      `{terminal:false, plan, prevHead}` signal to proceed.
 *   2. UNLOCKED: {@link materializeCandidate} checks `plan.finalSha` out into a disposable `git worktree` (see
 *      {@link candidateWorktreePath}) — sharing `root`'s object DB, so this fetches/copies nothing — and the
 *      FULL live smoke runs against THAT worktree, never against `root`. Every daemon sharing `root` keeps
 *      reading/dispatching off root's CURRENT, already-verified tree for the smoke's entire duration.
 *   3. {@link finalizeRebuild} (locked, fast — only reached after a PASSING smoke): re-verifies nothing else
 *      moved `root` while step 2 ran (a sibling process's own rebuild, or one that already landed this exact
 *      build), then does the ONE `git reset --hard <finalSha>` this module ever performs, and writes
 *      `state.adopted`. A FAILING smoke (step 2) never reaches this step at all — `root` was never touched, so
 *      there is nothing to roll back, and no lock is ever taken for a rejection.
 * This also collapses the old `state.unverified`/`smokeOnly` re-smoke-on-crash-recovery path: since a reset now
 * NEVER runs before its smoke has already passed, a crash between step 3's reset and its state write can only
 * ever be a crash on an ALREADY-VERIFIED build — recovery ({@link prepareRebuild}'s Step 0) promotes it straight
 * to `adopted` from the `inProgress` record's own echoed plan fields, with no re-smoke.
 *
 * x5wbsbc (epic #4075) — A FAILED UPDATE NEVER BLOCKS DELIVERY (operator ruling 2026-09-26: "fallback on last
 * working version rather than block delivery"). Live 12:11-12:40 ET the same day, every rebuild of
 * `wev-review-daemon` was `smoke-rejected` (sticky) — not because the code was bad, but because the candidate
 * worktree's smoke resolved the lane pool from the candidate's own path — and every dispatch refused as stale.
 * Now: the candidate smoke runs in the live daemon's environment ({@link candidateSmokeEnv}); one candidate smoke
 * per clone at a time (#2731's single-flight build lease — the review and fix daemons share a clone and raced on
 * one candidate path); and a failing candidate falls back — plain main without
 * the non-pinned overlays, else the last-good build, with a control smoke of that build telling a broken HARNESS
 * (`smoke-harness-broken`, backoff, never sticky) from broken code ({@link smokeAndAdopt}). A held clone records
 * `state.held` and keeps dispatching from its last-good build (`main-staleness.mjs#assertMainNotStale`,
 * `daemon-last-good.mjs`); the health watch's `daemon-held-on-last-good` sign notifies after 15 min.
 *
 * fix-rebuild-finalize — A PASSING SMOKE IS NEVER THROWN AWAY. Live 2026-09-26: step 3's lock wait kept losing to
 * a sibling daemon's tick that started during the unlocked smoke, and every retry re-smoked a new sha. A pass is
 * now recorded as the clone's ready candidate ({@link readyCandidatePath}) before step 3 tries the lock (which now
 * waits the longer {@link FINALIZE_LOCK_WAIT_ENV}); the next write-lock holder — a later tick, or the sibling at its
 * own tick start — adopts it in {@link prepareRebuild} without re-smoking ({@link matchReadyCandidate}).
 *
 * DRY RUN IS STRICTLY READ-ONLY ON THE REAL CLONE. {@link dryRunRebuild} never calls `git reset`, `git fetch`
 * (against the clone itself — it fetches into a disposable scratch bare repo instead), or anything else that
 * writes an object or moves a ref in `root`. It borrows `root`'s objects via `objects/info/alternates` (so the
 * scratch repo can `merge-tree`/`commit-tree` without re-downloading anything already local) and does its OWN
 * fresh fetch of `origin/main` + every overlay ref into the scratch repo — never touching `root`'s own
 * `refs/remotes/origin/*`, so a dry run run concurrently with a real tick can never race it or leave it stale.
 * Every command this file runs directly against `root` (as opposed to the scratch repo) carries
 * `GIT_OPTIONAL_LOCKS=0` so even a `status`/`rev-parse` read never takes `.git/index.lock`.
 *
 * STATE. Per-clone rebuild state — `{adopted, rejected, inProgress, quarantine}` — lives OUTSIDE the git tree
 * (same clause-3(iii) posture as `daemon-overlays.mjs`'s own state file, same `cloneKey` so both key on the
 * exact same identity), at `<env.WE_DAEMON_STATE_DIR || ~/.claude/daemon-self-sync-state>/<cloneKey>.rebuild.json`.
 * `adopted` remembers the last successfully-adopted build (so a later call with the SAME inputs is a fast
 * `up-to-date` no-op); `rejected` remembers the last inputs a live smoke genuinely rejected (`'code'` verdict —
 * never a `'transient'` one, see {@link runLiveSmokeWithRetry}) so the SAME broken build is never re-smoked
 * every tick until the inputs actually change; `inProgress`/`quarantine` are crash-recovery breadcrumbs for a
 * rebuild that died mid-way (see {@link rebuildClone}'s step 0).
 *
 * ALERTS. Every notable event this module's IO shell hits — an auto-dropped overlay, a recovered stale
 * `index.lock`, a rejected smoke, a rollback that itself failed — goes through one `alert()` call that (a) logs
 * via `log.error` prefixed `daemon-rebuild:`, (b) is returned in the result's `alerts` array, and (c) is
 * appended to `<stateDir>/<cloneKey>.alerts.jsonl` — one JSON line per event, an audit trail that survives past
 * whatever the state file's own current snapshot says.
 */

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync, statSync, unlinkSync,
  existsSync, symlinkSync, lstatSync,
} from 'node:fs';
import { tmpdir, hostname, homedir } from 'node:os';
import { join, dirname, resolve as resolvePath, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';

import { createRequire } from 'node:module';
import { idFromName, isHash, isNum } from '../backlog/id.mjs';

import { withWriteLock } from './daemon-clone-lock.mjs';
import {
  cloneKey, overlayFilePath, readOverlayState, removeOverlay, appendOverlayEvent,
} from './daemon-overlays.mjs';
import {
  runLiveSmokeWithRetry, isEnvTimeoutRow, TRANSIENT_FAILURE_PATTERNS,
  SMOKE_ENV_TIMEOUT_MIN_ELAPSED_MS_ENV, DEFAULT_ENV_TIMEOUT_MIN_ELAPSED_MS,
} from './daemon-live-smoke.mjs';
import { isSafeBranchName } from './daemon-self-sync.mjs';
import { gitRun } from './main-staleness.mjs';
import { daemonStateDir, daemonConveyorStateRoot } from './daemon-last-good.mjs';
import { defaultPoolRoot, workspaceFor } from './lane-pool-paths.mjs';

// ── Fixed rebuild identity (see file header — DETERMINISM) ─────────────────────────────────────────────────

/** `daemon-rebuild <daemon-rebuild@localhost>` — the ONE identity every `commit-tree` this module mints uses,
 *  whatever machine/user runs it, so the same inputs always produce the same commit sha. */
export const REBUILD_IDENTITY_ENV = Object.freeze({
  GIT_AUTHOR_NAME: 'daemon-rebuild',
  GIT_AUTHOR_EMAIL: 'daemon-rebuild@localhost',
  GIT_COMMITTER_NAME: 'daemon-rebuild',
  GIT_COMMITTER_EMAIL: 'daemon-rebuild@localhost',
});

/** One git-runner factory shared by every call site in this file — always carries the fixed rebuild identity
 *  (harmless for anything but `commit-tree`), a `timeout` + `killSignal:'SIGKILL'` (house style: a hung git
 *  child can never hang this module), and an optional per-call `env` override (`opts.env`, used only for the
 *  `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` a single `commit-tree` call needs — see {@link planRebuild}). */
function makeGit({ run, cwd, env, timeoutMs = 60_000, extraEnv = {} }) {
  return (args, opts = {}) => run(args, {
    cwd,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    env: { ...env, ...REBUILD_IDENTITY_ENV, ...extraEnv, ...(opts.env || {}) },
  });
}

/** `--verify --end-of-options` is this codebase's established pattern (`diff-branch-coverage.mjs`) for
 *  resolving a ref that might contain attacker-controlled text without git reading it as an option — plain
 *  `git rev-parse -- <ref>` does NOT do this (rev-parse echoes `--` back literally rather than treating it as
 *  an end-of-options marker); `--end-of-options` is the flag that actually does. Returns the resolved sha, or
 *  `null` on any failure (unknown ref, timeout, non-zero exit) — never coerced into a false positive. */
function verifyRev(git, rev) {
  const r = git(['rev-parse', '--verify', '--end-of-options', rev]);
  const out = String(r.stdout ?? '').trim();
  return r.status === 0 && out ? out : null;
}

// ── pinned overlays — the self-destruct guard ───────────────────────────────────────────────────────────────

/**
 * The files that ARE the rebuild mechanism: the daemon tick imports these to rebuild itself. An overlay that
 * changes any of them is "load-bearing" for the clone. Dropping it for a conflict would rebuild the clone onto
 * a tree whose code no longer knows how to rebuild (or re-add) it. That happened live on 2026-09-25: #2625 was
 * the overlay carrying this very module; main moved, the overlay conflicted, the rebuild conflict-dropped it,
 * and the clone fell back to main's old merge-on-top self-sync with no overlay list at all.
 */
export const REBUILD_MECHANISM_PATHS = Object.freeze([
  'scripts/lib/daemon-rebuild.mjs',
  'scripts/lib/daemon-overlays.mjs',
  'scripts/lib/daemon-clone-lock.mjs',
  'scripts/lib/daemon-self-sync.mjs',
  'scripts/lib/daemon-live-smoke.mjs',
  'scripts/daemon-overlay.mjs',
  'scripts/lib/daemon-last-good.mjs',
]);

/** The one human-readable line every pinned refusal carries. */
export const PINNED_OVERLAY_MESSAGE = 'pinned overlay conflicts with main — needs a rebase';
/** …and the one a pinned overlay carries when its ref/PR went away without main having it. */
export const PINNED_OVERLAY_GONE_MESSAGE = 'pinned overlay is gone (ref deleted or PR closed) but main does not have it — re-register or unpin it';

/**
 * Is this overlay pinned? Either the entry says `pinned:true`, or its own changes (merge-base(main, tip)..tip)
 * touch {@link REBUILD_MECHANISM_PATHS}. Fail closed: if git cannot answer, treat it as pinned. A wrong "pinned"
 * only makes the rebuild wait for a rebase; a wrong "not pinned" can destroy the mechanism.
 * @returns {{pinned:boolean, why:'flag'|'mechanism'|'unknown'|null}}
 */
function pinnedStatus(git, raw, mainSha, ovSha) {
  if (raw?.pinned === true) return { pinned: true, why: 'flag' };
  if (!ovSha) return { pinned: false, why: null };
  const mb = git(['merge-base', mainSha, ovSha]);
  const base = String(mb.stdout ?? '').trim();
  if (mb.status !== 0 || !base) return { pinned: true, why: 'unknown' };
  const diff = git(['diff', '--name-only', base, ovSha, '--', ...REBUILD_MECHANISM_PATHS]);
  if (diff.status !== 0) return { pinned: true, why: 'unknown' };
  return String(diff.stdout ?? '').trim() ? { pinned: true, why: 'mechanism' } : { pinned: false, why: null };
}

/** The mechanism files main itself must carry for a build WITHOUT a skipped pinned overlay to still rebuild
 *  (re-read the overlay list, re-apply the overlay once rebased). */
const MECHANISM_CORE_PATHS = Object.freeze(['scripts/lib/daemon-rebuild.mjs', 'scripts/lib/daemon-overlays.mjs']);

/**
 * xpinskip (live 2026-09-26 23:39 ET) — may a CONFLICTING pinned overlay be skipped for this build instead of
 * refusing the whole rebuild? The pin exists so a build never lands on a tree that cannot rebuild itself (the
 * 2026-09-25 #2625 incident: the overlay CARRIED daemon-rebuild.mjs; plain main had no rebuild at all). That
 * danger is real only when main lacks the mechanism the overlay brings. So a skip is allowed only when:
 *   - the pin is DERIVED (`why === 'mechanism'`) — an explicit `--pinned` flag is the operator's own "refuse,
 *     never build without it" and is honored; an `'unknown'` pin (git could not answer) fails closed;
 *   - main already has every core mechanism file AND every mechanism file the overlay touches — i.e. the
 *     overlay only CHANGES a mechanism main already runs; it never ADDS one main lacks.
 * The skipped overlay stays registered; once its branch is rebased it merges cleanly and re-applies.
 * Fail closed on any git error.
 * @returns {{skippable:boolean, why:string, paths?:string[]}}
 */
function pinnedConflictSkippable(git, mainSha, ovSha, pinnedBy) {
  if (pinnedBy !== 'mechanism') return { skippable: false, why: pinnedBy === 'flag' ? 'explicit-pin' : 'pin-unknown' };
  const mb = git(['merge-base', mainSha, ovSha]);
  const base = String(mb.stdout ?? '').trim();
  if (mb.status !== 0 || !base) return { skippable: false, why: 'merge-base-failed' };
  const diff = git(['diff', '--name-only', base, ovSha, '--', ...REBUILD_MECHANISM_PATHS]);
  if (diff.status !== 0) return { skippable: false, why: 'diff-failed' };
  const touched = String(diff.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const missing = [...new Set([...MECHANISM_CORE_PATHS, ...touched])]
    .filter((p) => git(['cat-file', '-e', `${mainSha}:${p}`]).status !== 0);
  if (missing.length > 0) return { skippable: false, why: 'main-lacks-mechanism', paths: missing };
  return { skippable: true, why: 'main-has-mechanism', paths: touched };
}

// ── planRebuild — pure over an injected git(args) runner ────────────────────────────────────────────────────

/**
 * PURE (all IO through `git`/`prState`): compute the rebuild plan — resolve `mainRef`, walk `overlays` in list
 * order applying each on top of the running `cur` tip (auto-dropping ones main/PR state has already made moot,
 * conflict-dropping ones that don't merge cleanly THIS pass without forgetting them), and return the resulting
 * final sha plus a full decision log. Never mutates the overlay list itself — {@link rebuildClone} does that
 * from the returned `decisions`.
 * @param {{git:(args:string[], opts?:{env?:object})=>{status:number,stdout:string,stderr:string},
 *   headSha:string, mainRef:string, overlays?:Array<{ref:string, pr?:number|null}>,
 *   prState?:(pr:number)=>(Promise<string|null>|string|null), mainOnly?:boolean}} o
 * @returns {Promise<{ok:false, reason:'main-unresolved'}|{ok:true, mainSha:string, finalSha:string,
 *   applied:Array<{ref:string,pr:number|null,sha:string}>,
 *   decisions:Array<{ref:string,pr:number|null,action:'remove'|'drop'|'skip'|'apply',reason:string,sha:string|null}>,
 *   alerts:Array<object>, inputsKey:string, upToDate:boolean}>}
 */
export async function planRebuild({
  git, headSha, mainRef, overlays = [], prState, mainOnly = false,
}) {
  const mainSha = verifyRev(git, `${mainRef}^{commit}`);
  if (!mainSha) return { ok: false, reason: 'main-unresolved' };

  const alerts = [];
  const decisions = [];
  const applied = [];
  let cur = mainSha;

  const toProcess = mainOnly ? [] : overlays;
  if (mainOnly && overlays.length > 0) {
    alerts.push({ kind: 'overlays-refused-main-only', detail: { count: overlays.length } });
  }

  // A pinned overlay may only leave the build because main already has it (`pr-merged` / `in-main`), or — for
  // a CONFLICT only — be SKIPPED this pass when main already runs the mechanism it changes (see
  // `pinnedConflictSkippable`; the entry stays registered). Any other exit (a conflict main cannot survive,
  // failed merge/commit, closed PR, deleted ref) REFUSES the whole rebuild instead: the clone keeps its current
  // tree, and nothing on the overlay list changes (see REBUILD_MECHANISM_PATHS).
  const refusePinned = (ref, pr, sha, dropReason, why) => {
    const conflict = ['conflict', 'merge-tree-failed', 'commit-tree-failed'].includes(dropReason);
    return {
      ok: false,
      reason: conflict ? 'pinned-overlay-conflict' : 'pinned-overlay-unavailable',
      detail: {
        ref, pr, sha, dropReason, pinnedBy: why, message: conflict ? PINNED_OVERLAY_MESSAGE : PINNED_OVERLAY_GONE_MESSAGE,
      },
    };
  };

  for (const raw of toProcess) {
    const ref = raw?.ref;
    const pr = raw?.pr ?? null;

    // 1. PR state — MERGED/CLOSED means the overlay is moot; never call prState for a PR-less overlay.
    const state = pr != null && prState ? await prState(pr) : null;
    if (state === 'MERGED' || state === 'CLOSED') {
      if (state === 'CLOSED' && raw?.pinned === true) return refusePinned(ref, pr, null, 'pr-closed', 'flag');
      decisions.push({ ref, pr, action: 'remove', reason: state === 'MERGED' ? 'pr-merged' : 'pr-closed', sha: null });
      continue;
    }

    // 2. resolve the overlay ref's remote-tracking tip.
    const ovSha = verifyRev(git, `refs/remotes/origin/${ref}^{commit}`);
    if (!ovSha) {
      if (raw?.pinned === true) return refusePinned(ref, pr, null, 'ref-gone', 'flag');
      decisions.push({ ref, pr, action: 'remove', reason: 'ref-gone', sha: null });
      continue;
    }
    const dropOrRefuse = (reason) => {
      const p = pinnedStatus(git, raw, mainSha, ovSha);
      if (p.pinned) {
        // xpinskip — one conflicting pinned overlay must never freeze the fleet: when main already runs the
        // mechanism this overlay only changes, build WITHOUT it this pass (skip ≠ drop: it stays registered).
        const s = reason === 'conflict' ? pinnedConflictSkippable(git, mainSha, ovSha, p.why) : { skippable: false };
        if (s.skippable) {
          decisions.push({ ref, pr, action: 'skip', reason: 'pinned-overlay-conflict-skipped', sha: ovSha });
          alerts.push({
            kind: 'pinned-overlay-conflict-skipped',
            detail: {
              ref, pr, sha: ovSha, pinnedBy: p.why, mechanismPaths: s.paths,
              message: `pinned overlay ${ref}${pr != null ? ` (PR #${pr})` : ''} conflicts with main — building main + the other overlays without it; it stays registered and re-applies once its branch is rebased`,
            },
          });
          return null;
        }
        const refused = refusePinned(ref, pr, ovSha, reason, p.why);
        if (s.why) refused.detail.skipRefusedBecause = s.paths ? `${s.why}: ${s.paths.join(',')}` : s.why;
        return refused;
      }
      decisions.push({ ref, pr, action: 'drop', reason, sha: ovSha });
      return null;
    };

    // 3. already upstream-equivalent to main? (`git cherry` compares patch-ids; a failed cherry is treated as
    //    inconclusive — proceed to the merge-tree attempt rather than silently dropping a real overlay.)
    const cherry = git(['cherry', mainSha, ovSha]);
    if (cherry.status === 0) {
      const lines = String(cherry.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0 || lines.every((l) => l.startsWith('-'))) {
        decisions.push({ ref, pr, action: 'remove', reason: 'in-main', sha: ovSha });
        continue;
      }
    }

    // 4. merge-tree in the object DB — no working tree, no index.
    const mt = git(['merge-tree', '--write-tree', '--no-messages', cur, ovSha]);
    if (mt.status === 1) {
      const refused = dropOrRefuse('conflict');
      if (refused) return refused;
      continue;
    }
    if (mt.status !== 0) {
      const refused = dropOrRefuse('merge-tree-failed');
      if (refused) return refused;
      continue;
    }
    const tree = String(mt.stdout ?? '').split('\n')[0].trim();

    // 5. content already there (e.g. squash-merged) — cherry's patch-id compare can miss this; a direct tree
    //    compare against `cur` catches it regardless of history shape.
    const curTree = verifyRev(git, `${cur}^{tree}`);
    if (tree && curTree && tree === curTree) {
      decisions.push({ ref, pr, action: 'remove', reason: 'in-main', sha: ovSha });
      continue;
    }

    // 6. mint the merge commit — fixed identity, date = the later of the two parents' committer dates, so the
    //    same (cur, ovSha) pair always mints the identical sha (see file header — DETERMINISM).
    const committerDate = (sha) => {
      const r = git(['log', '-1', '--format=%ct', sha]);
      const n = Number(String(r.stdout ?? '').trim());
      return r.status === 0 && Number.isFinite(n) ? n : 0;
    };
    const dateUnix = Math.max(committerDate(cur), committerDate(ovSha));
    const dateStr = `@${dateUnix} +0000`;
    const message = `daemon-rebuild: merge overlay ${ref}${pr != null ? ` (PR #${pr})` : ''} onto ${cur}`;
    const ct = git(['commit-tree', tree, '-p', cur, '-p', ovSha, '-m', message], {
      env: { GIT_AUTHOR_DATE: dateStr, GIT_COMMITTER_DATE: dateStr },
    });
    const newSha = String(ct.stdout ?? '').trim();
    if (ct.status !== 0 || !newSha) {
      const refused = dropOrRefuse('commit-tree-failed');
      if (refused) return refused;
      continue;
    }
    cur = newSha;
    applied.push({ ref, pr, sha: ovSha });
    decisions.push({ ref, pr, action: 'apply', reason: 'applied', sha: ovSha });
  }

  const inputsKey = createHash('sha256')
    .update(JSON.stringify({ main: mainSha, overlays: applied.map((a) => [a.ref, a.sha]) }))
    .digest('hex')
    .slice(0, 16);

  return {
    ok: true, mainSha, finalSha: cur, applied, decisions, alerts, inputsKey, upToDate: cur === headSha,
  };
}

// ── findUnsafeLocalState — pure over an injected git(args) runner ──────────────────────────────────────────

/** `git ls-files --others --exclude-standard -z` — every untracked, non-ignored path in the tree, NUL-separated
 *  so a filename with an embedded newline can never split into two entries. A failed call returns `null`, which
 *  {@link findUnsafeLocalState} treats as `status-failed` (fail closed): without the list, the collision check
 *  before `reset --hard` could not protect an untracked file from being overwritten. */
function collectUntrackedPaths(git) {
  const r = git(['ls-files', '--others', '--exclude-standard', '-z']);
  if (r.status !== 0) return null;
  return String(r.stdout ?? '').split('\0').filter(Boolean);
}

/** Locked, post-fetch exception to untracked preservation: only main-proven birth identities. */
function pruneLandedBacklogSidecars({ git, root, paths, mainSha, alert }) {
  const candidates = paths.filter((path) => /^backlog\/[^/]+\.md$/.test(path)
    && isHash(idFromName(path.slice('backlog/'.length, -3))));
  if (!candidates.length) return;
  const failed = (detail) => alert('backlog-sidecar-prune-failed', { mainSha, ...detail });
  if (!mainSha) { failed({ error: 'Cannot resolve fetched main commit; retaining sidecars' }); return; }
  try {
    // Grep is only a blob prefilter, NEVER deletion evidence. Pin every read to this one commit.
    const hashes = [...new Set(candidates.map((path) => idFromName(path.slice(8, -3))))];
    const matches = git(['grep', '--no-textconv', '-l', '-z', '-F', ...hashes.flatMap((hash) => ['-e', hash]), mainSha, '--', 'backlog']);
    if (matches.status === 1) return;
    if (matches.status !== 0) throw new Error('Cannot search fetched main backlog blobs');
    const landed = new Map();
    for (const match of String(matches.stdout ?? '').split('\0').filter(Boolean)) {
      const path = match.slice(mainSha.length + 1);
      if (!match.startsWith(`${mainSha}:`) || !/^backlog\/[^/]+\.md$/.test(path)
        || !isNum(idFromName(path.slice(8, -3)))) continue;
      const blob = git(['show', `${mainSha}:${path}`]);
      if (blob.status !== 0) { failed({ landedPath: path, error: 'Cannot read landing evidence; retaining dependent sidecars' }); continue; }
      const content = String(blob.stdout ?? '');
      const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      if (!fm) continue;
      try {
        // Validate YAML as well as the scalar convention: duplicate keys, mismatched quotes,
        // malformed documents, aliases/merges and body examples cannot authorize unlinking.
        // gray-matter is loaded lazily (only when a landing blob is actually validated) so merely importing this
        // module never needs node_modules — throwaway script-tree clones (e.g. backlog.mjs CLI tests) have none.
        const data = createRequire(import.meta.url)('gray-matter')(fm[0]).data;
        const lines = fm[1].split(/\r?\n/).filter((line) => /^bornAs:/.test(line));
        if (lines.length !== 1 || !/^bornAs:[ \t]*(?:x[0-9a-z]{6}|'x[0-9a-z]{6}'|"x[0-9a-z]{6}")[ \t]*$/.test(lines[0])) continue;
        // Same scalar convention as backlog/frontmatter.mjs readField, after stricter validation.
        // Keep the editor/transition module out of the daemon's runtime dependency closure.
        const hash = lines[0].slice('bornAs:'.length).trim().replace(/^["']|["']$/g, '');
        if (isHash(hash) && data.bornAs === hash) landed.set(hash, path);
      } catch (error) { failed({ landedPath: path, error: `Invalid landing frontmatter: ${error.message}` }); }
    }
    for (const path of candidates) {
      const hash = idFromName(path.slice(8, -3));
      const landedPath = landed.get(hash);
      if (!landedPath) continue;
      try {
        const current = collectUntrackedPaths(git);
        if (current === null) throw new Error('Cannot recheck untracked membership; retaining sidecar');
        if (!current.includes(path)) continue;
        if (!lstatSync(join(root, 'backlog')).isDirectory() || !lstatSync(join(root, path)).isFile()) continue;
        unlinkSync(join(root, path));
        alert('backlog-sidecar-pruned', { path, hash, landedPath, mainSha });
      } catch (error) {
        if (error.code !== 'ENOENT') failed({ path, hash, landedPath, error: String(error.message || error) });
      }
    }
  } catch (error) { failed({ error: String(error.message || error) }); }
}

/**
 * PURE: is `root`'s current tree safe for {@link rebuildClone} to move with `git reset --hard`? Fail-closed at
 * every read — an unreadable `status` refuses outright, since we cannot then trust anything else. Precedence
 * (spec doesn't state one explicitly; chosen so a genuine `status`-read failure always dominates, and a live
 * `MERGE_HEAD` — which itself also shows up as "dirty" porcelain output — is reported as the MORE specific
 * `merge-in-progress` rather than the generic `dirty`): `status-failed` > `merge-in-progress` > `dirty` >
 * `local-commits` > safe.
 *
 * UNTRACKED FILES ARE NEVER PART OF THIS SAFETY VERDICT. `git reset --hard` moves tracked content only and
 * never deletes an untracked, non-ignored file sitting in the working tree (`git clean` does that, and this
 * module never calls it — see file header), so the dirty-tree check below reads `--untracked-files=no`: an
 * untracked file must never by itself freeze a rebuild (2026-09-24 freeze: a live daemon clone read as
 * permanently dirty because of an untracked `.conveyor/unsupported-repo.json` sidecar its own process had just
 * written). Every untracked, non-ignored path ({@link collectUntrackedPaths}) is still collected and returned
 * as `untracked` on EVERY result (safe or not) — {@link doRebuild} uses it, after the plan is computed and
 * just before its one `reset --hard`, to refuse with `untracked-collision` if the incoming tree actually has
 * content at one of those paths (the one case a `reset --hard` WOULD silently overwrite something); every
 * other kept untracked path is only reported (`untracked-kept`). The sole deletion exception is a
 * provisional backlog sidecar proven landed on fetched main, pruned under the write lock before planning.
 * @param {{git:(args:string[])=>{status:number,stdout:string,stderr:string}}} o
 * @returns {{safe:boolean, reason?:string, detail?:Array<string>|string, untracked:Array<string>}}
 */
export function findUnsafeLocalState({ git, knownInputs = [] }) {
  const listed = collectUntrackedPaths(git);
  if (listed === null) return { safe: false, reason: 'status-failed', detail: 'ls-files --others failed', untracked: [] };
  const untracked = listed;

  const status = git(['status', '--porcelain', '--untracked-files=no']);
  if (status.status !== 0) return { safe: false, reason: 'status-failed', untracked };

  const mergeHead = git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (mergeHead.status === 0 && String(mergeHead.stdout ?? '').trim()) {
    return { safe: false, reason: 'merge-in-progress', untracked };
  }

  const dirtyOut = String(status.stdout ?? '').trim();
  if (dirtyOut) {
    return {
      safe: false, reason: 'dirty', detail: dirtyOut.split('\n').map((l) => l.trim()).filter(Boolean), untracked,
    };
  }

  // `knownInputs`: shas this clone was previously BUILT from (the last adopted head + its overlay tips). An
  // overlay whose origin branch was deleted after its PR merged (squash) leaves its commits reachable from HEAD
  // but from no remote ref — they are past inputs, not local work, and must never freeze the rebuild. Only
  // shas that actually exist locally are passed (an unknown sha would make rev-list fail => status-failed).
  const known = knownInputs.filter((sha) => typeof sha === 'string' && /^[0-9a-f]{7,64}$/.test(sha)
    && git(['cat-file', '-e', `${sha}^{commit}`]).status === 0);
  const revList = git(['rev-list', '--no-merges', 'HEAD', '--not', '--remotes=origin', ...known]);
  if (revList.status !== 0) {
    return {
      safe: false, reason: 'status-failed', detail: 'rev-list --no-merges failed', untracked,
    };
  }
  const localShas = String(revList.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (localShas.length === 0) return { safe: true, untracked };

  // Drop any that are upstream-equivalent (same patch already on origin/main under a different sha, e.g.
  // rebased-and-pushed-elsewhere) — a failed cherry is fail-closed the OTHER way here: keep every candidate
  // rather than risk silently clearing a real local commit off the unsafe list.
  const cherry = git(['cherry', 'origin/main', 'HEAD']);
  let remaining = localShas;
  if (cherry.status === 0) {
    const equivalent = new Set(
      String(cherry.stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('-'))
        .map((l) => l.slice(1).trim()),
    );
    remaining = localShas.filter((sha) => !equivalent.has(sha));
  }
  if (remaining.length === 0) return { safe: true, untracked };
  return {
    safe: false, reason: 'local-commits', detail: remaining, untracked,
  };
}

// ── daemon runtime state that lands in TRACKED files — carried out of the tree, never a freeze ─────────────

// {@link daemonConveyorStateRoot} now lives in `./daemon-last-good.mjs` (imported above, import-light — see
// that file's own header) and is re-exported here UNCHANGED, so every existing importer of it from THIS file
// (`run-scorecard-store.mjs`, this file's own use below) sees no change; `health-watch-section.mjs` imports it
// straight from `daemon-last-good.mjs` instead, so pulling in the health watch's state-root resolution never
// drags in this file's much heavier build/smoke/child_process import graph (#4077 live regression: it broke
// the operator-queue CLI entry guard's symlink tests — see that fix's own commit).
export { daemonConveyorStateRoot };

/**
 * Is `root` a daemon-managed clone — one the rebuild moves with `reset --hard`? True once it has a rebuild
 * state file or a registered overlay list (both keyed on the same `cloneKey`). A plain checkout or lane has
 * neither. Never throws.
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isDaemonManagedClone(root, env = process.env) {
  try {
    return existsSync(rebuildStatePath(root, env)) || existsSync(overlayFilePath(root, env));
  } catch {
    return false;
  }
}

/**
 * TRACKED files a daemon process (or a session it dispatched) appends runtime state to. A write there must
 * never freeze the rebuild: 2026-09-25 13:36 ET, a review session's scorecard row left
 * `scripts/conveyor/run-scorecards.json` modified in the review-daemon clone, the rebuild refused it as
 * `dirty`, the clone fell 10 commits behind, and every review and fix dispatch refused as STALE. So the
 * rebuild carries each such file's rows into {@link daemonConveyorStateRoot} (a union — no row is lost, none
 * is duplicated), restores the tracked copy, and proceeds. `pinned` is the path under that root; the store
 * module itself (`run-scorecard-store.mjs#resolveScorecardStorePath`) writes to the same place in a daemon
 * clone, so this is the recovery path for rows written by older code, not the normal one. Since #4155 the file
 * is no longer tracked at all and the store writes out-of-tree from every checkout; this entry stays for the one
 * window that still matters — a clone whose tracked copy an OLD-code process modified before the untracking
 * commit reached it: the carry restores it to HEAD so the rebuild can move onto the commit that deletes it.
 */
export const DAEMON_STATE_FILES = Object.freeze([
  Object.freeze({ path: 'scripts/conveyor/run-scorecards.json', pinned: '.conveyor/run-scorecards.json' }),
]);

/** `{version, records:[]}` from JSON text; `null` when it is not that shape (never guessed). */
function parseRecordsStore(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.records)) return null;
    // `migrations` (run-scorecard-store.mjs's one-time-migration stamps, #4155) rides along so a carry never
    // strips them and re-arms a migration that already ran.
    return Array.isArray(parsed.migrations)
      ? { version: parsed.version ?? 1, records: parsed.records, migrations: parsed.migrations }
      : { version: parsed.version ?? 1, records: parsed.records };
  } catch {
    return null;
  }
}

/**
 * The dirty paths in `git status --porcelain` lines, or `null` when any line is not a plain modification
 * (a rename, a delete, a conflict — nothing this module should carry away on its own).
 * @param {Array<string>} lines - trimmed porcelain lines, as {@link findUnsafeLocalState} reports them
 */
function modifiedPathsOf(lines) {
  const paths = [];
  for (const line of lines) {
    const m = /^(M{1,2})\s+(.+)$/.exec(line);
    if (!m) return null;
    paths.push(m[2].trim());
  }
  return paths;
}

/** PURE: only the two claim-owned top-level keys may differ; the body is byte-preserved. */
export function isClaimStampOnlyEdit(headText, workText) {
  const parse = (text) => {
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!fm) return null;
    const lines = fm[1].split(/\r?\n/);
    const statuses = lines.filter((line) => /^status:/.test(line));
    if (statuses.length !== 1) return null;
    const status = /^status:[ \t]*(open|active|preparing)[ \t]*$/.exec(statuses[0])?.[1];
    return {
      status,
      rest: lines.filter((line) => !/^(status|dateStarted):/.test(line)).join('\n'),
      body: text.slice(fm[0].length),
    };
  };
  const head = parse(headText);
  const work = parse(workText);
  return !!head && !!work && head.status === 'open'
    && ['active', 'preparing'].includes(work.status)
    && head.rest === work.rest && head.body === work.body;
}

/** Validate every non-state path before restoring any claim stamp. A concurrent write fails closed. */
export function restoreStrayClaimStamps({ git, root, dirty, fs = { read: (p) => readFileSync(p, 'utf8') } }) {
  const restored = [];
  const fail = (reason) => ({ ok: false, reason, restored });
  const paths = modifiedPathsOf(dirty || []);
  if (!paths?.length) return fail('not-claim-stamps');
  const known = new Set(DAEMON_STATE_FILES.map((entry) => entry.path));
  const backlog = paths.filter((path) => !known.has(path));
  if (!backlog.every((path) => /^backlog\/[^/]+\.md$/.test(path))) return fail('not-claim-stamps');
  const checked = [];
  for (const path of backlog) {
    const head = git(['show', `HEAD:${path}`]);
    if (head.status !== 0) return fail('head-unreadable');
    let text;
    try { text = fs.read(join(root, path)); } catch { return fail('file-busy'); }
    if (!isClaimStampOnlyEdit(String(head.stdout ?? ''), text)) return fail('not-claim-stamps');
    checked.push({ path, text });
  }
  for (const { path, text } of checked) {
    const diff = git(['diff', 'HEAD', '--', path]);
    if (diff.status !== 0) return fail('restore-failed');
    try {
      if (fs.read(join(root, path)) !== text) return fail('file-busy');
    } catch { return fail('file-busy'); }
    if (git(['checkout', 'HEAD', '--', path]).status !== 0) return fail('restore-failed');
    restored.push({ path, diff: String(diff.stdout ?? '') });
  }
  return { ok: true, restored };
}

/**
 * PURE over `git` + injected fs: when EVERY dirty path is a known {@link DAEMON_STATE_FILES} entry, union each
 * one's rows into its pinned file, then restore the tracked copy (`checkout HEAD -- <path>`). Any other dirt,
 * an unparsable file, or a failed write/restore migrates nothing it cannot prove and returns `ok:false` — the
 * caller then refuses as `dirty`, exactly as before.
 * @param {{git:Function, root:string, dirty:Array<string>, env?:NodeJS.ProcessEnv,
 *   fs?:{read:(p:string)=>string, write:(p:string, s:string)=>void, exists:(p:string)=>boolean}}} o
 * @returns {{ok:boolean, reason?:string, migrated:Array<{path:string, target:string, added:number, total:number}>}}
 */
export function migrateDaemonStateFiles({ git, root, dirty, env = process.env, fs: io }) {
  const fs = io ?? {
    read: (p) => readFileSync(p, 'utf8'),
    write: (p, s) => {
      mkdirSync(dirname(p), { recursive: true });
      const tmp = `${p}.tmp-${process.pid}`;
      writeFileSync(tmp, s, 'utf8');
      renameSync(tmp, p);
    },
    exists: (p) => existsSync(p),
  };
  const paths = modifiedPathsOf(dirty || []);
  if (!paths || paths.length === 0) return { ok: false, reason: 'not-state-files', migrated: [] };
  const known = new Map(DAEMON_STATE_FILES.map((f) => [f.path, f]));
  if (!paths.every((p) => known.has(p))) return { ok: false, reason: 'not-state-files', migrated: [] };

  const migrated = [];
  for (const p of paths) {
    const target = join(daemonConveyorStateRoot(env), known.get(p).pinned);
    // Re-read until the tracked copy is stable across the merge, so a row appended mid-migration is not lost.
    let carried = false;
    for (let attempt = 0; attempt < 3 && !carried; attempt += 1) {
      let text;
      try { text = fs.read(join(root, p)); } catch { return { ok: false, reason: 'state-file-unreadable', migrated }; }
      const working = parseRecordsStore(text);
      if (!working) return { ok: false, reason: 'state-file-unparsable', migrated };
      let pinned = { version: working.version, records: [] };
      if (fs.exists(target)) {
        let pinnedText;
        try { pinnedText = fs.read(target); } catch { return { ok: false, reason: 'pinned-unreadable', migrated }; }
        pinned = parseRecordsStore(pinnedText);
        // Never overwrite a pinned store we cannot read — that would destroy the rows already there.
        if (!pinned) return { ok: false, reason: 'pinned-unparsable', migrated };
      }
      const seen = new Set(pinned.records.map((r) => JSON.stringify(r)));
      const add = working.records.filter((r) => !seen.has(JSON.stringify(r)));
      if (add.length > 0) {
        try {
          fs.write(target, `${JSON.stringify({ ...pinned, version: pinned.version ?? 1, records: [...pinned.records, ...add] }, null, 2)}\n`);
        } catch { return { ok: false, reason: 'pinned-write-failed', migrated }; }
      }
      let after;
      try { after = fs.read(join(root, p)); } catch { after = null; }
      if (after !== text) continue;
      const restore = git(['checkout', 'HEAD', '--', p]);
      if (restore.status !== 0) return { ok: false, reason: 'restore-failed', migrated };
      migrated.push({ path: p, target, added: add.length, total: pinned.records.length + add.length });
      carried = true;
    }
    if (!carried) return { ok: false, reason: 'state-file-busy', migrated };
  }
  return { ok: true, migrated };
}

// ── fetch helper shared by rebuildClone and dryRunRebuild ───────────────────────────────────────────────────

/** Fetch `origin/main` + every (safe-named) overlay ref via explicit refspecs. A batched fetch failure refetches
 *  `main` alone; if THAT also fails the caller gets `{ok:false, reason:'fetch-failed'}` (transient — main itself
 *  is unreachable). Otherwise each overlay ref is fetched individually and a failure there is `ref-gone` (its
 *  stale remote-tracking ref is deleted so a later `--not --remotes=origin`/`refs/remotes/origin/<ref>` read
 *  never sees stale data for it). */
function fetchMainAndOverlays({ git, overlays }) {
  const safeOverlays = overlays.filter((o) => isSafeBranchName(o?.ref));
  const refspecs = [
    '+refs/heads/main:refs/remotes/origin/main',
    ...safeOverlays.map((o) => `+refs/heads/${o.ref}:refs/remotes/origin/${o.ref}`),
  ];
  const batch = git(['fetch', '--quiet', '--prune', 'origin', ...refspecs]);
  if (batch.status === 0) return { ok: true, goneRefs: [] };

  const mainOnlyFetch = git(['fetch', '--quiet', '--prune', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  if (mainOnlyFetch.status !== 0) return { ok: false, reason: 'fetch-failed' };

  const goneRefs = [];
  for (const o of safeOverlays) {
    const one = git(['fetch', '--quiet', 'origin', `+refs/heads/${o.ref}:refs/remotes/origin/${o.ref}`]);
    if (one.status !== 0) {
      git(['update-ref', '-d', `refs/remotes/origin/${o.ref}`]);
      goneRefs.push(o.ref);
    }
  }
  return { ok: true, goneRefs };
}

// ── per-clone rebuild state (outside the git tree, per clause 3(iii) — same posture as daemon-overlays.mjs) ──

/** Env var pinning the rebuild-state root outside any git tree. */
export const WE_DAEMON_STATE_DIR_ENV = 'WE_DAEMON_STATE_DIR';

function stateDir(env = process.env) {
  // One definition, shared with the staleness guard's last-good read (x5wbsbc) — never two spellings.
  return daemonStateDir(env);
}

/** `<stateDir>/<cloneKey>.rebuild.json` — reuses `daemon-overlays.mjs#cloneKey` so every per-clone state file
 *  (overlay list, rebuild state) keys on the SAME identity, never re-derived.
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function rebuildStatePath(root, env = process.env) {
  return join(stateDir(env), `${cloneKey(root)}.rebuild.json`);
}

function alertsFilePath(root, env = process.env) {
  return join(stateDir(env), `${cloneKey(root)}.alerts.jsonl`);
}

const EMPTY_STATE = Object.freeze({
  adopted: null, rejected: null, inProgress: null, quarantine: null, unverified: null, building: null, held: null, busySkippedTrees: null,
});

/**
 * Read the per-clone rebuild state, never throwing — a missing or corrupt file reads as the empty state (fail
 * closed to "nothing adopted, nothing rejected, nothing in progress", never a crash).
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{adopted:object|null, rejected:object|null, inProgress:object|null, quarantine:object|null,
 *   unverified:{head:string, prevHead:string}|null, building:object|null}}
 */
export function readRebuildState(root, env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(rebuildStatePath(root, env), 'utf8'));
    return {
      adopted: parsed?.adopted ?? null,
      rejected: parsed?.rejected ?? null,
      inProgress: parsed?.inProgress ?? null,
      quarantine: parsed?.quarantine ?? null,
      unverified: parsed?.unverified ?? null,
      building: parsed?.building ?? null,
      held: parsed?.held ?? null,
      busySkippedTrees: parsed?.busySkippedTrees ?? null,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

/** Atomic write — `<file>.tmp-<pid>` then `renameSync`, same posture as `daemon-overlays.mjs#writeOverlays`. */
function writeRebuildState(root, state, env = process.env) {
  const file = rebuildStatePath(root, env);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, file);
}

// ── ready candidate — a PASSED smoke that could not be adopted yet (fix-rebuild-finalize) ─────────────────────
//
// Live 2026-09-26 on `wev-review-daemon`: a candidate passed its ~1-4 min off-lock smoke, then `finalizeRebuild`
// could not take the write lock within 60s because the SIBLING daemon had started a tick (read slot) during the
// smoke. The pass was thrown away; the next tick re-planned (main had moved — a new sha), re-smoked, and the
// sibling started another tick during THAT smoke. The build lease it left behind also made the sibling log
// `rebuild-in-progress` for up to 20 min. Registered overlay fixes were never adopted.
//
// Fix: a passing smoke is recorded here (`<cloneKey>.ready.json`, atomic rename, outside the git tree) BEFORE the
// finalize lock is attempted. Whichever process next holds the write lock — the mover itself on a later tick, or a
// SIBLING at its own tick start (a tick boundary: it holds no read slot then) — adopts it in `prepareRebuild`
// without re-smoking, as long as it was verified on top of the clone's CURRENT head. Written without the clone
// lock on purpose: only a build-lease holder writes it, the record fully describes itself, and every use of it
// re-checks it against the live HEAD under the write lock.

/** `<stateDir>/<cloneKey>.ready.json`. */
export function readyCandidatePath(root, env = process.env) {
  return join(stateDir(env), `${cloneKey(root)}.ready.json`);
}

/** The recorded ready candidate, or `null` (missing/corrupt reads as none — never throws). */
export function readReadyCandidate(root, env = process.env) {
  try {
    const r = JSON.parse(readFileSync(readyCandidatePath(root, env), 'utf8'));
    return r && typeof r === 'object' && r.adopt?.finalSha && r.prevHead ? r : null;
  } catch {
    return null;
  }
}

function writeReadyCandidate(root, record, env = process.env) {
  try {
    const file = readyCandidatePath(root, env);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

function clearReadyCandidate(root, env = process.env) {
  try { unlinkSync(readyCandidatePath(root, env)); } catch { /* already gone */ }
}

/**
 * PURE: may the ready candidate `ready` be adopted now, instead of smoking `plan`? Returns
 * `{adopt, dropRefs, match}` or `{adopt:null, reason}`. Only ever a candidate verified on top of `prevHead` (the
 * clone's current head — its smoke skipped checks relative to that head, and it is a strict step forward from it).
 *   - `fallback` (plain main passed after main+overlays failed): only for the SAME failing inputs (`forInputsKey`);
 *     adopting it also drops the suspect overlays, exactly as the original finalize would have.
 *   - `candidate`: the same sha (`exact`); a different sha whose TREE is identical — overlay-list churn that does
 *     not change a single file (`same-tree`, adopts the current plan's commit); or an older build the plan has
 *     since moved past (`superseded`, adopts the verified build — still newer than HEAD; the newer plan is smoked
 *     on a later tick), but only while every overlay it carries is still registered or has landed on main, so an
 *     overlay the operator removed is never brought back.
 *   - `fallback-main-moved`: a passed fallback whose failing inputs moved ONLY because main advanced — every
 *     suspect that is still registered is still at the sha that failed (`overlayTip`) — is adopted anyway and
 *     still drops the suspects, exactly as its own finalize would have.
 * Every record whose commit is NOT re-derived from the live `plan` (`superseded`, both fallback forms) must also
 * pass `verifyBuilt` — the record is read from disk, so its `finalSha` is only trusted once it provably is a build
 * this module could have minted from the current main history and the registered overlay refs
 * ({@link readyBuildVerified}). Refuses by default.
 * @param {{ready:object|null, plan:object, prevHead:string, treeOf:(sha:string)=>string|null,
 *   stillWanted:(ref:string)=>boolean, verifyBuilt?:(adopt:object)=>boolean,
 *   overlayTip?:(ref:string)=>string|null, registered?:(ref:string)=>boolean, allowFallback?:boolean,
 *   rejected?:object|null, nowMs:number, maxAgeMs:number}} o — `registered`: still on the overlay list after this
 *   tick's own edits (defaults to `stillWanted`); `allowFallback: false` (a mainOnly rebuild) refuses any fallback.
 */
export function matchReadyCandidate({
  ready, plan, prevHead, treeOf, stillWanted, verifyBuilt = () => false, overlayTip = () => null,
  registered = stillWanted, allowFallback = true, rejected = null, nowMs, maxAgeMs,
}) {
  if (!ready) return { adopt: null, reason: 'none' };
  const passedMs = Date.parse(ready.passedAt || '');
  if (!Number.isFinite(passedMs) || nowMs - passedMs > maxAgeMs) return { adopt: null, reason: 'expired' };
  if (ready.prevHead !== prevHead) return { adopt: null, reason: 'other-base' };
  if (ready.adopt.finalSha === prevHead && ready.kind !== 'fallback') return { adopt: null, reason: 'already-head' };
  if (rejected && rejected.inputsKey === ready.adopt.inputsKey && Date.parse(rejected.at || '') > passedMs) {
    return { adopt: null, reason: 'rejected-since' };
  }
  const carriesOnlyWanted = (ready.adopt.applied || []).every((a) => stillWanted(a.ref));
  if (ready.kind === 'fallback') {
    if (!allowFallback) return { adopt: null, reason: 'fallback-not-allowed' };
    if (!carriesOnlyWanted) return { adopt: null, reason: 'overlay-no-longer-wanted' };
    if (!verifyBuilt(ready.adopt)) return { adopt: null, reason: 'unverified-build' };
    if (plan.inputsKey === ready.forInputsKey) {
      return { adopt: ready.adopt, dropRefs: ready.dropRefs || [], failed: ready.failed || '', match: 'fallback' };
    }
    // Main moved: only suspects still registered matter (one that already left needs no drop, and no alert).
    const dropRefs = (ready.dropRefs || []).filter((s) => registered(s.ref));
    const suspectMoved = dropRefs.some((s) => !s.sha || overlayTip(s.ref) !== s.sha);
    return suspectMoved
      ? { adopt: null, reason: 'fallback-inputs-moved' }
      : { adopt: ready.adopt, dropRefs, failed: ready.failed || '', match: 'fallback-main-moved' };
  }
  if (plan.finalSha === ready.adopt.finalSha) return { adopt: ready.adopt, dropRefs: [], match: 'exact' };
  const planTree = treeOf(plan.finalSha);
  if (planTree && ready.tree && planTree === ready.tree) {
    const adopt = {
      finalSha: plan.finalSha, inputsKey: plan.inputsKey, mainSha: plan.mainSha, applied: plan.applied,
    };
    return { adopt, dropRefs: [], match: 'same-tree' };
  }
  if (!carriesOnlyWanted) return { adopt: null, reason: 'overlay-no-longer-wanted' };
  if (!verifyBuilt(ready.adopt)) return { adopt: null, reason: 'unverified-build' };
  return { adopt: ready.adopt, dropRefs: [], match: 'superseded' };
}

/**
 * Is a ready record's `adopt` provably a build {@link planRebuild} could have minted — never an arbitrary commit
 * someone wrote into the state file? All of: its `mainSha` is on the current main history (an ancestor of, or
 * equal to, `mainTip`); walking back from `finalSha`, each carried overlay is exactly one merge commit whose
 * parents are `[previous step, overlay sha]`, bottoming out at `mainSha` (so an overlay-free record must BE
 * `mainSha`); and every carried overlay sha is on its registered ref's current remote-tracking tip. Any git
 * failure reads as unverified — the caller then just smokes the live plan instead.
 * @param {{git:(args:string[])=>{status:number|null, stdout?:string}, adopt:object, mainTip:string}} o
 */
export function readyBuildVerified({
  git, adopt, mainTip, prevHead,
}) {
  const isAncestor = (a, b) => git(['merge-base', '--is-ancestor', a, b]).status === 0;
  if (!adopt?.finalSha || !adopt.mainSha || !mainTip || !isAncestor(adopt.mainSha, mainTip)) return false;
  // Never a rollback: the record's main must be at or past the main the current head was built on.
  const headBase = prevHead ? String(git(['merge-base', prevHead, mainTip]).stdout ?? '').trim() : '';
  if (!headBase || !isAncestor(headBase, adopt.mainSha)) return false;
  const applied = Array.isArray(adopt.applied) ? adopt.applied : [];
  let cur = adopt.finalSha;
  for (let i = applied.length - 1; i >= 0; i -= 1) {
    const a = applied[i];
    if (!a?.ref || !a.sha) return false;
    const r = git(['rev-list', '--parents', '-n', '1', cur]);
    if (r.status !== 0) return false;
    const [self, prev, ov, ...extra] = String(r.stdout ?? '').trim().split(/\s+/);
    if (!self || !prev || ov !== a.sha || extra.length > 0) return false;
    // The overlay sha is still on its ref — or, once the branch is gone (merged + auto-deleted), on main.
    const tip = verifyRev(git, `refs/remotes/origin/${a.ref}^{commit}`);
    if (tip ? !isAncestor(a.sha, tip) : !isAncestor(a.sha, mainTip)) return false;
    // The merge's tree is exactly what planRebuild mints for (prev, overlay) — never an arbitrary tree.
    const mt = git(['merge-tree', '--write-tree', '--no-messages', prev, a.sha]);
    const minted = mt.status === 0 ? String(mt.stdout ?? '').split('\n')[0].trim() : '';
    if (!minted || minted !== verifyRev(git, `${cur}^{tree}`)) return false;
    cur = prev;
  }
  return verifyRev(git, `${cur}^{commit}`) === adopt.mainSha;
}

/** Drop the suspect overlays a passing plain-main fallback proved bad (shared by the direct finalize and by a
 *  later adoption of the same fallback from its ready record). */
function dropSuspectOverlays({
  root, env, suspects, failed, alert,
}) {
  for (const s of suspects) {
    removeOverlay(root, s.ref, { env, why: 'smoke-failed' });
    appendOverlayEvent(root, {
      kind: 'dropped-smoke-failed', ref: s.ref, pr: s.pr, reason: failed,
    }, { env });
    alert('overlay-dropped-smoke-failed', {
      ref: s.ref, pr: s.pr, failed, suspects: suspects.length,
      message: suspects.length > 1
        ? 'dropped as one of several suspects — plain main passed without them; re-add the good ones'
        : 'plain main passed without this overlay — it broke the live smoke; fix it, then re-add it',
    });
  }
}

// ── defaultPrState — the CLI's real PR-state lookup ─────────────────────────────────────────────────────────

function slugFromOriginUrl(url) {
  const m = String(url || '').trim().match(/github\.com[:/]+([^/]+)\/([^/.]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Real-world `prState`: `gh pr view <n> --repo <slug from origin's url> --json state -q .state`, 20s timeout.
 * ANY failure (no `gh`, no auth, unresolvable slug, timeout) reads as `null` — unknown, and {@link planRebuild}
 * never removes an overlay on an unknown PR state, only on a confirmed MERGED/CLOSED.
 * @param {{pr:number, root:string}} o
 * @returns {string|null}
 */
export function defaultPrState({ pr, root }) {
  if (pr == null) return null;
  try {
    const urlRes = spawnSync('git', ['remote', 'get-url', 'origin'], {
      cwd: root, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
    });
    const slug = urlRes.status === 0 ? slugFromOriginUrl(urlRes.stdout) : null;
    if (!slug) return null;
    const ghRes = spawnSync('gh', ['pr', 'view', String(pr), '--repo', slug, '--json', 'state', '-q', '.state'], {
      encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
    });
    if (ghRes.status !== 0) return null;
    const out = String(ghRes.stdout || '').trim();
    return out || null;
  } catch {
    return null;
  }
}

// ── smoke-rejection helpers ────────────────────────────────────────────────────────────────────────────────

/** Did only EXTERNAL checks fail? Every failed row is one `daemon-live-smoke.mjs#SMOKE_CHECKS` marks
 *  `mayBeTransient` (it runs `gh`, not code from the tree under test). An empty list is not external-only. */
export function isExternalOnlyFailure(failed) {
  return Array.isArray(failed) && failed.length > 0 && failed.every((r) => r && r.mayBeTransient !== false);
}

/** How long a tick-start rebuild waits for other daemons' ticks (read slots) to drain — env-tunable, see rebuildClone. */
export const REBUILD_LOCK_WAIT_ENV = 'WE_DAEMON_REBUILD_LOCK_WAIT_MS';
export const DEFAULT_REBUILD_LOCK_WAIT_MS = 60_000;

/** How long the write-lock wait is once a candidate has PASSED its smoke (or a passed candidate is waiting to be
 *  adopted) — longer than {@link DEFAULT_REBUILD_LOCK_WAIT_MS}: a passing smoke is expensive to redo, and while
 *  this process waits, the writer reservation already refuses every NEW read slot, so the wait is bounded by the
 *  readers' in-flight ticks, never by a fresh one. Env-tunable. */
export const FINALIZE_LOCK_WAIT_ENV = 'WE_DAEMON_FINALIZE_LOCK_WAIT_MS';
export const DEFAULT_FINALIZE_LOCK_WAIT_MS = 180_000;

/** A passed-but-not-yet-adopted candidate older than this is ignored (its smoke is no longer fresh evidence). */
export const READY_MAX_AGE_ENV = 'WE_DAEMON_READY_MAX_AGE_MS';
export const DEFAULT_READY_MAX_AGE_MS = 2 * 60 * 60_000;

/** A live smoke at least this long raises a `smoke-slow` alert — informational only (xa4qo7n): the smoke runs
 *  against a disposable candidate worktree and holds NO lock, so a slow one no longer starves any daemon's
 *  ticks the way it did before this fix; it is still worth knowing about (it delays adopting new code). */
export const SLOW_SMOKE_ALERT_MS = 60_000;

/** Backoff before an external-only rejection is re-smoked: base * 2^(attempts-1), capped. Env-tunable. */
export function rejectRetryDelayMs(env, attempts) {
  const base = Number(env?.WE_DAEMON_REJECT_RETRY_BASE_MS) || 5 * 60_000;
  const max = Number(env?.WE_DAEMON_REJECT_RETRY_MAX_MS) || 60 * 60_000;
  return Math.min(base * 2 ** Math.max(0, attempts - 1), max);
}

// ── LOAD-shaped smoke failures: blamed on an overlay only through a same-run differential (live 2026-10-04) ──
// wev-control, 16:02Z and 16:26Z: candidate A (main + PR #3903) failed `lane-acquire-release` with lane-pool's own
// "(lock contention)" refusal and `dispatch-dry-run` with "timed out after 45000ms". Plain main, smoked minutes
// later once the contention had cleared, passed — so the healthy overlay was dropped, twice. Plain main fails the
// same checks under the same load. A failure whose every row is load-shaped (ran out of time on the gate's own
// clock, another caller's lock, or external transient noise) is therefore NOT evidence against an overlay by
// itself: after plain main passes, A is smoked AGAIN in the same run. A passes ⇒ adopt A (overlay kept). A
// reproduces a CODE-shaped failure on a check it failed before ⇒ genuine, drop as before. Anything else ⇒
// environment (`smoke-env-load`): never drop, retry A with backoff. No laundering: an env-load verdict never
// ADOPTS A — only a clean A pass does.

/** Default ON: when last-good fails every check the candidate failed, adopt the candidate as no worse.
 *  A harness fix that lives in the candidate can only ever arrive this way when the running harness also
 *  fails last-good. Set to '0' to retain the hold-on-last-good and retry-backoff behavior. */
export const HARNESS_BROKEN_ADOPT_NOT_WORSE_ENV = 'WE_DAEMON_HARNESS_BROKEN_ADOPT_NOT_WORSE';

/** Knob: `0` turns the load differential off (back to one plain-main comparison). Default on. */
export const SMOKE_LOAD_DIFFERENTIAL_ENV = 'WE_DAEMON_SMOKE_LOAD_DIFFERENTIAL';
/** Knobs: backoff before an env-load-held candidate is re-smoked — base * 2^(attempts-1), capped. */
export const ENV_LOAD_RETRY_BASE_ENV = 'WE_DAEMON_ENV_LOAD_RETRY_BASE_MS';
export const ENV_LOAD_RETRY_MAX_ENV = 'WE_DAEMON_ENV_LOAD_RETRY_MAX_MS';
export const DEFAULT_ENV_LOAD_RETRY_BASE_MS = 5 * 60_000;
export const DEFAULT_ENV_LOAD_RETRY_MAX_MS = 60 * 60_000;
/** Another caller's lane-pool lock, never the tree under test. */
export const LOAD_CONTENTION_SIGNATURES = Object.freeze([
  /\(lock contention\)/,
  /gave up waiting for the shared acquirability-scan lock/,
]);

export function loadDifferentialEnabled(env) {
  return String(env?.[SMOKE_LOAD_DIFFERENTIAL_ENV] ?? '').trim() !== '0';
}

export function envLoadRetryDelayMs(env, attempts) {
  const base = Number(env?.[ENV_LOAD_RETRY_BASE_ENV]) > 0 ? Number(env[ENV_LOAD_RETRY_BASE_ENV]) : DEFAULT_ENV_LOAD_RETRY_BASE_MS;
  const max = Number(env?.[ENV_LOAD_RETRY_MAX_ENV]) > 0 ? Number(env[ENV_LOAD_RETRY_MAX_ENV]) : DEFAULT_ENV_LOAD_RETRY_MAX_MS;
  return Math.min(base * 2 ** Math.max(0, attempts - 1), max);
}

/** PURE: is this failed smoke row explained by host load (time-out on the gate's clock, lock contention, or
 *  external transient noise from a check allowed to be transient)? */
export function isLoadShapedRow(row, env = {}) {
  if (!row || row.ok) return false;
  const minElapsedMs = Number(env?.[SMOKE_ENV_TIMEOUT_MIN_ELAPSED_MS_ENV]) > 0
    ? Number(env[SMOKE_ENV_TIMEOUT_MIN_ELAPSED_MS_ENV]) : DEFAULT_ENV_TIMEOUT_MIN_ELAPSED_MS;
  if (isEnvTimeoutRow(row, { minElapsedMs })) return true;
  const detail = String(row.detail ?? '');
  if (LOAD_CONTENTION_SIGNATURES.some((re) => re.test(detail))) return true;
  return row.mayBeTransient !== false && TRANSIENT_FAILURE_PATTERNS.some((re) => re.test(detail));
}

/** A failed check's detail, safe for the alerts log: tokens redacted, one bounded line. */
function redactDetail(detail) {
  return String(detail ?? '').replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '$1<redacted>').slice(0, 500);
}

// ── candidate worktree (xa4qo7n) — where the live smoke actually runs, never `root` ─────────────────────────

/**
 * Per-ATTEMPT staging path for the candidate worktree the live smoke runs against — OUTSIDE any git tree, same
 * `stateDir`/`cloneKey` convention as every other per-clone sidecar this module owns, suffixed with the build
 * lease's own `token` (see {@link claimBuildLease}). PR #2731 review: this used to be ONE fixed path per clone,
 * and two sibling daemons rebuilding the same clone at once force-removed each other's worktree mid-smoke. The
 * single-flight lease already stops two builds overlapping; a unique path means an aged-lease takeover builds
 * beside, never on top of, a tree a slow attempt may still be reading. A crashed attempt's leftover is found
 * through the lease record it left behind (`state.building.path`) and torn down by whoever takes the lease over
 * next — only once its owner is provably gone (see {@link leaseOwnerIsGone}).
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [token] - the build lease's token (default: a fresh random one, never a shared fixed path).
 * @returns {string}
 */
export function candidateWorktreePath(root, env = process.env, token = `manual-${randomBytes(4).toString('hex')}`) {
  return join(stateDir(env), `${cloneKey(root)}.candidate-${token}`);
}

// ── single-flight build lease (PR #2731 review) ──────────────────────────────────────────────────────────────

/** Tokens of the builds THIS process is running right now — lets a process tell its own finished-but-unreleased
 *  lease (a release that could not take the write lock) from one still in flight. */
const ACTIVE_BUILD_TOKENS = new Set();

/** How long a lease from a live pid (or another host) is honoured before it is treated as abandoned. Well past
 *  the slowest live smoke seen (~6 min) so a real build is never taken over mid-smoke. */
export const REBUILD_LEASE_STALE_ENV = 'WE_DAEMON_REBUILD_LEASE_STALE_MS';
export const DEFAULT_REBUILD_LEASE_STALE_MS = 20 * 60_000;

/**
 * Is `building` (a `state.building` lease record) held by a build that is still running? Same host + this pid:
 * only while its token is in {@link ACTIVE_BUILD_TOKENS}. Same host, other pid: while that pid is alive and the
 * lease is not aged. Other host: until it ages out. A record that cannot be read fails OPEN (not live) — the
 * lease is a courtesy against wasted, colliding smokes, and the unique candidate path is what keeps a takeover
 * from ever touching another attempt's tree.
 */
export function buildLeaseIsLive(building, { env = process.env, nowMs = Date.now() } = {}) {
  if (!building || typeof building !== 'object') return false;
  const staleMs = Number(env?.[REBUILD_LEASE_STALE_ENV]) > 0 ? Number(env[REBUILD_LEASE_STALE_ENV]) : DEFAULT_REBUILD_LEASE_STALE_MS;
  const startedMs = Date.parse(building.startedAt || '');
  if (!Number.isFinite(startedMs) || nowMs - startedMs > staleMs) return false;
  if (building.host !== hostname()) return true;
  if (building.pid === process.pid) return ACTIVE_BUILD_TOKENS.has(building.token);
  try { process.kill(building.pid, 0); return true; } catch (e) { return !(e && e.code === 'ESRCH'); }
}

/**
 * Must be called UNDER the write lock with a freshly read `state`: take the single-flight build lease for
 * `plan`, tearing down an abandoned lease's leftover candidate first. Returns the lease, or `null` when a live
 * sibling build already holds it. Mutates `state.building`; the caller writes the state.
 */
function claimBuildLease({ state, plan, root, run, env, nowMs }) {
  if (buildLeaseIsLive(state.building, { env, nowMs })) return null;
  if (state.building?.path && leaseOwnerIsGone(state.building)) removeCandidate({ root, path: state.building.path, run, env });
  const token = `${process.pid}-${randomBytes(4).toString('hex')}`;
  const lease = {
    token, pid: process.pid, host: hostname(), startedAt: new Date(nowMs).toISOString(),
    target: plan.finalSha, inputsKey: plan.inputsKey, path: candidateWorktreePath(root, env, token),
  };
  state.building = lease;
  ACTIVE_BUILD_TOKENS.add(token);
  return lease;
}

/** May an abandoned lease's candidate be deleted? Only when its owner provably is not still reading it: this
 *  process (none of our builds is running — see {@link buildLeaseIsLive}), or a dead pid on this host. An AGED
 *  lease from a still-live pid (a smoke slower than the stale limit) or another host is taken over, but its tree
 *  is left alone — the new attempt uses its own unique path, so the two never collide. */
function leaseOwnerIsGone(building) {
  if (building.host !== hostname()) return false;
  if (building.pid === process.pid) return !ACTIVE_BUILD_TOKENS.has(building.token);
  try { process.kill(building.pid, 0); return false; } catch (e) { return !!(e && e.code === 'ESRCH'); }
}

/** Under the write lock: drop `state.building` if it is still OUR lease (a takeover's newer lease is left alone). */
function releaseBuildLease(state, lease) {
  if (state.building?.token === lease.token) state.building = null;
}

/**
 * Check `sha` out into a disposable `git worktree` at `path` (default {@link candidateWorktreePath}) — a SECOND working copy of
 * the SAME `root` repository (`git worktree add` shares the object database; this never fetches or copies a
 * single object, unlike {@link dryRunRebuild}'s separate scratch-bare-repo trick, which exists only because a
 * dry run must never write anything into `root`'s own refs — this module already owns `root` outright once it
 * holds the write lock, so a plain worktree is enough). Anything already at `path` is force-torn-down first —
 * `path` is unique to this attempt's lease, so that is only ever this attempt's own leftover. `node_modules` is symlinked in from
 * `root` on a best-effort basis — a fresh worktree checkout carries only git-tracked files, and the live
 * smoke's checks spawn real `node`/`gh` child processes from it that need real dependencies; a repo with no
 * `node_modules` (or one whose checks then fail on a missing module) surfaces that as an ordinary check
 * failure, never a silent skip.
 *
 * xa4qo7n LIVE BUG, caught proving this very fix (2026-09-26 15:20 ET on `wev-review-daemon`): a `node_modules/`
 * `.gitignore` entry (the near-universal convention — trailing slash, "directories only") does NOT match a
 * SYMLINK of the same name (confirmed: `git status --porcelain` reports `?? node_modules` for a symlink even
 * with that exact ignore rule in place), so the symlink this function creates made {@link checkTreeStaysClean}
 * ALWAYS see the candidate as dirty — poisoning the reject-cache (`tree-stays-clean` is `mayBeTransient:false`)
 * on every single rebuild that reached this step, in a repo with a `node_modules/`-style ignore rule. Fixed by
 * {@link ensureNodeModulesExcluded}: a one-time, idempotent, repo-wide `node_modules` line (no trailing slash —
 * matches files AND symlinks, not just real directories) appended to the shared `info/exclude` (this is NOT
 * per-worktree; git resolves it from `--git-common-dir`, confirmed empirically — a PRIVATE per-worktree
 * `info/exclude` file is never even read), so every worktree's status reads the symlink as ignored, exactly
 * like the tracked `.gitignore` already treats the real directory.
 * @param {{root:string, sha:string, run:typeof gitRun, env?:NodeJS.ProcessEnv, path?:string}} o
 * @returns {{ok:true, path:string}|{ok:false, reason:string}}
 */
export function materializeCandidate({
  root, sha, run, env, path = candidateWorktreePath(root, env),
}) {
  const git = makeGit({ run, cwd: root, env, timeoutMs: 120_000 });
  git(['worktree', 'remove', '--force', path]);
  try { rmSync(path, { recursive: true, force: true }); } catch { /* best-effort teardown of a stale attempt */ }
  git(['worktree', 'prune']);
  mkdirSync(dirname(path), { recursive: true });
  const add = git(['worktree', 'add', '--detach', '--quiet', path, sha]);
  if (add.status !== 0) {
    return { ok: false, reason: `worktree-add-failed: ${String(add.stderr || add.stdout || '').trim().split('\n')[0]}` };
  }
  try {
    const nodeModules = join(root, 'node_modules');
    if (existsSync(nodeModules) && !existsSync(join(path, 'node_modules'))) {
      ensureNodeModulesExcluded({ root, git });
      symlinkSync(nodeModules, join(path, 'node_modules'), 'dir');
    }
  } catch { /* best-effort — see docblock above */ }
  return { ok: true, path };
}

/**
 * One-time, idempotent: append a bare `node_modules` line (no trailing slash, so it matches a SYMLINK too, not
 * only a real directory — see {@link materializeCandidate}'s docblock) to the repo's shared `info/exclude`,
 * unless a line already says exactly that. Best-effort — a failure here just means a future candidate's
 * `tree-stays-clean` check may see the symlink as dirt, same as before this fix; it never blocks the build.
 * @param {{root:string, git:(args:string[])=>{status:number,stdout:string,stderr:string}}} o
 */
function ensureNodeModulesExcluded({ root, git }) {
  const gd = git(['rev-parse', '--git-common-dir']);
  if (gd.status !== 0) return;
  const raw = String(gd.stdout || '').trim();
  if (!raw) return;
  const commonDir = isAbsolute(raw) ? raw : resolvePath(root, raw);
  const excludePath = join(commonDir, 'info', 'exclude');
  let existing = '';
  try { existing = readFileSync(excludePath, 'utf8'); } catch { /* missing is fine — starts empty */ }
  if (existing.split('\n').map((l) => l.trim()).includes('node_modules')) return; // already present
  mkdirSync(dirname(excludePath), { recursive: true });
  writeFileSync(excludePath, `${existing.replace(/\n?$/, '\n')}node_modules\n`);
}

/** Best-effort teardown of a candidate worktree — never throws. A failure here just leaves the fixed path for
 *  the NEXT {@link materializeCandidate} call to clear before it reuses it. */
export function removeCandidate({ root, path, run, env }) {
  const git = makeGit({ run, cwd: root, env, timeoutMs: 60_000 });
  try { git(['worktree', 'remove', '--force', path]); } catch { /* best-effort */ }
  try { rmSync(path, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { git(['worktree', 'prune']); } catch { /* best-effort */ }
}

// ── x5wbsbc — the candidate smoke runs in the LIVE daemon's environment, not the candidate path's ──────────

/** Env var a candidate smoke carries naming the live clone it stands in for (diagnostics only). */
export const SMOKE_LIVE_CLONE_ENV = 'WE_SMOKE_LIVE_CLONE';
/** `dispatch-lane-io.mjs#DISPATCH_CWD_ENV` — restated (not imported: that module is far too heavy for the
 *  rebuild mechanism to load); a unit test pins the two names equal. */
export const DISPATCH_CWD_ROOT_ENV = 'WE_DISPATCH_CWD_ROOT';

/**
 * PURE: the env the live smoke runs with when its tree is a disposable candidate worktree instead of `root`.
 *
 * x5wbsbc, live 2026-09-26 12:11-12:40 ET on `wev-review-daemon`: every rebuild since #2731 was
 * `smoke-rejected` (sticky) on `lane-acquire-release` — "no lanes provisioned for web-everything under
 * ~/.claude/daemon-self-sync-state/.lanes/web-everything". Everything that derives a location from WHERE the
 * checkout sits (`lane-pool-paths.mjs#defaultPoolRoot` → `<workspace>/.lanes`; `dispatch-lane-io.mjs`'s dispatch
 * scratch root → `<workspace>/.operations/dispatch`) resolved against the CANDIDATE's path, which lives under the
 * rebuild state dir — a pool with no lanes, and `.operations/` litter in the state dir. The live daemon
 * resolves those from `root`. So every such location is resolved HERE, from `root`, and passed explicitly: an
 * explicit `LANE_POOL_ROOT`/`WE_DISPATCH_CWD_ROOT` already in `env` wins (that is what the daemon itself would
 * use); `PATH`/`HOME` are guaranteed present (a spawn with no PATH is `spawn git ENOENT`). The WE_*, GitHub App
 * and `gh` env ride along untouched from `env` (the daemon's own), exactly as the old in-place smoke had them.
 * @param {{root:string, env?:NodeJS.ProcessEnv}} o
 * @returns {NodeJS.ProcessEnv}
 */
export function candidateSmokeEnv({ root, env = process.env }) {
  const out = { ...env };
  if (!out.PATH) out.PATH = process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
  if (!out.HOME) out.HOME = process.env.HOME || homedir();
  out.LANE_POOL_ROOT = defaultPoolRoot(root, out);
  if (!String(out[DISPATCH_CWD_ROOT_ENV] ?? '').trim()) {
    out[DISPATCH_CWD_ROOT_ENV] = join(workspaceFor(root), '.operations', 'dispatch');
  }
  out[SMOKE_LIVE_CLONE_ENV] = root;
  return out;
}

/**
 * PURE-ish (one alert side-effect): is `root` still safe to move, migrating known daemon-state-file dirt out of
 * the way first (see {@link migrateDaemonStateFiles}) exactly as the old single-phase `doRebuild` did at its own
 * Step 1 — shared by {@link prepareRebuild} (before the candidate is even built) and {@link finalizeRebuild}
 * (re-checked right before the one `reset --hard`, since real time — an unlocked smoke — passed in between).
 * @returns {{safe:boolean, reason?:string, detail?:*, untracked:Array<string>}}
 */
function ensureSafeToMove({
  git, root, env, stEnv, alert, knownInputs,
}) {
  let unsafe = findUnsafeLocalState({ git, knownInputs });
  if (!unsafe.safe && unsafe.reason === 'dirty') {
    const recovery = restoreStrayClaimStamps({ git, root, dirty: unsafe.detail });
    for (const entry of recovery.restored) alert('backlog-claim-stamp-restored', entry);
    if (recovery.ok) unsafe = findUnsafeLocalState({ git, knownInputs });
    else if (recovery.reason !== 'not-claim-stamps') {
      alert('backlog-claim-stamp-restore-failed', { reason: recovery.reason });
    }
  }
  if (!unsafe.safe && unsafe.reason === 'dirty') {
    const mig = migrateDaemonStateFiles({
      git, root, dirty: unsafe.detail, env: stEnv,
    });
    for (const m of mig.migrated) alert('state-file-migrated', m);
    if (mig.ok) unsafe = findUnsafeLocalState({ git, knownInputs });
    else if (mig.reason !== 'not-state-files') alert('state-file-migrate-failed', { reason: mig.reason });
  }
  return unsafe;
}

/** The one "this clone is being held off origin/main" alert both {@link prepareRebuild} and
 *  {@link finalizeRebuild} raise on a non-moving, non-adopting, plan-ok, behind-main result — factored out so
 *  both phases (which each read their OWN fresh `state`, see file header) compute it identically. */
function staleAlertDetail(result, state) {
  if (result.moved || result.adopted || !result.plan?.ok || result.plan.upToDate) return null;
  if (result.reason === 'rebuild-in-progress') return null; // a sibling is already moving it — not held
  return {
    reason: result.reason,
    mainSha: result.plan.mainSha,
    target: result.plan.finalSha,
    retryAt: result.reason === 'smoke-harness-broken-backoff' || result.reason === 'smoke-harness-broken'
      || state.rejected?.inputsKey === result.plan.inputsKey ? (state.rejected?.retryAt ?? null) : null,
    attempts: state.rejected?.attempts ?? null,
    ...(state.held ? { broken: {
      failed: state.held.failed,
      detail: (state.held.details?.[0]?.detail ?? '').slice(0, 300),
    } } : {}),
    // x5wbsbc: a held clone keeps dispatching from its last-good build (`main-staleness.mjs#assertMainNotStale`).
    message: 'the rebuild is holding this clone off origin/main — it keeps dispatching from its last-good build (x5wbsbc) until this clears',
  };
}

// ── rebuildClone — the IO shell ──────────────────────────────────────────────────────────────────────────────

/** Shas a clone was previously built from — see {@link findUnsafeLocalState}'s `knownInputs`. */
function knownInputsOf(state) {
  return [
    state?.adopted?.head, state?.adopted?.mainSha, ...((state?.adopted?.applied) || []).map((a) => a?.sha),
    state?.quarantine?.prevHead,
  ].filter(Boolean);
}

/**
 * Under the write lock: move `root` off a never-smoked build back onto `prevHead` (its last verified head), with
 * the same "clean" test the quarantine recovery uses — no tracked change, and no untracked file prevHead has
 * content at (the reset would silently overwrite it). Returns whether HEAD is now `prevHead`.
 */
function rollbackUnverified({ git, prevHead }) {
  if (!prevHead || !verifyRev(git, `${prevHead}^{commit}`)) return false;
  const status = git(['status', '--porcelain', '--untracked-files=no']);
  const untracked = collectUntrackedPaths(git);
  const clean = status.status === 0 && !String(status.stdout ?? '').trim() && untracked !== null
    && !untracked.some((p) => git(['cat-file', '-e', `${prevHead}:${p}`]).status === 0);
  if (!clean) return false;
  return git(['reset', '--hard', prevHead]).status === 0;
}

/**
 * Phase 1 (LOCKED, fast — no smoke, no `reset --hard`): recovery, safety, fetch, `planRebuild`, overlay-list
 * edits, and the up-to-date/still-rejected/untracked-collision short-circuits — everything the old single-phase
 * `doRebuild` did in its Steps 0-4.5. Returns EITHER `{terminal:true, result, alerts}` (a final `rebuildClone`
 * result — the caller returns it as-is) or `{terminal:false, plan, prevHead, alerts}` (proceed to build +
 * smoke a candidate — see {@link rebuildClone}).
 */
async function prepareRebuild({
  root, env, log, run, prState, stateOpts, mainOnly, now,
}) {
  const stEnv = { ...env, ...(stateOpts?.env || {}) };
  const git = makeGit({ run, cwd: root, env });
  const alertsList = [];
  const nowMs = () => now();
  const nowIso = () => new Date(nowMs()).toISOString();

  const alert = (kind, detail) => {
    alertsList.push({ kind, detail });
    log?.error?.(`daemon-rebuild: ${kind}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ''}`);
    try {
      const file = alertsFilePath(root, stEnv);
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify({ at: nowIso(), kind, detail })}\n`, 'utf8');
    } catch { /* best-effort audit trail only */ }
  };
  const terminal = (result) => {
    // A clone the rebuild will NOT advance while origin/main (or an overlay) has moved is STALE — every dispatch
    // from it refuses as stale-main. Say so loudly, every tick it stays that way, instead of leaving the daemons
    // silently refusing everything (live 2026-09-25 08:14 ET: held by a still-rejected smoke, refused 6/tick).
    const stale = staleAlertDetail(result, state);
    if (stale) alert('clone-held-stale', stale);
    return { terminal: true, result, alerts: alertsList };
  };

  const state = readRebuildState(root, stEnv);
  const writeState = () => writeRebuildState(root, state, stEnv);

  // ── Step 0: recovery ──────────────────────────────────────────────────────────────────────────────────
  const indexLockPath = join(root, '.git', 'index.lock');
  try {
    const st = statSync(indexLockPath);
    const staleMs = Number(env?.WE_DAEMON_INDEX_LOCK_STALE_MS) || 120_000;
    if (nowMs() - st.mtimeMs > staleMs) {
      unlinkSync(indexLockPath);
      alert('index-lock-recovered', { ageMs: nowMs() - st.mtimeMs });
    } else {
      return terminal({ moved: false, reason: 'index-locked' });
    }
  } catch { /* no index.lock present — nothing to recover */ }

  if (state.inProgress) {
    const staleMs = Number(env?.WE_DAEMON_REBUILD_STALE_MS) || 30 * 60_000;
    const sameHost = state.inProgress.host === hostname();
    const pidDead = sameHost && (() => {
      try { process.kill(state.inProgress.pid, 0); return false; } catch (e) { return e && e.code === 'ESRCH'; }
    })();
    const startedMs = Date.parse(state.inProgress.startedAt || '');
    const aged = Number.isFinite(startedMs) && nowMs() - startedMs > staleMs;
    if (pidDead || aged) {
      const headNow = verifyRev(git, 'HEAD');
      const clean = findUnsafeLocalState({ git, knownInputs: knownInputsOf(state) }).safe;
      const ip = state.inProgress;
      // PR #2731 review: only a record THIS design wrote (`verified: true` — its smoke passed before its reset)
      // may be promoted unsmoked. A record without the marker was written by the pre-fix code, which reset BEFORE
      // smoking, so HEAD == target there means a build that was never smoked is on disk: roll it back to the
      // last verified head and let this tick rebuild + smoke it off-lock like any other candidate.
      const atUnverifiedTarget = headNow === ip.target && ip.target !== ip.prevHead && ip.verified !== true;
      if (atUnverifiedTarget) {
        const rolled = rollbackUnverified({ git, prevHead: ip.prevHead });
        if (!rolled) {
          alert('rebuild-interrupted-unrecoverable', { inProgress: ip, headNow, unverified: true });
          return terminal({ moved: false, reason: 'rebuild-interrupted-unrecoverable' });
        }
        state.inProgress = null;
        writeState();
        alert('rebuild-interrupted-recovered', { target: ip.target, headNow, promoted: false, rolledBackUnverified: true });
      } else if (headNow === ip.target || (headNow === ip.prevHead && clean)) {
        state.inProgress = null;
        // xa4qo7n — under THIS design a `reset --hard` NEVER runs before its candidate's live smoke has already
        // passed (see file header), so `headNow === target` on a `verified` record can only mean: the reset
        // landed, the process died before the state write right after it, and the smoke for this EXACT build
        // already passed. Promote it straight to `adopted` from the inProgress record's own echoed plan fields.
        const promote = headNow === ip.target && ip.target !== ip.prevHead;
        if (promote) {
          state.adopted = {
            head: ip.target, inputsKey: ip.inputsKey ?? null, mainSha: ip.mainSha ?? null, applied: ip.applied ?? [], at: nowIso(),
          };
          state.rejected = null;
          state.held = null;
          writeState();
          alert('rebuild-interrupted-recovered', { target: ip.target, headNow, promoted: true });
          // Short-circuit here (unlike the non-promoted branch below, which falls through to a fresh plan this
          // same tick): this build is now FULLY adopted, so there is nothing else for this tick to decide.
          return terminal({
            moved: false, adopted: true, reason: 'recovered-adopted', head: ip.target,
          });
        }
        writeState();
        alert('rebuild-interrupted-recovered', { target: ip.target, headNow, promoted: false });
      } else {
        alert('rebuild-interrupted-unrecoverable', { inProgress: state.inProgress, headNow });
        return terminal({ moved: false, reason: 'rebuild-interrupted-unrecoverable' });
      }
    }
  }

  // PR #2731 review: the pre-fix recovery could leave `state.unverified` — a build reset onto but never smoked.
  // This design never writes it, so treat it exactly like an unmarked inProgress record at its target: roll back
  // to its verified prevHead so this tick re-smokes it off-lock, instead of reading HEAD as up-to-date.
  if (state.unverified) {
    const uv = state.unverified;
    if (verifyRev(git, 'HEAD') === uv.head && uv.head !== uv.prevHead) {
      if (!rollbackUnverified({ git, prevHead: uv.prevHead })) {
        alert('rebuild-interrupted-unrecoverable', { unverified: uv });
        return terminal({ moved: false, reason: 'rebuild-interrupted-unrecoverable' });
      }
      alert('unverified-build-rolled-back', { head: uv.head, prevHead: uv.prevHead });
    }
    state.unverified = null;
    writeState();
  }

  if (state.quarantine) {
    // Same definition of "clean" as findUnsafeLocalState: tracked changes only (an untracked sidecar must never
    // freeze recovery), plus the same untracked-collision guard Step 4.5 runs — refuse if prevHead has content
    // at an untracked path, since this `reset --hard` would silently overwrite it.
    const { prevHead: qHead } = state.quarantine;
    const status = git(['status', '--porcelain', '--untracked-files=no']);
    const untracked = collectUntrackedPaths(git);
    const clean = status.status === 0 && !String(status.stdout ?? '').trim() && untracked !== null
      && !untracked.some((p) => git(['cat-file', '-e', `${qHead}:${p}`]).status === 0);
    const reset = clean ? git(['reset', '--hard', state.quarantine.prevHead]) : { status: 1 };
    if (clean && reset.status === 0) {
      state.quarantine = null;
      writeState();
    } else {
      return terminal({ moved: false, reason: 'quarantined' });
    }
  }

  // ── Step 1: must be on main, and the local tree must be safe to move ────────────────────────────────────
  const headRef = git(['symbolic-ref', '--short', 'HEAD']);
  const onMain = headRef.status === 0 ? String(headRef.stdout ?? '').trim() === 'main' : null;
  if (!onMain) {
    alert('not-on-main', { onMain });
    return terminal({ moved: false, reason: 'not-on-main' });
  }

  const unsafe = ensureSafeToMove({
    git, root, env, stEnv, alert, knownInputs: knownInputsOf(state),
  });
  if (!unsafe.safe) {
    alert(unsafe.reason, unsafe.detail);
    return terminal({ moved: false, reason: unsafe.reason });
  }
  const prevHead = verifyRev(git, 'HEAD');
  if (!prevHead) {
    alert('head-unresolved');
    return terminal({ moved: false, reason: 'head-unresolved' });
  }

  // ── Step 2: fetch ────────────────────────────────────────────────────────────────────────────────────
  // A corrupt overlay file reads as an empty list. Building on that would quietly rebuild onto main alone and
  // drop every registered fix, so refuse and alert instead (mainOnly ignores overlays anyway, so it proceeds).
  const overlayState = readOverlayState(root, { env });
  if (overlayState.corrupt) {
    alert('overlay-state-corrupt', { file: overlayFilePath(root, env) });
    if (!mainOnly) return terminal({ moved: false, reason: 'overlay-state-corrupt' });
  }
  const overlaysBefore = overlayState.overlays;
  const fetchResult = fetchMainAndOverlays({ git, overlays: overlaysBefore });
  if (!fetchResult.ok) {
    if (unsafe.untracked.length > 0) alert('untracked-kept', { paths: unsafe.untracked });
    alert('fetch-failed');
    return terminal({ moved: false, reason: 'fetch-failed' });
  }
  for (const ref of fetchResult.goneRefs) alert('overlay-ref-gone-on-fetch', { ref });

  const fetchedMainSha = verifyRev(git, 'origin/main^{commit}');
  pruneLandedBacklogSidecars({ git, root, paths: unsafe.untracked, mainSha: fetchedMainSha, alert });
  const remaining = collectUntrackedPaths(git);
  if (remaining === null) {
    alert('status-failed', 'Post-cleanup ls-files --others failed');
    return terminal({ moved: false, reason: 'status-failed' });
  }
  unsafe.untracked = remaining;
  if (remaining.length > 0) alert('untracked-kept', { paths: remaining });

  // ── Step 3: plan + apply list edits ─────────────────────────────────────────────────────────────────
  const plan = await planRebuild({
    git, headSha: prevHead, mainRef: 'origin/main', overlays: overlaysBefore, prState, mainOnly,
  });
  if (!plan.ok) {
    // A pinned refusal keeps the current tree AND the overlay list untouched (no decisions were applied).
    alert(plan.reason, plan.detail);
    // xpinskip — a pinned refusal that still stands (explicit pin, or main lacks the mechanism) must not freeze
    // dispatch either: when the clone sits on its last smoke-verified build, record it as HELD there, so
    // `main-staleness.mjs#assertMainNotStale` dispatches from that build (x5wbsbc) instead of refusing every
    // tick as stale, and `daemon-held-on-last-good` flags it after 15 min. The next adoption clears it.
    if (/^pinned-overlay-/.test(plan.reason) && state.adopted?.head && state.adopted.head === prevHead) {
      const d = plan.detail || {};
      state.held = {
        since: state.held?.since ?? nowIso(),
        reason: plan.reason,
        failed: `${d.ref ?? '?'}${d.pr != null ? ` (PR #${d.pr})` : ''}: ${d.message ?? plan.reason}`,
        details: [],
        lastGood: prevHead,
        target: null,
        mainSha: null,
        updatedAt: nowIso(),
      };
      writeState();
    }
    return terminal({ moved: false, reason: plan.reason, ...(plan.detail ? { detail: plan.detail } : {}) });
  }
  for (const d of plan.decisions) {
    if (d.action === 'remove') {
      removeOverlay(root, d.ref, { env, why: d.reason });
      appendOverlayEvent(root, { kind: 'auto-dropped', ref: d.ref, pr: d.pr, reason: d.reason }, { env });
      alert('overlay-auto-dropped', { ref: d.ref, reason: d.reason });
    } else if (d.action === 'drop') {
      alert('overlay-conflict-dropped', { ref: d.ref, reason: d.reason });
    }
  }
  for (const kind of plan.alerts) alert(kind.kind, kind.detail);

  // ── Step 4: up-to-date / still-rejected short-circuits ──────────────────────────────────────────────
  if (plan.upToDate) {
    if (!state.adopted || state.adopted.inputsKey !== plan.inputsKey || state.held) {
      state.adopted = {
        head: plan.finalSha, inputsKey: plan.inputsKey, mainSha: plan.mainSha, applied: plan.applied, at: nowIso(),
      };
      state.held = null; // x5wbsbc — current again: no longer held on a last-good build
      writeState();
    }
    clearReadyCandidate(root, stEnv); // current already — nothing a passed-but-unadopted build could add
    return terminal({ moved: false, reason: 'up-to-date', plan });
  }

  // fix-rebuild-finalize — a candidate that already PASSED its smoke but could not be adopted (a reader was
  // mid-tick when its finalize tried the lock) is adopted HERE, under the write lock this phase already holds,
  // instead of being thrown away and re-smoked. Checked before the rejection/backoff short-circuits: a passed
  // plain-main fallback answers exactly the inputs the reject-cache would otherwise stop at.
  {
    const ready = readReadyCandidate(root, stEnv);
    if (ready) {
      // Still wanted = registered AFTER this tick's own list edits (a same-tick `pr-closed`/`ref-gone` removal is
      // NOT wanted), plus overlays that left because main now has them. A mainOnly rebuild wants no overlay.
      const registeredRefs = new Set((overlaysBefore || []).map((o) => o?.ref));
      for (const d of plan.decisions) if (d.action === 'remove') registeredRefs.delete(d.ref);
      const wantedRefs = new Set(mainOnly ? [] : registeredRefs);
      for (const d of plan.decisions) {
        if (d.action === 'remove' && (d.reason === 'pr-merged' || d.reason === 'in-main')) wantedRefs.add(d.ref);
      }
      const maxAgeMs = Number(env?.[READY_MAX_AGE_ENV]) > 0 ? Number(env[READY_MAX_AGE_ENV]) : DEFAULT_READY_MAX_AGE_MS;
      const m = matchReadyCandidate({
        ready,
        plan,
        prevHead,
        treeOf: (sha) => verifyRev(git, `${sha}^{tree}`),
        stillWanted: (ref) => wantedRefs.has(ref),
        verifyBuilt: (adopt) => readyBuildVerified({
          git, adopt, mainTip: plan.mainSha, prevHead,
        }),
        overlayTip: (ref) => verifyRev(git, `refs/remotes/origin/${ref}^{commit}`),
        registered: (ref) => registeredRefs.has(ref),
        allowFallback: !mainOnly, // a mainOnly rebuild never edits the overlay list, so never drops suspects
        rejected: state.rejected,
        nowMs: nowMs(),
        maxAgeMs,
      });
      if (!m.adopt) {
        clearReadyCandidate(root, stEnv);
        alert('ready-candidate-discarded', { target: ready.adopt.finalSha, reason: m.reason });
      } else {
        const colliding = unsafe.untracked.filter((p) => git(['cat-file', '-e', `${m.adopt.finalSha}:${p}`]).status === 0);
        if (colliding.length > 0) {
          clearReadyCandidate(root, stEnv);
          alert('untracked-collision', { paths: colliding });
          return terminal({ moved: false, reason: 'untracked-collision', untracked: colliding, plan });
        }
        alert('ready-candidate-adopted', {
          target: m.adopt.finalSha, match: m.match, passedAt: ready.passedAt, passedBy: `${ready.pid ?? '?'}@${ready.host ?? '?'}`,
          ...(m.dropRefs.length ? { dropping: m.dropRefs.map((s) => s.ref) } : {}),
        });
        writeState();
        const fin = await finalizeRebuild({
          root,
          env,
          log,
          run,
          stateOpts,
          now,
          plan: m.adopt,
          prevHead,
          lease: { token: ready.token ?? null },
          onAdopted: m.dropRefs.length
            ? ({ alert: finAlert }) => dropSuspectOverlays({
              root, env, suspects: m.dropRefs, failed: m.failed, alert: finAlert,
            })
            : undefined,
        });
        const { alerts: finAlerts = [], ...finResult } = fin;
        return {
          terminal: true,
          result: { ...finResult, ...(finResult.adopted ? { reason: 'ready-adopted', readyMatch: m.match } : {}) },
          alerts: [...alertsList, ...finAlerts],
        };
      }
    }
  }
  // x5wbsbc — a BROKEN SMOKE HARNESS (every candidate, the last-good build included, fails the same checks) is
  // not re-smoked on every main move: it would cost up to three full smokes per move and every one would fail
  // the same way. Until its backoff expires the clone stays on its last-good build (and keeps dispatching —
  // `main-staleness.mjs#assertMainNotStale`), whatever the new inputs are.
  if (state.held?.reason === 'smoke-harness-broken' && state.rejected?.harnessBroken) {
    const retryAtMs = Date.parse(state.rejected.retryAt || '');
    if (Number.isFinite(retryAtMs) && nowMs() < retryAtMs) {
      return terminal({ moved: false, reason: 'smoke-harness-broken-backoff', plan });
    }
  }
  if (state.rejected?.inputsKey === plan.inputsKey) {
    // An external-only rejection (only gh/network checks failed) is never permanent: once its backoff expires
    // the same inputs are smoked again, instead of sticking until main or an overlay moves.
    const retryAtMs = Date.parse(state.rejected.retryAt || '');
    if (!(Number.isFinite(retryAtMs) && nowMs() >= retryAtMs)) {
      return terminal({ moved: false, reason: 'still-rejected', plan });
    }
    alert('rejected-retry-due', { inputsKey: plan.inputsKey, attempts: state.rejected.attempts ?? 1 });
  }

  // ── Step 4.5: untracked-collision guard — a `reset --hard` keeps untracked files, but SILENTLY OVERWRITES
  //    one if the incoming tree has real content at that same path. Check every untracked path from Step 1's
  //    `unsafe.untracked` against the target tree; anything not present there is harmless (already reported as
  //    `untracked-kept` after Step 1). Re-checked again in {@link finalizeRebuild} right before the actual
  //    `reset --hard`, since real (unlocked) time passes for the smoke in between.
  if (unsafe.untracked.length > 0) {
    const colliding = unsafe.untracked.filter((p) => git(['cat-file', '-e', `${plan.finalSha}:${p}`]).status === 0);
    if (colliding.length > 0) {
      alert('untracked-collision', { paths: colliding });
      return terminal({ moved: false, reason: 'untracked-collision', untracked: colliding, plan });
    }
  }

  // PR #2731 review — single flight: phase 2 runs unlocked, so without this a sibling daemon sharing the clone
  // could build + smoke the same candidate at the same time. Claimed HERE, under the write lock, so exactly one
  // caller wins; the loser returns at once and its next tick finds the winner's result.
  const lease = claimBuildLease({
    state, plan, root, run, env: stEnv, nowMs: nowMs(),
  });
  if (!lease) {
    const b = state.building;
    log?.error?.(`daemon-rebuild: rebuild-in-progress — pid ${b?.pid ?? '?'}@${b?.host ?? '?'} is already smoking ${String(b?.target ?? '?').slice(0, 9)} for this clone; this tick runs on the current tree`);
    return terminal({
      moved: false, reason: 'rebuild-in-progress', heldBy: `${b?.pid ?? '?'}@${b?.host ?? '?'}`, plan,
    });
  }
  writeState();

  // Nothing left that can be decided without smoking a candidate first — hand off to rebuildClone's unlocked
  // build+smoke step, then {@link finalizeRebuild}.
  return {
    terminal: false, plan, prevHead, lease, overlays: overlaysBefore, alerts: alertsList,
  };
}

/**
 * Phase 3 (LOCKED, fast — reached ONLY after phase 2's unlocked smoke, run by {@link rebuildClone}, already
 * PASSED): re-verifies nothing else moved `root` while the smoke ran, then performs the ONE `git reset --hard`
 * this module ever does, and writes `state.adopted`. On a FAILING smoke this is never called at all — `root`
 * was never touched, so {@link rebuildClone} handles that case itself, with no lock and nothing to roll back.
 */
async function finalizeRebuild({
  root, env, log, run, stateOpts, now, plan, prevHead, lease, onAdopted,
}) {
  const stEnv = { ...env, ...(stateOpts?.env || {}) };
  const git = makeGit({ run, cwd: root, env });
  const alertsList = [];
  const nowMs = () => now();
  const nowIso = () => new Date(nowMs()).toISOString();

  const alert = (kind, detail) => {
    alertsList.push({ kind, detail });
    log?.error?.(`daemon-rebuild: ${kind}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ''}`);
    try {
      const file = alertsFilePath(root, stEnv);
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify({ at: nowIso(), kind, detail })}\n`, 'utf8');
    } catch { /* best-effort audit trail only */ }
  };
  const state = readRebuildState(root, stEnv);
  const writeState = () => writeRebuildState(root, state, stEnv);
  // Every exit from this (locked) phase ends the build, so every exit releases its lease and persists that.
  releaseBuildLease(state, lease);
  const terminal = (result) => {
    writeState();
    const stale = staleAlertDetail(result, state);
    if (stale) alert('clone-held-stale', stale);
    // fix-rebuild-finalize — an adopted build leaves nothing passed-but-unadopted behind.
    if (result.adopted) clearReadyCandidate(root, stEnv);
    // x5wbsbc — runs INSIDE this write-lock hold, only on an adoption (e.g. drop the overlay a fallback proved bad).
    if (result.adopted && typeof onAdopted === 'function') {
      try { onAdopted({ alert }); } catch (e) { alert('on-adopted-failed', { error: String(e?.message || e) }); }
    }
    return { ...result, alerts: alertsList };
  };

  // Defensive re-check: real (unlocked) time passed for the smoke since `prepareRebuild` read `prevHead`. Either
  // a SIBLING process's own rebuild already landed this EXACT build (align state and stop, no error), or
  // something else moved `root` entirely (abandon this attempt cleanly; the next tick recomputes a fresh plan).
  const headNow = verifyRev(git, 'HEAD');
  if (headNow === plan.finalSha) {
    if (!state.adopted || state.adopted.inputsKey !== plan.inputsKey || state.held) {
      state.adopted = {
        head: plan.finalSha, inputsKey: plan.inputsKey, mainSha: plan.mainSha, applied: plan.applied, at: nowIso(),
      };
      state.rejected = null;
      state.held = null;
      writeState();
    }
    return terminal({
      moved: false, adopted: true, reason: 'already-adopted', head: plan.finalSha, plan,
    });
  }
  if (headNow !== prevHead) {
    alert('root-changed-during-smoke', { expectedPrevHead: prevHead, headNow });
    return terminal({ moved: false, reason: 'root-changed-during-smoke', plan });
  }

  // Re-run the same safety gate `prepareRebuild` already passed — the tree could, in principle, have picked up
  // new dirt during the unlocked smoke window (see {@link ensureSafeToMove}'s docblock).
  const unsafe = ensureSafeToMove({
    git, root, env, stEnv, alert, knownInputs: knownInputsOf(state),
  });
  if (!unsafe.safe) {
    alert(unsafe.reason, unsafe.detail);
    return terminal({ moved: false, reason: unsafe.reason, plan });
  }
  if (unsafe.untracked.length > 0) {
    const colliding = unsafe.untracked.filter((p) => git(['cat-file', '-e', `${plan.finalSha}:${p}`]).status === 0);
    if (colliding.length > 0) {
      alert('untracked-collision', { paths: colliding });
      return terminal({ moved: false, reason: 'untracked-collision', untracked: colliding, plan });
    }
  }

  // ── The ONE `reset --hard` this module performs — always AFTER a passing smoke, never before. ──────────
  // `verified: true` is what lets crash recovery promote this record unsmoked — a record without it came from
  // the pre-fix code, which reset BEFORE smoking (PR #2731 review; see prepareRebuild's Step 0).
  state.inProgress = {
    pid: process.pid, host: hostname(), prevHead, target: plan.finalSha, startedAt: nowIso(),
    inputsKey: plan.inputsKey, mainSha: plan.mainSha, applied: plan.applied, verified: true,
  };
  writeState();
  try {
    const reset = git(['reset', '--hard', plan.finalSha]);
    if (reset.status !== 0) {
      const rollback = git(['reset', '--hard', prevHead]);
      const rolledBack = rollback.status === 0;
      // A failed reset may have half-moved the tree; if the rollback also failed, its state is unknown —
      // quarantine so no later tick builds or runs on it.
      if (!rolledBack) state.quarantine = { prevHead, reason: 'reset-rollback-failed' };
      state.inProgress = null;
      writeState();
      alert('reset-failed', { target: plan.finalSha, rolledBack });
      return terminal({
        moved: false, reason: 'reset-failed', rolledBack, ...(rolledBack ? {} : { quarantine: true }), plan,
      });
    }
    state.adopted = {
      head: plan.finalSha, inputsKey: plan.inputsKey, mainSha: plan.mainSha, applied: plan.applied, at: nowIso(),
    };
    state.rejected = null;
    state.held = null;
    state.inProgress = null;
    writeState();
    return terminal({
      moved: true, adopted: true, head: plan.finalSha, prevHead, plan,
    });
  } catch (e) {
    const rollback = git(['reset', '--hard', prevHead]);
    if (rollback.status !== 0) {
      state.quarantine = { prevHead, reason: 'rebuild-threw' };
      state.inProgress = null;
      writeState();
      alert('rollback-failed', { prevHead, error: String(e?.message || e) });
      return terminal({ moved: false, reason: 'rollback-failed', quarantine: true, plan });
    }
    state.inProgress = null;
    writeState();
    alert('rebuild-threw', { error: String(e?.message || e) });
    return terminal({ moved: false, reason: 'rebuild-error', plan });
  }
}

/**
 * Rebuild `root` fresh from `origin/main` + its registered overlay list. See the file header (xa4qo7n) for the
 * full three-step design — {@link prepareRebuild} (locked, fast) → build + smoke a disposable candidate
 * (UNLOCKED — the live smoke never runs against `root` and never holds its write lock) →
 * {@link finalizeRebuild} (locked, fast, reached only after a passing smoke). A lock refusal at either locked
 * step is reported, never treated as an error.
 * @param {{root:string, env?:NodeJS.ProcessEnv, log?:Console, run?:typeof gitRun, runSmoke?:typeof runLiveSmokeWithRetry,
 *   prState?:(pr:number)=>(Promise<string|null>|string|null), lockOpts?:object, stateOpts?:{env?:NodeJS.ProcessEnv},
 *   mainOnly?:boolean, now?:()=>number, sleep?:(ms:number)=>Promise<void>}} o
 * @returns {Promise<object>}
 */
export async function rebuildClone({
  root, env = process.env, log = console, run = gitRun, runSmoke = runLiveSmokeWithRetry,
  prState = (pr) => defaultPrState({ pr, root }), lockOpts = {}, stateOpts = {}, mainOnly = false,
  now = () => Date.now(), sleep,
} = {}) {
  const lockRootFromEnv = env && env.WE_DAEMON_CLONE_LOCK_ROOT;
  // #4044 (live 2026-09-25 10:28-10:40 ET): the fix daemon's tick-start rebuild waited SILENTLY up to the lock's
  // 600s default for the review daemon's 10-minute tick to release its read slot — no ticks, no log line. A
  // rebuild is opportunistic (the next tick retries it), so it now waits at most WE_DAEMON_REBUILD_LOCK_WAIT_MS
  // (default 60s), says so when it starts waiting, and records the give-up.
  const waitMs = Number(env?.[REBUILD_LOCK_WAIT_ENV]) > 0 ? Number(env[REBUILD_LOCK_WAIT_ENV]) : DEFAULT_REBUILD_LOCK_WAIT_MS;
  const finalLockOpts = {
    ...(lockRootFromEnv ? { lockRoot: lockRootFromEnv } : {}),
    now,
    waitMs,
    onBlocked: ({ blockers, waitMs: w }) => log.error?.(
      `daemon-rebuild: waiting up to ${Math.round(w / 1000)}s for live reader(s) ${blockers.join(', ')} to finish their tick before moving the clone (#4044)`,
    ),
    ...(sleep ? { sleep } : {}),
    ...lockOpts,
  };
  const stEnv = { ...env, ...(stateOpts?.env || {}) };
  // fix-rebuild-finalize: once a candidate has passed, the wait for readers is the longer finalize wait — the
  // writer reservation refuses every NEW read slot meanwhile, so this only outlasts ticks already in flight.
  const finalizeWaitMs = Number(env?.[FINALIZE_LOCK_WAIT_ENV]) > 0 ? Number(env[FINALIZE_LOCK_WAIT_ENV]) : DEFAULT_FINALIZE_LOCK_WAIT_MS;
  const finalizeLockOpts = { ...finalLockOpts, waitMs: lockOpts.waitMs ?? Math.max(waitMs, finalizeWaitMs) };

  // ── Phase 1 (locked, fast) ───────────────────────────────────────────────────────────────────────────────
  // A passed candidate waiting on THIS head (an unlocked peek — prepareRebuild re-checks it under the lock) is
  // adopted by this phase, so it earns the finalize wait: this is the tick boundary the sibling yields at.
  const pendingReady = readReadyCandidate(root, stEnv);
  const readyOnHead = !!pendingReady
    && pendingReady.prevHead === verifyRev(makeGit({ run, cwd: root, env }), 'HEAD');
  const startedMs = now();
  const prep = await withWriteLock(root, () => prepareRebuild({
    root, env, log, run, prState, stateOpts, mainOnly, now,
  }), readyOnHead ? finalizeLockOpts : finalLockOpts);

  if (!prep.ok) {
    if (prep.reason === 'tick-in-progress') {
      log.error?.(`daemon-rebuild: gave up after ${Math.round((now() - startedMs) / 1000)}s — reader ${prep.heldBy ?? '?'} still ticking; this tick runs on the current tree and the next one retries (#4044)`);
    }
    return { moved: false, reason: prep.reason, ...(prep.heldBy ? { heldBy: prep.heldBy } : {}) };
  }
  if (prep.value.terminal) {
    return { ...prep.value.result, alerts: prep.value.alerts };
  }
  const {
    plan, prevHead, lease, overlays: overlaysBefore = [], alerts: prepAlerts,
  } = prep.value;

  // ── Phase 2 (UNLOCKED — the whole point of xa4qo7n): build + smoke a disposable candidate ───────────────
  try {
    return await smokeAndAdopt({
      root, env, stEnv, log, run, runSmoke, stateOpts, now, plan, prevHead, lease, overlaysBefore, prepAlerts, mainOnly,
      finalLockOpts, finalizeLockOpts,
    });
  } catch (e) {
    // Best-effort: never leave a thrown build's lease on disk to hold a sibling off until it ages out.
    try {
      await withWriteLock(root, () => {
        const st = readRebuildState(root, stEnv);
        releaseBuildLease(st, lease);
        writeRebuildState(root, st, stEnv);
      }, finalLockOpts);
    } catch { /* the owner's next call takes an unreleased lease back anyway */ }
    throw e;
  } finally {
    ACTIVE_BUILD_TOKENS.delete(lease.token);
  }
}

/** The failed check rows of a smoke result (`[]` for a pass or a missing result). */
function failedRows(smokeResult) {
  return (smokeResult?.smoke?.results || []).filter((r) => !r.ok);
}

/** PURE: does `control` fail every check `candidate` failed (by name)? — the "the harness itself is broken"
 *  test: a failure the last-good build reproduces is not evidence against the candidate's code. */
export function failsSameChecks(candidateFailed, controlFailed) {
  const c = new Set((controlFailed || []).map((r) => r.name));
  return Array.isArray(candidateFailed) && candidateFailed.length > 0 && candidateFailed.every((r) => c.has(r.name));
}

/**
 * Phase 2 body (x5wbsbc — the operator's fallback ruling, 2026-09-26: "fallback on last working version rather
 * than block delivery"). Smokes candidate A = `plan` (main + overlays). On a pass: adopt (phase 3), as before.
 * On a `'code'` failure, in order:
 *   (a) PLAIN MAIN: when A carries any NON-pinned overlay, build B = main + pinned overlays only and smoke it. B
 *       passes ⇒ adopt B and DROP A's non-pinned overlays from the list (they are what broke it — every one is
 *       reported, `overlay-dropped-smoke-failed`; with several, all are dropped as suspects, never bisected).
 *       When EVERY A failure is load-shaped ({@link isLoadShapedRow}), B is a full smoke and a B pass re-smokes A
 *       in the same run: A passes ⇒ adopt A; A reproduces a code-shaped failure ⇒ drop as above; otherwise
 *       `smoke-env-load` — adopt B (or hold when B failed too), keep every overlay, retry A with backoff.
 *   (b) otherwise the clone STAYS on its last-good build (`prevHead`, never touched) and `state.held` records
 *       why; `main-staleness.mjs#assertMainNotStale` keeps dispatching from that build (max-age alert, never a
 *       refusal), and the health watch's `daemon-held-on-last-good` sign notifies after 15 min.
 *   (c) to tell (b) apart from a broken HARNESS, the last-good build itself (C = `prevHead`, full smoke, no
 *       skip-unchanged) is smoked as a control: C failing every check A failed means the failure is the smoke's
 *       environment: adopt A as no worse by default so candidate harness fixes can arrive. With
 *       {@link HARNESS_BROKEN_ADOPT_NOT_WORSE_ENV} set to '0', hold as `smoke-harness-broken` with a retry
 *       backoff (never sticky), including across main moves (see `prepareRebuild`). Never blocks.
 * `'transient'` (env noise that survived its retries) keeps today's rule — no reject record — and also holds.
 */
async function smokeAndAdopt({
  root, env, stEnv, log, run, runSmoke, stateOpts, now, plan, prevHead, lease, overlaysBefore, prepAlerts, mainOnly,
  finalLockOpts, finalizeLockOpts = finalLockOpts,
}) {
  /** Every state write here happens UNDER the write lock (PR #2731 review: an unlocked write could clobber a
   *  sibling's locked one). `release` also drops our build lease — done by the outcome that ENDS this build,
   *  never mid-fallback (a sibling must not start a build while B/C are still being smoked). Returns the
   *  written state, or null when the lock could not be taken (the lease then lapses; the next tick retries). */
  const locked = async (mutate, { release = false } = {}) => {
    const r = await withWriteLock(root, () => {
      const st = readRebuildState(root, stEnv);
      if (release) releaseBuildLease(st, lease);
      mutate?.(st);
      writeRebuildState(root, st, stEnv);
      return st;
    }, finalLockOpts);
    if (!r.ok) log.error?.(`daemon-rebuild: could not take the write lock to record this build's outcome (${r.reason}) — nothing recorded; the next tick retries`);
    return r.ok ? r.value : null;
  };
  const alertsList = [];
  const nowIso = () => new Date(now()).toISOString();
  const alert = (kind, detail) => {
    alertsList.push({ kind, detail });
    log.error?.(`daemon-rebuild: ${kind}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ''}`);
    try {
      const file = alertsFilePath(root, stEnv);
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify({ at: nowIso(), kind, detail })}\n`, 'utf8');
    } catch { /* best-effort audit trail only */ }
  };
  const git = makeGit({ run, cwd: root, env });
  const smokeEnv = candidateSmokeEnv({ root, env });
  const adoptedHead = readRebuildState(root, stEnv).adopted?.head ?? null;

  // #4044: the files changed since the LAST LIVE-VERIFIED build (HEAD before this move, when it is the adopted
  // one) — lets the smoke skip a tree-code check whose code none of them touch (see daemon-live-smoke.mjs
  // SMOKE_CHECKS). Unknown (not the adopted head, a failed diff) ⇒ null ⇒ full smoke.
  const changedSince = (sha) => {
    if (!adoptedHead || adoptedHead !== prevHead) return null;
    // A build adopted while a lane-pool probe was SKIPPED for a busy pool (`skipped: busy pool`) was never
    // live-verified on those checks, so "unchanged since the last live-verified build" does not hold for it:
    // the next smoke runs every check (null = full smoke), or a chain of busy skips would launder the pool code.
    const busyTrees = readRebuildState(root, stEnv).busySkippedTrees;
    if (Array.isArray(busyTrees) && busyTrees.length) {
      const headTree = verifyRev(git, `${prevHead}^{tree}`);
      if (!headTree || busyTrees.includes(headTree)) return null;
    }
    const d = git(['diff', '--name-only', prevHead, sha]);
    return d.status === 0 ? String(d.stdout ?? '').split('\n').map((x) => x.trim()).filter(Boolean) : null;
  };

  /** Materialize `sha` as the candidate worktree, smoke it, tear it down. */
  const smokeSha = async (sha, changedFiles, label) => {
    // Every smoke of this build (A, then B / C) reuses the lease's own unique path, one after another.
    const candidate = materializeCandidate({
      root, sha, run, env, path: lease.path,
    });
    if (!candidate.ok) return { worktreeFailed: candidate.reason };
    let smokeResult = null;
    let threw = null;
    const t0 = now();
    try {
      smokeResult = await runSmoke({ root: candidate.path, env: smokeEnv, changedFiles });
    } catch (e) {
      threw = e;
    }
    const ms = now() - t0;
    removeCandidate({
      root, path: candidate.path, run, env,
    });
    if (ms >= SLOW_SMOKE_ALERT_MS) {
      alert('smoke-slow', {
        ms,
        ...(label ? { candidate: label } : {}),
        checks: (smokeResult?.smoke?.results || []).map((r) => `${r.name}:${r.skipped ? 'skipped' : `${r.ms}ms`}`).join(' '),
      });
    }
    return { smokeResult, threw, ms };
  };

  /** Adopt `p`, whose smoke just PASSED. fix-rebuild-finalize: the pass is recorded as the clone's ready candidate
   *  FIRST, so a lock refusal here never throws it away — the next write-lock holder (this process's next tick, or
   *  a sibling at its own tick start) adopts it without re-smoking (see prepareRebuild). */
  const finalize = async (p, onAdopted, readyMeta = { kind: 'candidate' }, smokeResult = null) => {
    // Record, BEFORE adopting, that this build's tree passed with a busy-pool skip (see `changedSince`).
    const busySkipped = (smokeResult?.smoke?.results || []).filter((r) => r.skipReason === 'busy-pool').map((r) => r.name);
    if (busySkipped.length) {
      const tree = verifyRev(git, `${p.finalSha}^{tree}`);
      alert('smoke-busy-pool-skipped', { checks: busySkipped, message: 'lane-pool probe(s) skipped under a busy pool; the next smoke re-runs every check' });
      if (tree) await locked((st) => { st.busySkippedTrees = [tree, ...(st.busySkippedTrees || []).filter((t) => t !== tree)].slice(0, 5); });
    }
    writeReadyCandidate(root, {
      ...readyMeta,
      prevHead,
      tree: verifyRev(git, `${p.finalSha}^{tree}`),
      adopt: {
        finalSha: p.finalSha, inputsKey: p.inputsKey, mainSha: p.mainSha, applied: p.applied,
      },
      token: lease.token,
      pid: process.pid,
      host: hostname(),
      passedAt: nowIso(),
    }, stEnv);
    const fin = await withWriteLock(root, () => finalizeRebuild({
      root, env, log, run, stateOpts, now, plan: p, prevHead, lease, onAdopted,
    }), finalizeLockOpts);
    if (!fin.ok) {
      if (fin.reason === 'tick-in-progress') {
        log.error?.(`daemon-rebuild: could not take the write lock to finalize ${p.finalSha} after a passing smoke (reader ${fin.heldBy ?? '?'} still ticking) — kept as the ready candidate; the next write-lock holder adopts it without re-smoking`);
      }
      return {
        moved: false, reason: fin.reason, ...(fin.heldBy ? { heldBy: fin.heldBy } : {}), plan: p, alerts: [...prepAlerts, ...alertsList],
      };
    }
    return { ...fin.value, alerts: [...prepAlerts, ...alertsList, ...fin.value.alerts] };
  };

  /** (b) — record that the clone stays on its last-good build, and why. `since` survives repeat holds. */
  const hold = async (reason, failed, extra = {}, mutateMore) => {
    let since = null;
    const state = (await locked((st) => {
      mutateMore?.(st);
      since = st.held?.since ?? nowIso();
      st.held = {
        since,
        reason,
        failed: failed.map((r) => r.name).join(','),
        details: failed.map((r) => ({ name: r.name, detail: redactDetail(r.detail) })).slice(0, 10),
        lastGood: prevHead,
        target: plan.finalSha,
        mainSha: plan.mainSha,
        updatedAt: nowIso(),
        ...extra,
      };
    }, { release: true })) ?? readRebuildState(root, stEnv);
    alert('daemon-held-on-last-good', {
      reason, failed: failed.map((r) => r.name).join(','), since: since ?? state.held?.since ?? null, lastGood: prevHead, target: plan.finalSha,
      message: 'the new build failed its live smoke — staying on the last working build and still dispatching from it (x5wbsbc)',
    });
    const staleDetail = staleAlertDetail({ moved: false, reason, plan }, state);
    if (staleDetail) alert('clone-held-stale', staleDetail);
    return state;
  };

  // ── Candidate A: main + every overlay ──────────────────────────────────────────────────────────────────
  const a = await smokeSha(plan.finalSha, changedSince(plan.finalSha), null);
  if (a.worktreeFailed) {
    await locked(null, { release: true });
    log.error?.(`daemon-rebuild: candidate-worktree-failed (${a.worktreeFailed}) — not adopting ${plan.finalSha}, retrying next tick`);
    return {
      moved: false, reason: 'candidate-worktree-failed', detail: a.worktreeFailed, plan, alerts: [...prepAlerts, ...alertsList],
    };
  }
  if (a.threw) {
    // `daemon-live-smoke.mjs` documents itself as never throwing — this is defense-in-depth only. Root was
    // never touched, so nothing to roll back; hold on last-good and let the next tick retry fresh.
    alert('smoke-threw', String(a.threw?.message || a.threw));
    await hold('smoke-threw', []);
    return { moved: false, reason: 'smoke-threw', plan, alerts: [...prepAlerts, ...alertsList] };
  }
  if (a.smokeResult.verdict === 'pass') return finalize(plan, undefined, undefined, a.smokeResult);

  const failedA = failedRows(a.smokeResult);
  if (a.smokeResult.verdict === 'auth-broken') {
    // GitHub rejected the smoke env's credential even after a forced re-mint (daemon-live-smoke.mjs): an
    // ENVIRONMENT fault, never evidence against the candidate — no reject record, no fallback/control smokes.
    alert('github-auth-broken', {
      failed: failedA.map((r) => r.name).join(','),
      ...(a.smokeResult.auth || {}),
      message: 'GitHub rejects the daemon\'s token even after a re-mint — fix the App credentials; the clone stays on its last-good build meanwhile',
    });
    await hold('github-auth-broken', failedA);
    return { moved: false, reason: 'github-auth-broken', plan, alerts: [...prepAlerts, ...alertsList] };
  }
  if (a.smokeResult.verdict === 'env-timeout') {
    // A check ran out of TIME twice (the second time with every budget widened) — the host is overloaded, which
    // plain main and last-good would hit identically (live 2026-09-26 22:37Z: lane-pool-list over its 120s scan
    // budget at load ~25 got #2773 dropped as a "suspect"). ENVIRONMENT: no reject record, no fallback/control
    // smokes, no overlay suspects. Hold on last-good; the next tick re-smokes and adopts once the host recovers.
    const et = a.smokeResult.envTimeout || {};
    alert('smoke-env-timeout', {
      failed: failedA.map((r) => r.name).join(','),
      details: failedA.map((r) => ({ name: r.name, ms: r.ms, detail: redactDetail(r.detail) })),
      ...(et.budgetFactor ? { retriedWithBudgetFactor: et.budgetFactor } : {}),
      ...(et.loadAvg ? { loadAvg: et.loadAvg } : {}),
      message: 'a smoke check ran out of time even with widened budgets — the host is overloaded, not the candidate; staying on last-good and re-checking next tick',
    });
    await hold('smoke-env-timeout', failedA);
    return { moved: false, reason: 'smoke-env-timeout', plan, alerts: [...prepAlerts, ...alertsList] };
  }
  if (a.smokeResult.verdict !== 'code') {
    // 'transient' — never poison the reject-cache; hold on last-good (still dispatching), retry next tick.
    alert('smoke-transient');
    await hold('smoke-transient', failedA);
    return { moved: false, reason: 'smoke-transient', plan, alerts: [...prepAlerts, ...alertsList] };
  }

  // Record A's rejection exactly as before (sticky until the inputs move, or backoff for external-only).
  // `priorRejected` keeps the record this overwrites: a repeat `smoke-harness-broken` needs its attempt count
  // to grow the backoff (see step (c) below).
  let priorRejected = null;
  {
    const failedNames = failedA.map((r) => r.name).join(',');
    let rejected = null;
    await locked((st) => {
      priorRejected = st.rejected;
      const prev = st.rejected?.inputsKey === plan.inputsKey ? st.rejected : null;
      st.rejected = { inputsKey: plan.inputsKey, reason: failedNames, at: nowIso() };
      if (isExternalOnlyFailure(failedA)) {
        const attempts = (prev?.externalOnly ? (prev.attempts || 1) : 0) + 1;
        const delay = rejectRetryDelayMs(env, attempts);
        Object.assign(st.rejected, { externalOnly: true, attempts, retryAt: new Date(now() + delay).toISOString() });
      }
      rejected = st.rejected;
    });
    alert('smoke-rejected', {
      failed: failedNames,
      details: failedA.map((r) => ({ name: r.name, detail: redactDetail(r.detail) })),
      ...(rejected?.retryAt ? { retryAt: rejected.retryAt, attempts: rejected.attempts } : {}),
      ...(rejected ? {} : { recorded: false }),
    });
  }

  // ── (a) plain main: drop every NON-pinned overlay and try again ──────────────────────────────────────
  const rawByRef = new Map((overlaysBefore || []).map((o) => [o?.ref, o]));
  const withPin = plan.applied.map((ap) => ({
    ...ap, pinned: pinnedStatus(git, rawByRef.get(ap.ref) ?? {}, plan.mainSha, ap.sha).pinned,
  }));
  const suspects = withPin.filter((ap) => !ap.pinned);
  let bFailed = null;
  // See LOAD_CONTENTION_SIGNATURES' header: every A row load-shaped ⇒ the same-run differential decides.
  const loadOnly = loadDifferentialEnabled(env) && failedA.length > 0 && failedA.every((r) => isLoadShapedRow(r, env));
  const envLoadRecord = (st) => {
    const prev = st.rejected?.envLoad && st.rejected?.inputsKey === plan.inputsKey ? st.rejected
      : (priorRejected?.envLoad && priorRejected?.inputsKey === plan.inputsKey ? priorRejected : null);
    const attempts = (prev?.attempts || 0) + 1;
    st.rejected = {
      inputsKey: plan.inputsKey,
      reason: failedA.map((r) => r.name).join(','),
      at: nowIso(),
      envLoad: true,
      attempts,
      retryAt: new Date(now() + envLoadRetryDelayMs(env, attempts)).toISOString(),
    };
    return st.rejected;
  };
  const envLoadAlert = (extra) => alert('smoke-env-load', {
    failed: failedA.map((r) => r.name).join(','),
    details: failedA.map((r) => ({ name: r.name, ms: r.ms, detail: redactDetail(r.detail) })),
    suspects: suspects.map((ap) => ({ ref: ap.ref, pr: ap.pr })),
    ...extra,
    message: 'every failed check is load-shaped (timeout / lock contention) and no same-run differential pinned it on an overlay — environment, not the candidate; overlays kept, retrying with backoff',
  });
  if (!mainOnly && suspects.length > 0) {
    const pinnedOverlays = withPin.filter((ap) => ap.pinned).map((ap) => ({ ...(rawByRef.get(ap.ref) ?? {}), ref: ap.ref, pr: ap.pr }));
    const planB = await planRebuild({
      git, headSha: prevHead, mainRef: 'origin/main', overlays: pinnedOverlays,
    });
    if (planB.ok) {
      const suspectInfo = suspects.map((ap) => ({ ref: ap.ref, pr: ap.pr }));
      alert('fallback-plain-main', {
        failed: failedA.map((r) => r.name).join(','), suspects: suspectInfo, target: planB.finalSha,
        message: 'main + overlays failed the live smoke — retrying plain main (pinned overlays only) (x5wbsbc)',
      });
      const failedNames = failedA.map((r) => r.name).join(',');
      const dropSuspects = ({ alert: finAlert }) => dropSuspectOverlays({
        root, env, suspects: suspectInfo, failed: failedNames, alert: finAlert,
      });
      const fallbackReady = {
        // Each suspect's failing sha rides along, so a later adoption after main moved can tell that the suspect
        // itself did not (matchReadyCandidate's `fallback-main-moved`).
        kind: 'fallback', forInputsKey: plan.inputsKey, dropRefs: suspects.map((ap) => ({ ref: ap.ref, pr: ap.pr, sha: ap.sha })), failed: failedNames,
      };
      // Plain main IS the build already running (an overlay was just added onto an otherwise-current clone) and
      // that build is the smoke-verified one: nothing to smoke, just drop the suspect(s).
      // A load-shaped failure never takes this shortcut: an earlier pass is not a SAME-RUN differential.
      if (!loadOnly && planB.finalSha === prevHead && adoptedHead === prevHead) {
        const fin = await finalize(planB, dropSuspects, fallbackReady);
        return { ...fin, reason: 'fallback-plain-main', fallback: { from: plan.finalSha, to: planB.finalSha, dropped: suspectInfo } };
      }
      const b = await smokeSha(planB.finalSha, loadOnly ? null : changedSince(planB.finalSha), 'plain-main');
      const bPassed = !b.worktreeFailed && !b.threw && b.smokeResult?.verdict === 'pass';
      if (bPassed && loadOnly) {
        // Same-run differential, second half: re-smoke A now that plain main passed.
        const a2 = await smokeSha(plan.finalSha, null, 'confirm');
        if (!a2.worktreeFailed && !a2.threw && a2.smokeResult?.verdict === 'pass') {
          alert('smoke-load-confirm-passed', {
            failed: failedNames, suspects: suspectInfo,
            message: 'A failed under load, plain main passed, A re-smoked passed — load, not the overlay; adopting A with every overlay kept',
          });
          const fin = await finalize(plan, undefined, undefined, a2.smokeResult);
          return { ...fin, reason: fin.adopted ? 'smoke-load-confirm-passed' : fin.reason };
        }
        const failedA2 = a2.smokeResult ? failedRows(a2.smokeResult) : [];
        const failedNamesA = new Set(failedA.map((r) => r.name));
        const reproduced = failedA2.some((r) => failedNamesA.has(r.name) && !isLoadShapedRow(r, env));
        if (!reproduced) {
          envLoadAlert({ plainMain: 'passed', confirm: failedA2.map((r) => r.name).join(',') || (a2.worktreeFailed ? `worktree: ${a2.worktreeFailed}` : 'threw') });
          // Plain main passed: adopt it so the clone stays current, keep every overlay, back A off.
          const recordBackoff = () => {
            const st = readRebuildState(root, stEnv);
            envLoadRecord(st);
            writeRebuildState(root, st, stEnv);
          };
          const fin = await finalize(planB, recordBackoff, { kind: 'candidate' }, b.smokeResult);
          return { ...fin, reason: fin.adopted ? 'smoke-env-load' : fin.reason };
        }
        // A reproduced a code-shaped failure on a check it already failed, while plain main passed: genuine.
      }
      if (bPassed) {
        const fin = await finalize(planB, dropSuspects, fallbackReady, b.smokeResult);
        return { ...fin, reason: 'fallback-plain-main', fallback: { from: plan.finalSha, to: planB.finalSha, dropped: suspectInfo } };
      }
      bFailed = b.smokeResult ? failedRows(b.smokeResult) : null;
      alert('fallback-plain-main-failed', {
        failed: (bFailed || []).map((r) => r.name).join(',') || (b.worktreeFailed ? `worktree: ${b.worktreeFailed}` : 'threw'),
      });
      if (loadOnly) {
        // Plain main failed too, under the same load: environment. No last-good control (it would fail the same
        // way and read as a broken harness), no drop — hold and retry A with backoff.
        envLoadAlert({ plainMain: (bFailed || []).map((r) => r.name).join(',') || 'unavailable' });
        await hold('smoke-env-load', failedA, {}, (st) => { envLoadRecord(st); });
        return { moved: false, reason: 'smoke-env-load', plan, alerts: [...prepAlerts, ...alertsList] };
      }
    } else {
      alert('fallback-plain-main-unplannable', { reason: planB.reason });
    }
  }

  // ── (c) control: smoke the LAST-GOOD build itself — does the harness fail it the same way? ────────────
  const c = await smokeSha(prevHead, null, 'last-good');
  const cFailed = c.smokeResult ? failedRows(c.smokeResult) : null;
  const harnessBroken = !!(cFailed && failsSameChecks(failedA, cFailed));
  if (harnessBroken) {
    if (env[HARNESS_BROKEN_ADOPT_NOT_WORSE_ENV] !== '0') {
      alert('smoke-harness-broken-adopted-not-worse', {
        failed: failedA.map((r) => r.name).join(','),
        alsoFailedOn: bFailed ? ['plain-main', 'last-good'] : ['last-good'],
        message: 'last-good failed every check the candidate failed — adopting the candidate as no worse so a candidate harness fix can arrive',
      });
      const fin = await finalize(plan, undefined, undefined, a.smokeResult);
      return { ...fin, reason: fin.adopted ? 'harness-broken-adopted-not-worse' : fin.reason };
    }
    const prevAttempts = priorRejected?.harnessBroken ? (priorRejected.attempts || 1) : 0;
    const attempts = prevAttempts + 1;
    const retryAt = new Date(now() + rejectRetryDelayMs(env, attempts)).toISOString();
    alert('smoke-harness-broken', {
      failed: failedA.map((r) => r.name).join(','),
      details: cFailed.map((r) => ({ name: r.name, detail: redactDetail(r.detail) })),
      alsoFailedOn: bFailed ? ['plain-main', 'last-good'] : ['last-good'],
      retryAt,
      attempts,
      message: 'the smoke fails the LAST-GOOD build the same way — the smoke harness/environment is broken, not the candidate; never blocks: staying on last-good and dispatching (x5wbsbc)',
    });
    // The rejection record and the hold are written together, in the one locked write that ends this build.
    await hold('smoke-harness-broken', failedA, {}, (st) => {
      st.rejected = {
        ...(st.rejected || {}), inputsKey: plan.inputsKey, harnessBroken: true, attempts, retryAt,
      };
    });
    return { moved: false, reason: 'smoke-harness-broken', plan, alerts: [...prepAlerts, ...alertsList] };
  }
  if (!c.smokeResult) alert('last-good-control-unavailable', { reason: c.worktreeFailed ?? String(c.threw?.message || c.threw) });
  await hold('smoke-rejected', failedA, { controlPassed: !!(c.smokeResult && c.smokeResult.verdict === 'pass') });
  return { moved: false, reason: 'smoke-rejected', plan, alerts: [...prepAlerts, ...alertsList] };
}

// ── dryRunRebuild — STRICTLY read-only on `root` ────────────────────────────────────────────────────────────

/**
 * Preview what {@link rebuildClone} would do, WITHOUT ever writing an object/ref or moving anything in `root`.
 * Every command run directly against `root` is read-only (`rev-parse`, `symbolic-ref`, `status --porcelain`,
 * `remote get-url`, `rev-list`, `cherry`) and carries `GIT_OPTIONAL_LOCKS=0`; the actual merge-tree/commit-tree
 * computation happens in a disposable scratch bare repo that borrows `root`'s objects via
 * `objects/info/alternates` and does its OWN fresh fetch (never touching `root`'s remote-tracking refs).
 * `extraOverlays` (array of `{ref, pr}`) is appended AFTER the stored overlay list, VIRTUALLY — it is never
 * written to the overlay state file, only fed into this one `planRebuild` call, so a preview of "what if I
 * registered this ref too" (`daemon-load-overlay.mjs --dry-run`) never mutates anything on disk.
 * @param {{root:string, env?:NodeJS.ProcessEnv, prState?:(pr:number)=>(Promise<string|null>|string|null),
 *   originUrl?:string, run?:typeof gitRun, extraOverlays?:Array<{ref:string, pr?:number|null}>}} o
 * @returns {Promise<{dryRun:true, head:string|null, onMain:boolean|null, unsafe:object, plan:object,
 *   wouldDo:'nothing'|'nothing (still-rejected)'|'rebuild-and-smoke'|'refuse', overlayFile:string,
 *   overlays:Array<object>, overlayStateCorrupt:boolean, state:object, stillRejected:boolean}>}
 */
export async function dryRunRebuild({
  root, env = process.env, prState, originUrl, run = gitRun, extraOverlays = [],
} = {}) {
  const rootGit = makeGit({ run, cwd: root, env, extraEnv: { GIT_OPTIONAL_LOCKS: '0' } });

  const head = verifyRev(rootGit, 'HEAD');
  const headRef = rootGit(['symbolic-ref', '--short', 'HEAD']);
  const onMain = headRef.status === 0 ? String(headRef.stdout ?? '').trim() === 'main' : null;
  const unsafe = findUnsafeLocalState({ git: rootGit });

  const overlayFile = overlayFilePath(root, env);
  const overlayState = readOverlayState(root, { env });
  const overlayStateCorrupt = overlayState.corrupt;
  const overlays = overlayState.overlays.concat(extraOverlays);
  const state = readRebuildState(root, env);

  let url = originUrl;
  if (!url) {
    const urlRes = rootGit(['remote', 'get-url', 'origin']);
    url = urlRes.status === 0 ? String(urlRes.stdout ?? '').trim() : null;
  }

  let scratchDir = null;
  let plan = { ok: false, reason: 'no-origin-url' };
  let untrackedCollision = [];
  try {
    if (url && head) {
      scratchDir = mkdtempSync(join(tmpdir(), 'we-daemon-rebuild-dryrun-'));
      const init = spawnSync('git', ['init', '--bare', '-q', scratchDir], {
        encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL',
      });
      if (init.status !== 0) {
        plan = { ok: false, reason: 'scratch-init-failed' };
      } else {
        const gitCommonRes = rootGit(['rev-parse', '--git-common-dir']);
        const gitCommonRaw = gitCommonRes.status === 0 ? String(gitCommonRes.stdout ?? '').trim() : null;
        const gitCommonDir = gitCommonRaw
          ? (isAbsolute(gitCommonRaw) ? gitCommonRaw : resolvePath(root, gitCommonRaw))
          : null;
        if (!gitCommonDir) {
          plan = { ok: false, reason: 'git-common-dir-failed' };
        } else {
          const alternatesFile = join(scratchDir, 'objects', 'info', 'alternates');
          mkdirSync(dirname(alternatesFile), { recursive: true });
          writeFileSync(alternatesFile, `${join(gitCommonDir, 'objects')}\n`, 'utf8');

          const scratchGit = makeGit({ run, cwd: scratchDir, env });
          scratchGit(['remote', 'add', 'origin', url]);
          fetchMainAndOverlays({ git: scratchGit, overlays });

          plan = await planRebuild({
            git: scratchGit,
            headSha: head,
            mainRef: 'origin/main',
            overlays,
            prState: prState || ((pr) => defaultPrState({ pr, root })),
            mainOnly: false,
          });

          // Same untracked-collision check `doRebuild` runs before its real `reset --hard` (see
          // findUnsafeLocalState's header) — computed here against the scratch repo, which shares `root`'s
          // objects via the alternates file above, so `cat-file -e <finalSha>:<path>` needs no extra fetch.
          if (plan.ok && unsafe.untracked.length > 0) {
            untrackedCollision = unsafe.untracked.filter(
              (p) => scratchGit(['cat-file', '-e', `${plan.finalSha}:${p}`]).status === 0,
            );
          }
        }
      }
    }
  } finally {
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  }

  const retryDue = Number.isFinite(Date.parse(state.rejected?.retryAt || '')) && Date.now() >= Date.parse(state.rejected.retryAt);
  const stillRejected = !!(plan.ok && state.rejected?.inputsKey === plan.inputsKey && !retryDue);

  let wouldDo = 'refuse';
  if (unsafe.safe && onMain === true && plan.ok) {
    if (untrackedCollision.length > 0 || overlayStateCorrupt) wouldDo = 'refuse'; // mirrors doRebuild's refusals
    else if (plan.finalSha === head) wouldDo = 'nothing';
    else if (stillRejected) wouldDo = 'nothing (still-rejected)';
    else wouldDo = 'rebuild-and-smoke';
  }

  return {
    dryRun: true, head, onMain, unsafe, plan, wouldDo, overlayFile, overlays, overlayStateCorrupt, state,
    stillRejected, untrackedCollision,
  };
}

// ── overlay-conflict guard (`scripts/daemon-overlay.mjs add`, epic #3383/#4075) ─────────────────────────────

/** Best-effort extraction of the file path(s) a `git merge-tree` conflict names, from TWO independent sources
 *  in its own stdout so neither shape's absence loses the path: the `CONFLICT (<kind>): ... in <path>` message
 *  line, and the raw numbered-stage index lines (`<mode> <oid> <stage>\t<path>`) `--write-tree` always emits
 *  for a conflicted path regardless of message wording. A rename/delete conflict's message can name two paths
 *  on one line ("deleted in HEAD and renamed ... in <path>") — the stage lines still pin the single path that
 *  actually landed in the index, which is what matters for "which file", so they are authoritative;
 *  the message regex is only the fallback when no stage line is present. */
function parseMergeTreeConflictFiles(output) {
  const stagePaths = new Set();
  const msgPaths = new Set();
  for (const line of String(output ?? '').split('\n')) {
    const stage = /^\d+\s+[0-9a-f]{7,40}\s+[123]\t(.+)$/.exec(line);
    if (stage) { stagePaths.add(stage[1].trim()); continue; }
    // Non-greedy: the FIRST ` in ` ends the prose. A rename/delete message carries later ` in HEAD.` / ` in tree.`.
    const msg = /^CONFLICT \([^)]*\):.*? in (\S.*)$/.exec(line.trim());
    if (msg) msgPaths.add(msg[1].trim());
  }
  // Stage lines are authoritative: when any exist the message text is never consulted (its wording can name
  // refs and oids after the path).
  return [...(stagePaths.size ? stagePaths : msgPaths)];
}

/**
 * TASK — `scripts/daemon-overlay.mjs add`'s pre-registration GUARD (live incident: `lane/promote-stale-green`
 * / #2826 was registered at 19:53Z while KNOWINGLY conflicting with `lane/fix-procedure` / #2821 in
 * `scripts/conveyor/review-status-tag.mjs` — nothing refused it, so the next rebuild silently drops #2826 and
 * the fix it carries never goes live). Answers one narrow, register-time question: does `ref` (the candidate
 * overlay) merge cleanly against `origin/main` PLUS every ALREADY-registered overlay, applied in the SAME list
 * order {@link planRebuild} itself uses for a real rebuild — and if not, which file(s) and which registered
 * overlay(s) it conflicts with.
 *
 * READ-ONLY, exactly like {@link dryRunRebuild}: every command against `root` is read-only, and the actual
 * merge-tree/commit-tree computation happens in a disposable scratch bare repo that borrows `root`'s objects
 * via `objects/info/alternates` and does its OWN fresh fetch — `root`'s remote-tracking refs, working tree,
 * index and refs are never touched, so this needs no lock (same posture `daemon-overlay.mjs`'s own file header
 * already documents for `add`/`remove`).
 *
 * DISTINCT FROM {@link dryRunRebuild}'s own `extraOverlays` preview, which asks the WHOLE-REBUILD question
 * ("what would the clone actually build with this ref folded in" — a conflicting entry is silently DROPPED
 * there, `ok:true` either way, because a real rebuild must never let one bad overlay refuse the whole clone).
 * This function asks the narrower, REGISTRATION-time question and surfaces the conflict as the primary
 * result precisely because the caller (`add`) has a THIRD option `dryRunRebuild`'s own caller does not:
 * refuse to register at all.
 * @param {{root:string, ref:string, pr?:number|null, existingOverlays:Array<{ref:string,pr?:number|null}>,
 *   env?:NodeJS.ProcessEnv, originUrl?:string, run?:typeof gitRun}} o
 * `setAside` (every result) lists already-registered PINNED overlays that no longer fold onto main and were
 * left out of the check — the caller must surface them, since a real rebuild refuses until they are fixed.
 * @returns {Promise<{ok:true, clean:true, mainSha:string, cur:string, candSha:string, setAside:Array<object>}
 *   |{ok:true, clean:false, mainSha:string, cur:string, candSha:string, files:string[],
 *      conflicting:Array<{ref:string,pr:number|null}>, setAside:Array<object>}
 *   |{ok:false, reason:string, detail?:object, setAside?:Array<object>}>}
 */
export async function previewOverlayConflict({
  root, ref, pr = null, existingOverlays, env = process.env, originUrl, run = gitRun,
} = {}) {
  if (!isSafeBranchName(ref)) return { ok: false, reason: 'unsafe-ref' };
  const rootGit = makeGit({ run, cwd: root, env, extraEnv: { GIT_OPTIONAL_LOCKS: '0' } });

  let url = originUrl;
  if (!url) {
    const urlRes = rootGit(['remote', 'get-url', 'origin']);
    url = urlRes.status === 0 ? String(urlRes.stdout ?? '').trim() : null;
  }
  if (!url) return { ok: false, reason: 'no-origin-url' };

  const scratchDir = mkdtempSync(join(tmpdir(), 'we-daemon-overlay-guard-'));
  try {
    const init = spawnSync('git', ['init', '--bare', '-q', scratchDir], {
      encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL',
    });
    if (init.status !== 0) return { ok: false, reason: 'scratch-init-failed' };

    const gitCommonRes = rootGit(['rev-parse', '--git-common-dir']);
    const gitCommonRaw = gitCommonRes.status === 0 ? String(gitCommonRes.stdout ?? '').trim() : null;
    const gitCommonDir = gitCommonRaw ? (isAbsolute(gitCommonRaw) ? gitCommonRaw : resolvePath(root, gitCommonRaw)) : null;
    if (!gitCommonDir) return { ok: false, reason: 'git-common-dir-failed' };

    const alternatesFile = join(scratchDir, 'objects', 'info', 'alternates');
    mkdirSync(dirname(alternatesFile), { recursive: true });
    writeFileSync(alternatesFile, `${join(gitCommonDir, 'objects')}\n`, 'utf8');

    const scratchGit = makeGit({ run, cwd: scratchDir, env });
    scratchGit(['remote', 'add', 'origin', url]);
    const allRefs = existingOverlays.concat([{ ref, pr }]);
    const fetched = fetchMainAndOverlays({ git: scratchGit, overlays: allRefs });
    if (!fetched.ok) return { ok: false, reason: 'fetch-failed' };

    const mainSha = verifyRev(scratchGit, 'origin/main^{commit}');
    if (!mainSha) return { ok: false, reason: 'main-unresolved' };

    // 1. Fold every ALREADY-registered overlay, in list order — the SAME `planRebuild` a real rebuild runs —
    // to compute `cur`, the exact tree the candidate would land on top of (never re-derived by hand here).
    // A PINNED overlay that no longer folds (it conflicts with main, or its PR/ref is gone) makes `planRebuild`
    // refuse the whole plan, naming that overlay. That is a problem with the EXISTING list, not with the
    // candidate — so set it aside, re-plan without it, and REPORT it (`setAside`), rather than refusing every
    // unrelated add until someone repairs the stuck overlay (PR #2827 review). Any other plan failure still
    // fails closed.
    const setAside = [];
    let folding = existingOverlays;
    let planExisting;
    for (;;) {
      planExisting = await planRebuild({
        git: scratchGit, headSha: mainSha, mainRef: 'origin/main', overlays: folding,
        prState: (p) => defaultPrState({ pr: p, root }),
      });
      const stuckRef = !planExisting.ok && /^pinned-overlay-/.test(planExisting.reason) ? planExisting.detail?.ref : null;
      if (!stuckRef || !folding.some((o) => o.ref === stuckRef)) break;
      setAside.push({
        ref: stuckRef, pr: planExisting.detail.pr ?? null, reason: planExisting.reason, dropReason: planExisting.detail.dropReason,
      });
      folding = folding.filter((o) => o.ref !== stuckRef);
    }
    if (!planExisting.ok) return { ok: false, reason: 'existing-overlays-unresolved', detail: planExisting, setAside };
    const cur = planExisting.finalSha;

    // 2. The candidate's own tip (already fetched above).
    const candSha = fetched.goneRefs.includes(ref) ? null : verifyRev(scratchGit, `origin/${ref}^{commit}`);
    if (!candSha) return { ok: false, reason: 'ref-unresolved' };

    // 3. THE CHECK — deliberately WITH messages (unlike planRebuild's own internal folds), so a real conflict
    // names its file(s) for the refusal/`--allow-conflict` print.
    const mt = scratchGit(['merge-tree', '--write-tree', cur, candSha]);
    if (mt.status === 0) return { ok: true, clean: true, mainSha, cur, candSha, setAside };

    // Only status 1 is merge-tree's documented "merge had conflicts". Anything else (unrelated histories, a
    // missing object, a crash) proves nothing about mergeability — it must fail closed as `ok:false`, never read
    // as a confirmed conflict that `--allow-conflict` could then override (PR #2827 review).
    const files = mt.status === 1 ? parseMergeTreeConflictFiles(mt.stdout) : [];
    if (files.length === 0) {
      return {
        ok: false, reason: 'merge-tree-failed', setAside,
        detail: { status: mt.status, stderr: String(mt.stderr ?? '').trim().slice(0, 500) },
      };
    }

    // 4. Attribute: which already-registered overlay(s) ALSO touch one of the conflicting files, off the SAME
    // object data (a `git diff --name-only` against main), never a guess at intent.
    const conflicting = [];
    for (const o of existingOverlays) {
      const ovSha = verifyRev(scratchGit, `origin/${o.ref}^{commit}`);
      if (!ovSha) continue;
      // Three-dot: only what the overlay ITSELF changed since it branched — a two-dot diff would also count main's later edits.
      const d = scratchGit(['diff', '--name-only', `${mainSha}...${ovSha}`]);
      if (d.status !== 0) continue;
      const touched = new Set(String(d.stdout ?? '').split('\n').filter(Boolean));
      if (files.some((f) => touched.has(f))) conflicting.push({ ref: o.ref, pr: o.pr ?? null });
    }

    return { ok: true, clean: false, mainSha, cur, candSha, files, conflicting, setAside };
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────────
// `node scripts/lib/daemon-rebuild.mjs --clone=<path> [--dry-run] [--json]`

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

async function runCli(argv) {
  const flags = parseFlags(argv);
  const clone = typeof flags.clone === 'string' ? flags.clone : null;
  if (!clone) {
    process.stderr.write('daemon-rebuild: --clone=<path> is required\n');
    process.exitCode = 2;
    return;
  }
  const root = resolvePath(clone);

  if (flags['dry-run']) {
    const result = await dryRunRebuild({ root });
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      process.stdout.write(
        `daemon-rebuild --dry-run: ${root} onMain=${result.onMain} safe=${result.unsafe.safe} `
        + `wouldDo=${result.wouldDo} finalSha=${result.plan?.finalSha ?? 'n/a'}\n`,
      );
    }
    return;
  }

  const result = await rebuildClone({ root });
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(`daemon-rebuild: ${root} moved=${result.moved} reason=${result.reason || ''}\n`);
    for (const a of result.alerts || []) process.stdout.write(`  ! ${a.kind}\n`);
  }
}

const IS_CLI = process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url));
if (IS_CLI) {
  runCli(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`daemon-rebuild: fatal: ${String((e && e.message) || e)}\n`);
    process.exitCode = 1;
  });
}
