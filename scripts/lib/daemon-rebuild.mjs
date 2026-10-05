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

// The code lives in `./daemon-rebuild/` (move-only split, one file per concern; `./daemon-rebuild/index.mjs` is
// the re-export surface). This file stays the compatibility entry point and the CLI, so no caller changes.
export * from './daemon-rebuild/index.mjs';

import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rebuildClone, dryRunRebuild } from './daemon-rebuild/index.mjs';

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
