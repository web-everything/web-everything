/** @file scripts/lib/daemon-rebuild/rebuild.mjs — `rebuildClone`, the IO shell that runs the three phases
 * (locked prepare → unlocked candidate smoke → locked finalize). Split out of daemon-rebuild.mjs (move-only); the
 * design notes it refers to as "the file header" are the header of `scripts/lib/daemon-rebuild.mjs`.
 */

import { gitRun } from '../main-staleness.mjs';
import { runLiveSmokeWithRetry } from '../daemon-live-smoke.mjs';
import { withWriteLock } from '../daemon-clone-lock.mjs';
import { defaultPrState } from './edge-fetch.mjs';
import {
  REBUILD_LOCK_WAIT_ENV, DEFAULT_REBUILD_LOCK_WAIT_MS, readRebuildStarvation, starvationLockWaitMs,
  FINALIZE_LOCK_WAIT_ENV, DEFAULT_FINALIZE_LOCK_WAIT_MS, writeRebuildStarvation, releaseBuildLease,
  ACTIVE_BUILD_TOKENS,
} from './lease.mjs';
import { readReadyCandidate, readRebuildState, writeRebuildState } from './state.mjs';
import { verifyRev, makeGit } from './shared.mjs';
import { makeSkipCheck } from './skip-unrelated.mjs';
import { prepareRebuild } from './prepare.mjs';
import { smokeAndAdopt } from './smoke.mjs';
import { resolveVersionedContext, versionedRebuild } from '../daemon-version-runtime.mjs';
import { rebuildCloneAsJob, resolveRebuildAsJob } from './rebuild-job.mjs';

// ── rebuildClone — the IO shell ──────────────────────────────────────────────────────────────────────────────

/**
 * Rebuild `root` fresh from `origin/main` + its registered overlay list. See the file header (xa4qo7n) for the
 * full three-step design — {@link prepareRebuild} (locked, fast) → build + smoke a disposable candidate
 * (UNLOCKED — the live smoke never runs against `root` and never holds its write lock) →
 * {@link finalizeRebuild} (locked, fast, reached only after a passing smoke). A lock refusal at either locked
 * step is reported, never treated as an error.
 * @param {{root:string, env?:NodeJS.ProcessEnv, log?:Console, run?:typeof gitRun, runSmoke?:typeof runLiveSmokeWithRetry,
 *   prState?:(pr:number)=>(Promise<string|null>|string|null), lockOpts?:object, stateOpts?:{env?:NodeJS.ProcessEnv},
 *   mainOnly?:boolean, now?:()=>number, sleep?:(ms:number)=>Promise<void>,
 *   dispatchSmoke?:{settings?:object, run?:Function, match?:Function}}} o — `dispatchSmoke` (xhiqxz3): injected
 *   pieces of the real dispatch smoke the candidate smoke runs for a new dispatch-touching overlay (default: #4481's).
 * @returns {Promise<object>}
 */
