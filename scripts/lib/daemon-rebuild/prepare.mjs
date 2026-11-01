/** @file scripts/lib/daemon-rebuild/prepare.mjs — Locked preparation phase.
 * Split out of daemon-rebuild.mjs (move-only).
 */

import { makeGit, verifyRev, archiveUncovered, FULL_SHA_RE, OVERLAY_EDGE_RESOLVE_ENV, REBUILD_IDENTITY_ENV } from './shared.mjs';
import {
  alertsFilePath, readRebuildState, writeRebuildState, clearReadyCandidate, readReadyCandidate,
} from './state.mjs';
import { mkdirSync, appendFileSync, statSync, unlinkSync, readFileSync } from 'node:fs';
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
import {
  readOverlayState, overlayFilePath, removeOverlay, appendOverlayEvent, makePrBaseChain, resolveOverlayStackMode,
  persistStackBases, persistTipShas, reinstateOverlaySources, migrateRegistrationIds, appliedRowFor,
} from '../daemon-overlays.mjs';
import { fetchMainAndOverlays, recordedEdgeSha } from './edge-fetch.mjs';
import { planRebuild, pinnedStatus, PINNED_OVERLAY_GONE_MESSAGE } from './plan.mjs';
import { cloneRuntimeEntries } from '../daemon-clone-entries.mjs';
import { resolveClosureScopeMode } from './skip-unrelated.mjs';
import { autoRetireOverlays } from '../daemon-overlay-auto-retire.mjs';
import * as realAutoRebase from './auto-rebase.mjs';
import { healWrongBranch } from './wrong-branch-heal.mjs';
import { repairCloneRefs, holdsCloneWriteLock } from '../lane-repair.mjs';
import {
  markOverlayConflictWake, readOverlayConflictWakes, clearOverlayConflictWake,
} from '../overlay-conflict-wake.mjs';

function validTipSha(raw) {
  return typeof raw?.tipSha === 'string' && FULL_SHA_RE.test(raw.tipSha) ? raw.tipSha : null;
}

/**
 * Phase 1 (LOCKED, fast — no smoke, no `reset --hard`): recovery, safety, fetch, `planRebuild`, overlay-list
 * edits, and the up-to-date/still-rejected/untracked-collision short-circuits — everything the old single-phase
 * `doRebuild` did in its Steps 0-4.5. Returns EITHER `{terminal:true, result, alerts}` (a final `rebuildClone`
 * result — the caller returns it as-is) or `{terminal:false, plan, prevHead, alerts}` (proceed to build +
 * smoke a candidate — see {@link rebuildClone}).
 */
