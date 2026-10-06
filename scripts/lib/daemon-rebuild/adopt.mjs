/** @file scripts/lib/daemon-rebuild/adopt.mjs — Adoption: ready-candidate matching and provenance, suspect-overlay
 * drops, the held-stale alert, and the locked finalize phase. Split out of daemon-rebuild.mjs (move-only).
 */

import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import { removeOverlay, appendOverlayEvent } from '../daemon-overlays.mjs';
import { alertsFilePath, readRebuildState, writeRebuildState, clearReadyCandidate } from './state.mjs';
import { verifyRev, makeGit } from './shared.mjs';
import { resolveOverlayConflict } from './overlay-strategies.mjs';
import { releaseBuildLease } from './lease.mjs';
import { ensureSafeToMove, knownInputsOf } from './local-state.mjs';

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
  git, adopt, mainTip, prevHead, approvedEdgeShaFor = () => null,
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
    let minted;
    if (a.resolvedVia) {
      // An edge-resolved build is only as trusted as the operator's CURRENT recorded approval: the record's own
      // `edgeSha` must still equal it, and the tree is re-derived through that same approved edge.
      const approvedEdgeSha = approvedEdgeShaFor(a.ref);
      if (a.resolvedVia === 'edge-ref' && (!approvedEdgeSha || a.edgeSha !== approvedEdgeSha)) return false;
      const resolved = resolveOverlayConflict({ git, cur: prev, ovSha: a.sha, ref: a.ref, approvedEdgeSha });
      minted = resolved.ok ? resolved.tree : '';
    } else {
      const mt = git(['merge-tree', '--write-tree', '--no-messages', prev, a.sha]);
      minted = mt.status === 0 ? String(mt.stdout ?? '').split('\n')[0].trim() : '';
    }
    if (!minted || minted !== verifyRev(git, `${cur}^{tree}`)) return false;
    cur = prev;
  }
  return verifyRev(git, `${cur}^{commit}`) === adopt.mainSha;
}

/** Drop the suspect overlays a passing plain-main fallback proved bad (shared by the direct finalize and by a
 *  later adoption of the same fallback from its ready record). */
export function dropSuspectOverlays({
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

/** The one "this clone is being held off origin/main" alert both {@link prepareRebuild} and
 *  {@link finalizeRebuild} raise on a non-moving, non-adopting, plan-ok, behind-main result — factored out so
 *  both phases (which each read their OWN fresh `state`, see file header) compute it identically. */
export function staleAlertDetail(result, state) {
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

/**
 * Phase 3 (LOCKED, fast — reached ONLY after phase 2's unlocked smoke, run by {@link rebuildClone}, already
 * PASSED): re-verifies nothing else moved `root` while the smoke ran, then performs the ONE `git reset --hard`
 * this module ever does, and writes `state.adopted`. On a FAILING smoke this is never called at all — `root`
 * was never touched, so {@link rebuildClone} handles that case itself, with no lock and nothing to roll back.
 */
export async function finalizeRebuild({
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