export async function rebuildClone({
  root, env = process.env, log = console, run = gitRun, runSmoke = runLiveSmokeWithRetry,
  prState = (pr) => defaultPrState({ pr, root }), lockOpts = {}, stateOpts = {}, mainOnly = false,
  now = () => Date.now(), sleep, versions, skipCheck, entries, dispatchSmoke, readyOnly = false, adoptOnly = false,
  asJob,
} = {}) {
  // #4126 — the opted-in daemon's tick never smokes: it adopts a ready candidate (fast) and otherwise starts or
  // watches a detached rebuild JOB (`rebuild-job.mjs`). `asJob` undefined resolves from daemon-rebuild-settings.json
  // by the caller's `entries`; the job itself and the adopt-only pass inside it always run the inline path.
  if (!readyOnly && !adoptOnly && (asJob === undefined ? resolveRebuildAsJob({ entries, env }) : asJob)) {
    return rebuildCloneAsJob({
      root, env, log, mainOnly, entries,
      adopt: (o = {}) => rebuildClone({
        root, env, log, run, runSmoke, prState, lockOpts, stateOpts, mainOnly, now, sleep, versions, skipCheck, entries,
        dispatchSmoke, ...o, adoptOnly: true, asJob: false,
      }),
    });
  }
  // Card 89 S5: a versioned clone never moves in place — it builds a version and flips `current`, taking no
  // clone lock at all. `versions: null` forces the legacy path; unset resolves from the settings (default off).
  const vctx = versions === undefined ? resolveVersionedContext({ root, env }) : versions;
  if (vctx) return versionedRebuild({ ctx: vctx, log });
  // daemonRebuild.skipUnrelated (default on): `skipCheck` is injectable; else built from the daemon's `entries`.
  // #4126 readyOnly (the rebuild job) never moves `root`: no skip-unrelated adoption here (the tick's adopt-only
  // pass does that), and a ready candidate already waiting is the tick's to adopt — nothing to build.
  const skipDecider = readyOnly ? null : (skipCheck === undefined ? makeSkipCheck({ root, entries, env }) : skipCheck);
  if (readyOnly && readReadyCandidate(root, { ...env, ...(stateOpts?.env || {}) })) {
    return { moved: false, reason: 'ready-pending', alerts: [] };
  }
  const lockRootFromEnv = env && env.WE_DAEMON_CLONE_LOCK_ROOT;
  // #4044 (live 2026-09-25 10:28-10:40 ET): the fix daemon's tick-start rebuild waited SILENTLY up to the lock's
  // 600s default for the review daemon's 10-minute tick to release its read slot — no ticks, no log line. A
  // rebuild is opportunistic (the next tick retries it), so it now waits at most WE_DAEMON_REBUILD_LOCK_WAIT_MS
  // (default 60s), says so when it starts waiting, and records the give-up.
  const baseWaitMs = Number(env?.[REBUILD_LOCK_WAIT_ENV]) > 0 ? Number(env[REBUILD_LOCK_WAIT_ENV]) : DEFAULT_REBUILD_LOCK_WAIT_MS;
  const starvedCount = readRebuildStarvation(root, { ...env, ...(stateOpts?.env || {}) });
  const waitMs = starvationLockWaitMs(baseWaitMs, starvedCount, env);
  if (waitMs > baseWaitMs) log.error?.(`daemon-rebuild: starved for ${starvedCount} consecutive attempt(s) — waiting up to ${Math.round(waitMs / 1000)}s for in-flight ticks this time`);
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
    root, env, log, run, prState, stateOpts, mainOnly, now, skipCheck: skipDecider,
  }), readyOnHead ? finalizeLockOpts : finalLockOpts);

  if (prep.ok) {
    if (starvedCount > 0) writeRebuildStarvation(root, 0, stEnv);
  } else if (prep.reason === 'tick-in-progress') writeRebuildStarvation(root, starvedCount + 1, stEnv);
  if (!prep.ok) {
    if (prep.reason === 'tick-in-progress') {
      log.error?.(`daemon-rebuild: gave up after ${Math.round((now() - startedMs) / 1000)}s — reader ${prep.heldBy ?? '?'} still ticking; this tick runs on the current tree and the next one retries (#4044)`);
    } else if (prep.reason === 'reader-priority') {
      // Not counted as rebuild starvation: escalating to the long starved wait would re-block the very reader.
      log.error?.(`daemon-rebuild: backed off — reader ${prep.heldBy ?? '?'} was refused ${prep.starved ?? '?'} consecutive time(s) and has priority; nothing was moved, the next tick retries (#4044 reader fairness)`);
    }
    return { moved: false, reason: prep.reason, ...(prep.heldBy ? { heldBy: prep.heldBy } : {}) };
  }
  if (prep.value.terminal) {
    return { ...prep.value.result, alerts: prep.value.alerts };
  }
  const {
    plan, prevHead, lease, overlays: overlaysBefore = [], alerts: prepAlerts,
  } = prep.value;

  // #4126 adopt-only (the job-mode tick): never build or smoke here — hand the lease back and say a build is due.
  if (adoptOnly) {
    try {
      await withWriteLock(root, () => {
        const st = readRebuildState(root, stEnv);
        releaseBuildLease(st, lease);
        writeRebuildState(root, st, stEnv);
      }, finalLockOpts);
    } catch { /* the owner's next call takes an unreleased lease back anyway */ } finally {
      ACTIVE_BUILD_TOKENS.delete(lease.token);
    }
    return { moved: false, reason: 'needs-build', plan, alerts: prepAlerts };
  }

  // ── Phase 2 (UNLOCKED — the whole point of xa4qo7n): build + smoke a disposable candidate ───────────────
  try {
    return await smokeAndAdopt({
      root, env, stEnv, log, run, runSmoke, stateOpts, now, plan, prevHead, lease, overlaysBefore, prepAlerts, mainOnly,
      finalLockOpts, finalizeLockOpts, dispatchSmoke, readyOnly,
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