export async function prepareRebuild({
  root, env, log, run, prState, stateOpts, mainOnly, now, skipCheck, entries = [], prBaseChain, prForcePushes, autoRebase = realAutoRebase,
}) {
  // Tests reaching the hold must opt in before launching a detached repair or cleaning up swaps.
  if (process.env.VITEST === 'true' && env?.WE_DAEMON_AUTO_REBASE === undefined) {
    env = { ...env, WE_DAEMON_AUTO_REBASE: '0' };
  }
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

  const finishVerifiedSwaps = async () => {
    try {
      if (!state.inProgress && !state.unverified && !state.quarantine && state.adopted?.head
        && state.adopted.head === verifyRev(git, 'HEAD') && autoRebase.resolveAutoRebaseSwitch(env).enabled) {
        await autoRebase.finishPendingSwaps({ root, env, run, removeOverlay, appendOverlayEvent });
      }
    } catch (error) {
      const detail = realAutoRebase.reportNeedsYou({ root, env: stEnv, ref: 'pending-swaps', stage: 'swap', error, now: nowIso });
      alertsList.push({ kind: 'auto-rebase-needs-you', detail });
      log?.error?.(`daemon-rebuild: auto-rebase-needs-you ${JSON.stringify(detail)}`);
    }
  };

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
          await finishVerifiedSwaps();
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

  await finishVerifiedSwaps();

  // ── Step 1: must be on main, and the local tree must be safe to move ────────────────────────────────────
  let headRef = git(['symbolic-ref', '--short', 'HEAD']);
  let onMain = headRef.status === 0 ? String(headRef.stdout ?? '').trim() === 'main' : null;
  if (!onMain) {
    // A store writer that checked its branch out in THIS clone (live 2026-10-09) is healed back to main when the
    // branch is allowlisted and only store files changed; anything else still refuses (wrong-branch-heal.mjs).
    const heal = healWrongBranch({ git, now: nowMs });
    alert(heal.healed ? 'wrong-branch-healed' : 'wrong-branch-heal-refused', heal);
    if (heal.healed) {
      headRef = git(['symbolic-ref', '--short', 'HEAD']);
      onMain = headRef.status === 0 ? String(headRef.stdout ?? '').trim() === 'main' : null;
    }
  }
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
  let overlaysBefore = overlayState.overlays;
  let snapshotGeneration = overlayState.generation;
  if (!mainOnly && !overlayState.corrupt) {
    const migrated = migrateRegistrationIds(root, { env, adopted: state.adopted });
    if (migrated.adopted !== state.adopted) { state.adopted = migrated.adopted; writeState(); }
    for (const detail of migrated.unprovable) alert('overlay-registration-unprovable', detail);
    // A registration already identified by the first read cannot be replaced during migration.
    if (overlayState.overlays.length !== migrated.list.length || overlayState.overlays.some((o) => o?.registrationId
      && !migrated.list.some((m) => m?.ref === o.ref && m.registrationId === o.registrationId))) {
      alert('overlay-registration-changed', {});
      return terminal({ moved: false, reason: 'overlay-registration-changed' });
    }
    overlaysBefore = migrated.list;
    snapshotGeneration = migrated.generation;
  }
  const snap = new Map(overlaysBefore.map((o) => [o?.ref, o?.registrationId]));
  const ourRemoved = new Set();
  const ourRestored = new Map();
  const snapshotHolds = () => {
    if (mainOnly) return true;
    const fresh = readOverlayState(root, { env });
    // Check the generation again after reading: a registration writer may have run during the read.
    let generation;
    try { generation = JSON.parse(readFileSync(overlayFilePath(root, env), 'utf8')).generation ?? 0; }
    catch (error) {
      if (error.code !== 'ENOENT' || fresh.clone !== null || fresh.overlays.length) return false;
      generation = 0;
    }
    const expected = new Map([...snap, ...ourRestored]);
    return generation === snapshotGeneration && generation === fresh.generation && !fresh.corrupt && fresh.overlays.every((o) => o && expected.has(o.ref) && expected.get(o.ref) === o.registrationId)
      && [...expected.keys()].every((ref) => ourRemoved.has(ref) || fresh.overlays.some((o) => o?.ref === ref));
  };
  const registrationChanged = () => {
    alert('overlay-registration-changed', {});
    return terminal({ moved: false, reason: 'overlay-registration-changed' });
  };
  const edgeResolve = env[OVERLAY_EDGE_RESOLVE_ENV] !== '0';
  // Heal dangling remote-tracking refs (and a clone that is itself broken) BEFORE the fetch: one such ref makes
  // `fetch --prune` reject the whole batch. Daemon clones are never acquired through lane-pool, so this is their only heal.
  // prepareRebuild runs under the daemon-clone write lock (rebuild.mjs), the only place a clone may be re-cloned (#4044);
  // repairCloneRefs re-checks that lock itself and refuses without it.
  // The write lock was taken under `env`'s lock root (rebuild.mjs), so the proof must be read from that same root.
  const lockRoot = env?.WE_DAEMON_CLONE_LOCK_ROOT;
  const cloneRepair = repairCloneRefs(root, {
    log: (m) => log?.error?.(m), allowReclone: true, holdsWriteLock: (d) => holdsCloneWriteLock(d, lockRoot ? { lockRoot } : {}),
  });
  if (cloneRepair.pruned.length || cloneRepair.reportedNew.length || cloneRepair.quarantinedTo || !cloneRepair.ok) {
    alert('clone-refs-repaired', { pruned: cloneRepair.pruned.length, reported: cloneRepair.reported, quarantinedTo: cloneRepair.quarantinedTo ?? null, problems: cloneRepair.problems });
  }
  // A re-clone replaced the whole checkout: `prevHead`, `unsafe` and `state.adopted` above describe the OLD clone (its HEAD is
  // normally the deterministic overlay merge, which the fresh clone does not contain). End the tick here, before anything plans,
  // diffs or rolls back against them; the next tick re-reads HEAD and re-plans from the fresh clone.
  // The persisted state names shas of the old clone too (the adopted overlay merge, a held last-good, a passed-but-unadopted
  // candidate); none of them exists in the fresh clone, so drop them rather than let a later tick compare against them.
  if (cloneRepair.quarantinedTo) {
    for (const k of ['adopted', 'held', 'rejected', 'inProgress', 'unverified', 'quarantine', 'building', 'smokePassed']) state[k] = null;
    writeState();
    clearReadyCandidate(root, stEnv);
    return terminal({ moved: false, reason: 'clone-recloned', quarantinedTo: cloneRepair.quarantinedTo });
  }
  const fetchResult = fetchMainAndOverlays({ git, overlays: overlaysBefore, edgeResolve });
  if (fetchResult.malformed?.length) {
    alert('overlay-state-malformed', { file: overlayFilePath(root, env), malformed: fetchResult.malformed,
      message: 'Repair the overlay registry before rebuilding with overlays; mainOnly recovery remains available.' });
    if (!mainOnly) return terminal({ moved: false, reason: 'overlay-state-malformed' });
    // Recovery ignores these entries in memory and leaves the stored registry untouched for repair.
    overlaysBefore = overlaysBefore.filter((_, index) => !fetchResult.malformed.includes(index));
  }
  if (!fetchResult.ok) {
    if (unsafe.untracked.length > 0) alert('untracked-kept', { paths: unsafe.untracked });
    alert('fetch-failed');
    return terminal({ moved: false, reason: 'fetch-failed' });
  }
  for (const ref of fetchResult.goneRefs) alert('overlay-ref-gone-on-fetch', { ref });

  const fetchedMainSha = verifyRev(git, 'origin/main^{commit}');
  // Per-ref confirmation allows recorded-SHA retirement for deleted branches without trusting failed fetches
  // or names the fetch layer skipped. One unavailable ref cannot block retirement of independently verified ones.
  // Sources a retirement put back this tick were never fetched by it: they wait for the next tick's fetch
  // instead of raising unavailable alerts or a pinned hold (their container's content is already in main).
  const reinstatedNow = new Set();
  let refreshedTips = new Map();
  if (!snapshotHolds()) return registrationChanged();
  if (!mainOnly && !overlayState.corrupt && fetchedMainSha) {
    try {
      // The adopted build's applied tips are evidence for a deleted branch registered before `tipSha` was
      // recorded. Edge-resolved entries applied a resolution commit, not the overlay's own tip, so they are skipped.
      const recordedShas = new Map((state.adopted?.head === prevHead ? state.adopted.applied ?? [] : [])
        .filter((a) => appliedRowFor(state.adopted, a?.ref, snap.get(a?.ref)) === a && a.sha && !a.resolvedVia).map((a) => [a.ref, a.sha]));
      const retirementInputs = overlaysBefore.map((o) => recordedShas.has(o.ref) && !o.tipSha && !o.sha && !o.headSha
        ? { ...o, tipSha: recordedShas.get(o.ref) } : o);
      const retired = await autoRetireOverlays({ root, env, overlays: retirementInputs, git, mainSha: fetchedMainSha,
        refEvidence: fetchResult.refEvidence, recordedShas, now, appendOverlayEvent,
        removeOverlay: (r, ref, options) => {
          if (!snapshotHolds()) throw new Error('registration changed; refusing removal');
          const removed = removeOverlay(r, ref, { ...options, expectRegistrationId: snap.get(ref) });
          if (removed.removed) {
            snapshotGeneration += 1;
            ourRemoved.add(ref); snap.delete(ref);
            for (const restored of removed.reinstated ?? []) {
              ourRestored.set(restored, removed.list.find((o) => o.ref === restored)?.registrationId);
            }
          }
          return removed;
        },
        // Existing archives must survive until the proposed build proves it carries their sources.
        protectedRefs: new Set([...realAutoRebase.pendingSwapRefs({ root, env }),
          ...overlaysBefore.filter((o) => o.retiredSources?.length).map((o) => o.ref)]),
        // A refused plan must preserve the registered tips as well as the running tree. Keep this tick's
        // fresh {sha, reg} evidence in memory until both pinned and established-content checks accept the plan.
        // Preserve the identity captured before classification; never rebind it to a later same-ref registration.
        persistTipShas: (_root, tips) => { refreshedTips = tips; } });
      if (retired.auditFailures.length) alert('overlay-auto-retire-audit-failed', { failures: retired.auditFailures });
      for (const ref of retired.reinstated) reinstatedNow.add(ref);
      if (retired.retired.length) {
        // Health monitoring consumes the existing removal alert to clear earlier conflict-drop warnings.
        for (const row of retired.retired) {
          alert('overlay-auto-dropped', { ref: row.ref, reason: row.class === 'landed' ? 'in-main' : row.reason });
        }
        const fresh = readOverlayState(root, { env });
        if (!fresh.corrupt) overlaysBefore = fresh.overlays;
      }
    } catch (error) { alert('overlay-auto-retire-failed', { error: String(error?.message || error) }); }
  }
  if (!snapshotHolds()) return registrationChanged();
  // Preserve unavailable registrations without building from cached tips. Unpinned overlays may be skipped,
  // but an unavailable pin must use the normal refusal/last-good hold path before any new build is adopted.
  let overlaysForPlan = overlaysBefore.filter((o) => fetchResult.refEvidence.get(o?.ref) === 'refreshed');
  const unverified = overlaysBefore.filter((o) => fetchResult.refEvidence.get(o?.ref) !== 'refreshed' && !reinstatedNow.has(o?.ref));
  let unavailablePinned = null;
  if (!mainOnly) {
    for (const raw of unverified) {
      if (!snapshotHolds()) return registrationChanged();
      // Fetch cleanup may have deleted the tracking ref, and rebuild state may have been lost. Adopted
      // inputs (bound to this registration) or a recorded full tip identify pins only, never fresh
      // build/retirement inputs. When the running build's adopted record carries a row for this ref that is
      // NOT bound to this registration (a re-registered overlay, or an unprovable legacy row), that row is
      // another registration's evidence: this registration inherits no pin from it. The row still states
      // what is RUNNING, though: if that content changes the mechanism, building without it would revert
      // the live daemon, so hold under a distinct reason that claims nothing about this registration.
      // With no row at all, or lost/mismatched rebuild state, the pin is unknown: refuse rather than
      // silently dropping a possible mechanism overlay.
      const adoptedRows = state.adopted?.head === prevHead && Array.isArray(state.adopted?.applied)
        ? state.adopted.applied : null;
      const pinMain = state.adopted?.mainSha ?? fetchedMainSha;
      const adopted = adoptedRows ? appliedRowFor(state.adopted, raw.ref, snap.get(raw.ref)) : null;
      // Every running row for this ref not bound to this registration (duplicates included): the replacement's
      // own tip says nothing about what is RUNNING, so these rows are checked even when that tip is harmless.
      const unboundRows = adoptedRows ? adoptedRows.filter((row) => row?.ref === raw.ref && row !== adopted) : [];
      const tipSha = adopted?.sha ?? validTipSha(raw);
      let reason = 'pinned-overlay-unavailable';
      let detailSha = tipSha ?? null;
      let pin = { pinned: false };
      if (tipSha || raw.pinned === true) pin = pinnedStatus(git, raw, pinMain, tipSha);
      else if (!unboundRows.length) pin = { pinned: true, why: 'unknown' };
      for (const row of pin.pinned ? [] : unboundRows) {
        // Unparseable running evidence cannot prove the running content is harmless: fail closed.
        const rowSha = FULL_SHA_RE.test(row?.sha ?? '') ? row.sha : null;
        const rowPin = rowSha ? pinnedStatus(git, raw, pinMain, rowSha) : { pinned: true, why: 'unknown' };
        if (!rowPin.pinned) continue;
        pin = rowPin;
        reason = 'pinned-overlay-unbound';
        detailSha = rowSha;
        break;
      }
      // pinnedStatus runs Git; the list may be re-registered meanwhile. Never refuse for a replaced registration.
      if (!snapshotHolds()) return registrationChanged();
      if (!pin.pinned) continue;
      unavailablePinned = {
        ok: false, reason,
        detail: { ref: raw.ref, pr: raw.pr ?? null, registrationId: snap.get(raw.ref) ?? null, sha: detailSha,
          dropReason: 'ref-unavailable', pinnedBy: pin.why,
          message: reason === 'pinned-overlay-unbound'
            ? 'the running build carries mechanism changes for this ref under an earlier registration, and the branch is unavailable — restore the branch, or remove the overlay to drop that content deliberately'
            : PINNED_OVERLAY_GONE_MESSAGE },
      };
      break;
    }
  }
  if (!snapshotHolds()) return registrationChanged();
  if (!mainOnly && unverified.length && !unavailablePinned) {
    const detail = { refs: unverified.map((o) => o?.ref), message: 'Overlay tips unavailable; preserving registrations and skipping these overlays for this rebuild. Retrying next tick; restore or re-register deleted branches from their recorded SHA.' };
    alert('overlay-fetch-unverifiable', detail);
  }
  pruneLandedBacklogSidecars({ git, root, paths: unsafe.untracked, mainSha: fetchedMainSha, alert });
  const remaining = collectUntrackedPaths(git);
  if (remaining === null) {
    alert('status-failed', 'Post-cleanup ls-files --others failed');
    return terminal({ moved: false, reason: 'status-failed' });
  }
  unsafe.untracked = remaining;
  if (remaining.length > 0) alert('untracked-kept', { paths: remaining });

  // ── Step 3: plan + apply list edits ─────────────────────────────────────────────────────────────────
  // Held item 212 — stacked overlay PRs apply as stacks (only their tops) unless `overlay.stackMode` says independent.
  // The PR base chains come from gh, else from each entry's recorded `stackBases`, else ancestry alone.
  const stack = resolveOverlayStackMode(env);
  const closureScopeMode = resolveClosureScopeMode(env).mode;
  const runtimeEntries = () => cloneRuntimeEntries({ root, entries, env });
  let chainOf;
  let plan;
  const recoveredRefs = new Set();
  // A carrier can be rewritten, closed, missing or conflict-skipped. Validate against the actual candidate,
  // not merely a registered ref. Each retry adds a previously absent source; no-progress refuses the build.
  for (;;) {
    chainOf = prBaseChain ?? makePrBaseChain({ root, overlays: overlaysForPlan, env });
    // The refusal names a registration; sidecar pruning and status reads ran Git since it was built.
    if (unavailablePinned && !snapshotHolds()) return registrationChanged();
    plan = unavailablePinned ?? await planRebuild({
      git, headSha: prevHead, mainRef: 'origin/main', overlays: overlaysForPlan, prState, mainOnly, edgeResolve,
      entries: runtimeEntries, env, closureScopeMode,
      stackMode: stack.mode, stackModeSource: stack.source, prBaseChain: chainOf,
      prForcePushes: prForcePushes ?? chainOf.forcePushes ?? null,
    });
    if (!plan.ok || mainOnly) break;
    try {
      const uncovered = archiveUncovered(git, overlaysBefore, plan.finalSha);
      if (!uncovered.length) break;
      const restored = [];
      for (const carrier of uncovered) {
        const recovery = reinstateOverlaySources(root, carrier.ref, { env, expectedOverlay: carrier });
        if (recovery.reinstated.length) snapshotGeneration += 1;
        for (const ref of recovery.reinstated) {
          ourRestored.set(ref, recovery.list.find((o) => o.ref === ref)?.registrationId);
          if (!recoveredRefs.has(ref)) restored.push(ref);
          recoveredRefs.add(ref);
        }
        overlaysBefore = recovery.list;
      }
      if (!restored.length) {
        alert('overlay-source-unavailable', { refs: uncovered.map((o) => o.ref),
          message: 'Archived content is absent from the proposed build; restore its source branch or land it on main.' });
        return terminal({ moved: false, reason: 'overlay-source-unavailable' });
      }
      const required = new Set([...restored, ...overlaysForPlan.map((o) => o.ref)]);
      const refreshed = fetchMainAndOverlays({ git, overlays: overlaysBefore, edgeResolve });
      if (refreshed.malformed?.length) {
        alert('overlay-state-malformed', { file: overlayFilePath(root, env), malformed: refreshed.malformed,
          message: 'Repair the overlay registry before rebuilding with overlays; mainOnly recovery remains available.' });
        return terminal({ moved: false, reason: 'overlay-state-malformed' });
      }
      if (!refreshed.ok || [...required].some((ref) => refreshed.refEvidence.get(ref) !== 'refreshed')) {
        alert('overlay-source-unavailable', { refs: uncovered.map((o) => o.ref), message: 'Restored sources could not be refreshed; retrying next tick.' });
        return terminal({ moved: false, reason: 'overlay-source-unavailable' });
      }
      // Re-fetch can advance any tip. Never reuse deferred retirement evidence across the recovery
      // plan; its registration snapshot predates reinstatement. Previously available pins must also
      // stay available; unrelated already-unavailable registrations remain excluded as before.
      refreshedTips = new Map();
      for (const [ref, evidence] of refreshed.refEvidence) fetchResult.refEvidence.set(ref, evidence);
      overlaysForPlan = overlaysBefore.filter((o) => fetchResult.refEvidence.get(o.ref) === 'refreshed');
    } catch (error) {
      alert('overlay-source-unverifiable', { error: String(error?.message ?? error) });
      return terminal({ moved: false, reason: 'overlay-source-unverifiable' });
    }
  }
  if (!snapshotHolds()) return registrationChanged();
  // Carry the captured ids through normal adoption too; adopt.mjs consumes these applied rows unchanged.
  if (plan.applied) plan.applied = plan.applied.map((row) => ({
    ...row, registrationId: row.registrationId ?? snap.get(row.ref) ?? ourRestored.get(row.ref),
  }));
  // The chains gh answered completely are written back onto the entries (only when they changed), so a rebuild that
  // cannot reach gh later still knows the stacks. Best effort: a busy or unwritable list never fails the rebuild.
  // A chain only names a stack's members; setting a base aside still needs hard evidence it moved (planOverlayStacks).
  if (chainOf.fresh?.size > 0) {
    try { persistStackBases(root, chainOf.fresh, { env }); } catch (e) { alert('stack-bases-not-recorded', { error: String(e?.message ?? e) }); }
  }
  // overlay-pin — `overlay-pinned` is logged ONCE per (ref, new tip), not every tick the pin holds; the record
  // (`state.pinnedNotified`: ref → the new tip last reported) is pruned only after a complete plan.
  const pinnedBefore = state.pinnedNotified && typeof state.pinnedNotified === 'object' ? state.pinnedNotified : {};
  const pinnedNow = Object.create(null);
  // A refusal can stop before visiting other pins. Keep their notices and persist any new ones
  // already emitted, even though this plan will not be adopted.
  if (!plan.ok) Object.assign(pinnedNow, pinnedBefore);
  for (const event of plan.alerts || []) {
    if (event.kind === 'overlay-pinned') {
      const { ref, pr, newTip, files } = event.detail;
      pinnedNow[ref] = newTip;
      // The branch's own fixer still learns its new head conflicts (the wake keeps its first `at`).
      if (pr != null) markOverlayConflictWake(env, { pr, ref, files, at: nowIso(), clone: root });
      if (Object.hasOwn(pinnedBefore, ref) && pinnedBefore[ref] === newTip) continue;
    }
    alert(event.kind, event.detail);
    if (event.kind === 'overlay-conflict-unresolved' && event.detail.pr != null) {
      const { pr, ref, files } = event.detail;
      markOverlayConflictWake(env, { pr, ref, files, at: nowIso(), clone: root });
    }
    // x5059uu — a parked newcomer wakes its own PR's fixer with the established overlays it must merge in.
    if (event.kind === 'overlay-newcomer-parked' && event.detail.pr != null) {
      const { pr, ref, files, collidesWith } = event.detail;
      markOverlayConflictWake(env, { pr, ref, files, collidesWith, at: nowIso(), clone: root });
    }
  }
  if (JSON.stringify(pinnedBefore) !== JSON.stringify(pinnedNow)) {
    state.pinnedNotified = Object.keys(pinnedNow).length ? pinnedNow : null;
    writeState();
  }
  for (const [pr, wake] of readOverlayConflictWakes(env, { maxAgeMs: Infinity })) {
    if (wake.clone === root && !overlaysBefore.some((o) => o.pr === pr && o.ref === wake.ref)) {
      clearOverlayConflictWake(env, pr);
    }
  }
  if (!plan.ok) {
    // A pinned refusal keeps the current tree AND the overlay list untouched (no decisions were applied).
    // An unavailable-pin refusal names a registration; never alert or hold for one replaced since it was built.
    if (plan === unavailablePinned && !snapshotHolds()) return registrationChanged();
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
  // x9diisp (live 2026-10-20T11:51Z) — main graduated hotfixes the running build carries as overlays, so those overlays
  // (and every stacked overlay above them) now conflict with main. Building without them would smoke-pass and be
  // adopted, silently dropping live hotfixes. Instead HOLD on the last-good build (dispatch continues from it via
  // x5wbsbc; `daemon-held-on-last-good` raises needs-you after 15 min) and leave the overlay list untouched, until the
  // lost overlays are rebased onto main (or retired). Nothing is applied from this plan.
  // A lost overlay whose current tip this build still contains is live through its carrier — e.g. a mechanism-pinned
  // original (never set aside as stack-contained) beside its registered auto-rebase repair. Holding on it would keep
  // the repair from ever being adopted. Only a tip the running build already carries qualifies: a changed tip says
  // nothing about the older live heads it replaced. Ancestry git cannot confirm keeps the overlay lost (fail closed).
  const contains = (sha, build) => !!build && git(['merge-base', '--is-ancestor', sha, build]).status === 0;
  const lost = mainOnly ? [] : (plan.establishedLost ?? []).filter((l) => !(l.sha
    && contains(l.sha, prevHead) && contains(l.sha, plan.finalSha)));
  if (!mainOnly && lost.length > 0) {
    const detail = {
      refs: lost.map((l) => l.ref), lost,
      message: `${lost.length} overlay(s) in the running build would be lost (${lost.map((l) => l.ref).join(', ')}) — holding on the last-good build; rebase them onto main (or merge main into the stack top) and re-register`,
    };
    let setting;
    try { setting = autoRebase.resolveAutoRebaseSwitch(env); } catch { setting = { enabled: false, source: 'unavailable' }; detail.autoRebase = { started: [], skipped: lost.map(l => l.ref), source: setting.source }; }
    if (setting.enabled) {
      try { detail.autoRebase = { ...await autoRebase.kickAutoRebase({ root, env, lost }), source: setting.source }; }
      catch { detail.autoRebase = { started: [], skipped: lost.map(l => l.ref), source: setting.source }; }
    }
    if (!snapshotHolds()) return registrationChanged();
    alert('established-overlay-hold', detail);
    if (state.adopted?.head && state.adopted.head === prevHead) {
      state.held = {
        since: state.held?.since ?? nowIso(),
        reason: 'established-overlay-conflict',
        failed: `${lost.map((l) => l.ref).join(', ')}: conflict with main`,
        details: [],
        lastGood: prevHead,
        target: null,
        mainSha: plan.mainSha ?? null,
        updatedAt: nowIso(),
      };
      writeState();
    }
    return terminal({ moved: false, reason: 'established-overlay-conflict', detail });
  }
  if (!snapshotHolds()) return registrationChanged();
  refreshedTips = new Map([...refreshedTips].map(([ref, tip]) => [ref, {
    ...tip, registrationId: tip.registrationId ?? snap.get(ref) ?? ourRestored.get(ref),
  }]));
  try { persistTipShas(root, refreshedTips, { env }); }
  catch (error) {
    alert('overlay-auto-retire-audit-failed', { failures: [{ ref: null, kind: 'tip-sha', error: String(error?.message || error) }] });
  }
  if (!snapshotHolds()) return registrationChanged();
  for (const d of plan.decisions) {
    if (!snapshotHolds()) return registrationChanged();
    if (d.pr != null && (d.action === 'apply' || d.action === 'remove') && !d.pinned) clearOverlayConflictWake(env, d.pr);
    if (d.action === 'remove') {
      try {
        // A source this tick reinstated is bound to the id we restored; with neither, removeOverlay refuses.
        const removed = removeOverlay(root, d.ref, {
          env, why: d.reason, expectRegistrationId: snap.get(d.ref) ?? ourRestored.get(d.ref),
        });
        if (removed.removed) {
          snapshotGeneration += 1;
          ourRemoved.add(d.ref); snap.delete(d.ref);
          for (const ref of removed.reinstated ?? []) ourRestored.set(ref, removed.list.find((o) => o.ref === ref)?.registrationId);
        }
      } catch (error) {
        if (!/registration changed/.test(String(error?.message))) throw error;
        alert('overlay-registration-changed', {});
        continue;
      }
      appendOverlayEvent(root, { kind: 'auto-dropped', ref: d.ref, pr: d.pr, reason: d.reason }, { env });
      alert('overlay-auto-dropped', { ref: d.ref, reason: d.reason });
    } else if (d.action === 'drop') {
      alert('overlay-conflict-dropped', {
        ref: d.ref, reason: d.reason, ...(d.files ? { files: d.files } : {}),
      });
    }
  }

  // The overlays a build applies, read from its own rebuild-committed `daemon-rebuild: merge overlay <ref>` records on
  // its first-parent line above main ({ref, sha}), plus the recorded adopted set when it is that build. Unreadable
  // history returns undefined (the superseded rule then refuses: fail closed).
  function liveOverlaysOf(head, mainSha) {
    if (!head || !mainSha) return undefined;
    const log = git(['log', '--first-parent', '--format=%P%x09%ce%x09%s', head, '--not', mainSha]);
    if (log.status !== 0) return undefined;
    const live = [];
    for (const l of String(log.stdout ?? '').split('\n').filter(Boolean)) {
      const [parents, committer, ...rest] = l.split('\t');
      const ps = String(parents ?? '').split(' ');
      const hit = rest.join('\t').match(/^daemon-rebuild: merge overlay (\S+) /);
      if (hit && committer === REBUILD_IDENTITY_ENV.GIT_COMMITTER_EMAIL && [2, 3].includes(ps.length)) live.push({ ref: hit[1], sha: ps[1] });
    }
    if (state.adopted?.head === head) for (const a of state.adopted.applied ?? []) if (a?.ref && a.sha) live.push({ ref: a.ref, sha: a.sha });
    return live;
  }

  // ── Step 4: up-to-date / still-rejected short-circuits ──────────────────────────────────────────────
  if (plan.upToDate) {
    if (!state.adopted || state.adopted.inputsKey !== plan.inputsKey || state.held) {
      state.adopted = {
        head: plan.finalSha, inputsKey: plan.inputsKey, mainSha: plan.mainSha,
        applied: plan.applied.map((row) => ({ ...row, registrationId: row.registrationId ?? snap.get(row.ref) })), at: nowIso(),
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
      // A saved candidate cannot restore a cached tip that this tick could not refresh.
      const registeredRefs = new Set(overlaysForPlan.map((o) => o?.ref));
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
          git, adopt, mainTip: plan.mainSha, prevHead, entries: runtimeEntries, env,
          approvedEdgeShaFor: (ref) => recordedEdgeSha((overlaysBefore || []).find((o) => o?.ref === ref)),
        }),
        overlayTip: (ref) => verifyRev(git, `refs/remotes/origin/${ref}^{commit}`),
        registered: (ref) => registeredRefs.has(ref),
        allowFallback: !mainOnly, // a mainOnly rebuild never edits the overlay list, so never drops suspects
        rejected: state.rejected,
        nowMs: nowMs(),
        maxAgeMs,
        // the overlays the RUNNING build applies: its own rebuild-committed merge records above main (hard data — an
        // empty list for a plain-main HEAD), plus the recorded adopted set when HEAD is that adopted build
        liveApplied: liveOverlaysOf(prevHead, plan.mainSha),
        carries: (sha, build) => git(['merge-base', '--is-ancestor', sha, build]).status === 0,
        leftForMain: (ref) => plan.decisions.some((d) => d.ref === ref && d.action === 'remove' && (d.reason === 'pr-merged' || d.reason === 'in-main')),
      });
      // A saved candidate predates this tick's archives (auto-retirement may have run since it passed).
      // Hold it to the same rule as a fresh plan: every registered carrier's archived sources must be in
      // the target. Unreadable evidence discards it too; the fresh plan below then re-checks and smokes.
      // A mainOnly rebuild skips archives everywhere (its planning and smoke fallbacks never edit the list).
      let archiveRefusal = null;
      if (m.adopt && !mainOnly) {
        try {
          const uncovered = archiveUncovered(git, overlaysBefore || [], m.adopt.finalSha);
          if (uncovered.length) archiveRefusal = { refs: uncovered.map((o) => o.ref) };
        } catch (e) {
          archiveRefusal = { refs: (overlaysBefore || []).filter((o) => o?.retiredSources?.length).map((o) => o.ref),
            error: String(e?.message ?? e) };
        }
      }
      if (!m.adopt || archiveRefusal) {
        clearReadyCandidate(root, stEnv);
        alert('ready-candidate-discarded', { target: ready.adopt.finalSha,
          ...(archiveRefusal ? { reason: 'archive-source-uncovered', ...archiveRefusal } : { reason: m.reason }) });
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
          archiveGuard: !mainOnly,
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
        root, env, log, run, stateOpts, now, plan, prevHead, lease: { token: null }, archiveGuard: !mainOnly,
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
  if (!snapshotHolds()) return registrationChanged();
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
