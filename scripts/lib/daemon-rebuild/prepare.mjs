/** @file scripts/lib/daemon-rebuild/prepare.mjs — Locked preparation phase.
 * Split out of daemon-rebuild.mjs (move-only).
 */

import { makeGit, verifyRev, OVERLAY_EDGE_RESOLVE_ENV } from './shared.mjs';
import {
  alertsFilePath, readRebuildState, writeRebuildState, clearReadyCandidate, readReadyCandidate,
} from './state.mjs';
import { mkdirSync, appendFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  READY_MAX_AGE_ENV, DEFAULT_READY_MAX_AGE_MS, claimBuildLease, buildLeaseIsLive,
} from './lease.mjs';
import {
  staleAlertDetail, matchReadyCandidate, readyBuildVerified, finalizeRebuild, dropSuspectOverlays,
} from './adopt.mjs';
import { hostname } from 'node:os';
import {
  findUnsafeLocalState, knownInputsOf, rollbackUnverified, collectUntrackedPaths, ensureSafeToMove,
  pruneLandedBacklogSidecars,
} from './local-state.mjs';
import { readOverlayState, overlayFilePath, removeOverlay, appendOverlayEvent } from '../daemon-overlays.mjs';
import { fetchMainAndOverlays, recordedEdgeSha } from './edge-fetch.mjs';
import { planRebuild } from './plan.mjs';
import { repairCloneRefs } from '../lane-repair.mjs';
import {
  markOverlayConflictWake, readOverlayConflictWakes, clearOverlayConflictWake,
} from '../overlay-conflict-wake.mjs';

/**
 * Phase 1 (LOCKED, fast — no smoke, no `reset --hard`): recovery, safety, fetch, `planRebuild`, overlay-list
 * edits, and the up-to-date/still-rejected/untracked-collision short-circuits — everything the old single-phase
 * `doRebuild` did in its Steps 0-4.5. Returns EITHER `{terminal:true, result, alerts}` (a final `rebuildClone`
 * result — the caller returns it as-is) or `{terminal:false, plan, prevHead, alerts}` (proceed to build +
 * smoke a candidate — see {@link rebuildClone}).
 */
export async function prepareRebuild({
  root, env, log, run, prState, stateOpts, mainOnly, now, skipCheck,
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
  const edgeResolve = env[OVERLAY_EDGE_RESOLVE_ENV] !== '0';
  // Heal dangling remote-tracking refs (and a clone that is itself broken) BEFORE the fetch: one such ref makes
  // `fetch --prune` reject the whole batch. Daemon clones are never acquired through lane-pool, so this is their only heal.
  const cloneRepair = repairCloneRefs(root, { log: (m) => log?.error?.(m) });
  if (cloneRepair.pruned.length || cloneRepair.reported.length || cloneRepair.quarantinedTo || !cloneRepair.ok) {
    alert('clone-refs-repaired', { pruned: cloneRepair.pruned.length, reported: cloneRepair.reported, quarantinedTo: cloneRepair.quarantinedTo ?? null, problems: cloneRepair.problems });
  }
  const fetchResult = fetchMainAndOverlays({ git, overlays: overlaysBefore, edgeResolve });
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
    git, headSha: prevHead, mainRef: 'origin/main', overlays: overlaysBefore, prState, mainOnly, edgeResolve,
  });
  for (const event of plan.alerts || []) {
    alert(event.kind, event.detail);
    if (event.kind === 'overlay-conflict-unresolved' && event.detail.pr != null) {
      const { pr, ref, files } = event.detail;
      markOverlayConflictWake(env, { pr, ref, files, at: nowIso(), clone: root });
    }
  }
  for (const [pr, wake] of readOverlayConflictWakes(env, { maxAgeMs: Infinity })) {
    if (wake.clone === root && !overlaysBefore.some((o) => o.pr === pr && o.ref === wake.ref)) {
      clearOverlayConflictWake(env, pr);
    }
  }
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
    if (d.pr != null && (d.action === 'apply' || d.action === 'remove')) clearOverlayConflictWake(env, d.pr);
    if (d.action === 'remove') {
      removeOverlay(root, d.ref, { env, why: d.reason });
      appendOverlayEvent(root, { kind: 'auto-dropped', ref: d.ref, pr: d.pr, reason: d.reason }, { env });
      alert('overlay-auto-dropped', { ref: d.ref, reason: d.reason });
    } else if (d.action === 'drop') {
      alert('overlay-conflict-dropped', { ref: d.ref, reason: d.reason });
    }
  }

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
          approvedEdgeShaFor: (ref) => recordedEdgeSha((overlaysBefore || []).find((o) => o?.ref === ref)),
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

  // daemonRebuild.skipUnrelated — the move changes nothing this daemon runs (see skip-unrelated.mjs): adopt the
  // target without the candidate build + live smoke. Only from a clone that is itself on its smoke-verified
  // build (adopted === HEAD, not held), so an unverified tree is never carried forward unsmoked.
  // A sibling daemon's LIVE build lease also blocks it: it is mid-smoke on a candidate, and moving the clone
  // under it would leave its finalize running against a prevHead that no longer matches HEAD.
  // A build adopted while a lane-pool probe was SKIPPED for a busy pool (`busySkippedTrees`) was never fully
  // live-verified, so it must not be carried forward unsmoked either (same rule as smoke.mjs `changedSince`).
  const busyTrees = Array.isArray(state.busySkippedTrees) ? state.busySkippedTrees : [];
  const headTree = busyTrees.length ? verifyRev(git, `${prevHead}^{tree}`) : null;
  const busyUnverified = busyTrees.length > 0 && (!headTree || busyTrees.includes(headTree));
  if (typeof skipCheck === 'function' && state.adopted?.head === prevHead && !state.held && !state.quarantine
    && !busyUnverified && !buildLeaseIsLive(state.building, { env: stEnv, nowMs: nowMs() })) {
    // --no-renames: a renamed file must list BOTH endpoints, or a renamed-away imported module hides from the closure.
    // -z: NUL-separated, so a non-ASCII path is not C-quoted into a string that never matches a closure member.
    const diff = git(['diff', '--name-only', '-z', '--no-renames', prevHead, plan.finalSha]);
    const changedFiles = diff.status === 0 ? String(diff.stdout ?? '').split('\0').filter(Boolean) : null;
    const d = skipCheck(changedFiles);
    if (d?.skip) {
      log?.error?.(`daemon-rebuild: skipped rebuild+smoke for ${String(plan.finalSha).slice(0, 9)} — ${d.reason} (daemonRebuild.skipUnrelated)`);
      const fin = await finalizeRebuild({
        root, env, log, run, stateOpts, now, plan, prevHead, lease: { token: null },
      });
      const { alerts: finAlerts = [], ...finResult } = fin;
      return {
        terminal: true,
        result: { ...finResult, ...(finResult.adopted ? { reason: 'skipped-unrelated', skippedSmoke: true } : {}) },
        alerts: [...alertsList, ...finAlerts],
      };
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
