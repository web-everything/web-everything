/** @file scripts/lib/daemon-rebuild/adopt.mjs — Adoption: ready-candidate matching and provenance, suspect-overlay
 * drops, the held-stale alert, and the locked finalize phase. Split out of daemon-rebuild.mjs (move-only).
 */

import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import { removeOverlay, appendOverlayEvent } from '../daemon-overlays.mjs';
import { alertsFilePath, readRebuildState, writeRebuildState, clearReadyCandidate } from './state.mjs';
import { verifyRev, makeGit, REBUILD_IDENTITY_ENV } from './shared.mjs';
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
 *   rejected?:object|null, nowMs:number, maxAgeMs:number, forcedWatch?:(sha:string)=>'ok'|'missing'|'unreadable'|'owed'}} o —
 *   `registered`: still on the overlay list after this tick's own edits (defaults to `stillWanted`); `allowFallback: false`
 *   (a mainOnly rebuild) refuses any fallback; `forcedWatch` (R508): the state of the rollback watch a FORCED record needs
 *   (default `'missing'`, so a forced record is never adopted without proof of its watch).
 */
export function matchReadyCandidate({
  ready, plan, prevHead, treeOf, stillWanted, verifyBuilt = () => false, overlayTip = () => null,
  registered = stillWanted, allowFallback = true, rejected = null, nowMs, maxAgeMs,
  liveApplied, carries = () => false, leftForMain = () => false,
  removedForMain = () => false, contentInBuild = () => false, forcedWatch = () => 'missing',
}) {
  if (!ready) return { adopt: null, reason: 'none' };
  const passedMs = Date.parse(ready.passedAt || '');
  if (!Number.isFinite(passedMs) || nowMs - passedMs > maxAgeMs) return { adopt: null, reason: 'expired' };
  if (ready.prevHead !== prevHead) return { adopt: null, reason: 'other-base' };
  if (ready.adopt.finalSha === prevHead && ready.kind !== 'fallback') return { adopt: null, reason: 'already-head' };
  if (rejected && rejected.inputsKey === ready.adopt.inputsKey && Date.parse(rejected.at || '') > passedMs) {
    return { adopt: null, reason: 'rejected-since' };
  }
  // R508: a forced record vouches for exactly ONE sha (its rollback watch is keyed to it). A same-tree or superseding
  // build substituted for it would be adopted with no health watch, so only an exact match may adopt it.
  if (ready.forced === true && plan.finalSha !== ready.adopt.finalSha) return { adopt: null, reason: 'forced-sha-pinned' };
  // …and only while its rollback watch is really there: a forced build adopted with a missing, unreadable or already-owing watch would
  // run with nothing to revert it. Unknown (no `forcedWatch` supplied) is not "ok": fail closed.
  if (ready.forced === true) {
    const watch = forcedWatch(ready.adopt.finalSha);
    // Literal reasons (no template): the reason-classification test reads them statically.
    if (watch !== 'ok') return { adopt: null, reason: watch === 'unreadable' ? 'forced-watch-unreadable' : watch === 'owed' ? 'forced-watch-owed' : 'forced-watch-missing' };
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
  // Live 2026-10-21 ~17:12 ET (review clone): a superseded build must never DROP an overlay the running build applies.
  // Each one's applied sha must be carried by ancestry or proven graduated into the record's own build.
  // Unknown live set (`liveApplied` not given) refuses: fail closed.
  if (!Array.isArray(liveApplied)) return { adopt: null, reason: 'superseded-live-set-unknown' };
  // Carried means by CONTENT: the live applied sha is inside the record's build (the same ref at an OLDER head does
  // not count — Codex audit).
  // Graduation (`leftForMain`) proves both registry history and content in this candidate's own build.
  // Separately, an overlay this tick's plan removed as `pr-merged`/`in-main` (`removedForMain`) is safe only
  // with independent content proof. Current main containing an overlay alone never satisfies either path.
  const retired = [];
  const omitted = liveApplied.filter((a) => {
    if (!a?.ref) return false;
    if (a.sha && carries(a.sha, ready.adopt.finalSha)) return false;
    if (a.sha && leftForMain(a, ready.adopt.finalSha) === true) return false;
    if (a.sha && removedForMain(a.ref) && contentInBuild(a.sha, ready.adopt.finalSha)) { retired.push(a.ref); return false; }
    return true;
  });
  if (omitted.length > 0) {
    return { adopt: null, reason: `superseded-omits-live-overlay: ${omitted.map((a) => a.ref).join(', ')}`, omitted: omitted.map((a) => a.ref) };
  }
  return { adopt: ready.adopt, dropRefs: [], match: 'superseded', ...(retired.length ? { retired } : {}) };
}

// R790: one-time ruled weakening for this exact legacy drop; content/driver and time proof still apply.
export const RULED_LEGACY_PR_MERGED_DROPS = Object.freeze([
  Object.freeze({ ref: 'lane/redteam-pending-on-accept-m1', pr: 6554, at: '2026-11-09T11:58:41.018Z', ruling: 'R790' }),
]);

/** Prove a removed overlay graduated into this build, including squash-merged content. Unknown evidence refuses. */
export function overlayGraduated({ ref, sha, build, registered, events, git, readyAt } = {}) {
  try {
    if (!ref || !sha || !build || registered(ref) !== false || !Array.isArray(events)) return false;
    const last = events.findLast((event) => event?.ref === ref);
    const timeMs = (value) => typeof value === 'number' ? value
      : typeof value === 'string' ? Date.parse(value) : NaN;
    // An `auto-retired` event (prototype-load / daemon-overlay: PR merged or in main) is graduation only with its own
    // proof: the event names this exact tip and records clean merges with the content in main. The tree check below
    // still has to agree independently; anything else refuses (live 2026-11-04 author-lookup-defer-m2).
    const retiredWithProof = last?.kind === 'auto-retired' && ['pr-merged', 'in-main'].includes(last.reason)
      && last.tip === sha && last.evidence?.contentInMain === true && last.evidence?.cleanMerges === true;
    const droppedWithProof = last?.kind === 'auto-dropped' && last.reason === 'pr-merged'
      && last.tip === sha && last.evidence?.contentInMain === true && last.evidence?.cleanMerges === true;
    const ruledLegacyDrop = last?.kind === 'auto-dropped' && last.reason === 'pr-merged'
      && last.evidence === undefined && RULED_LEGACY_PR_MERGED_DROPS.some((entry) =>
        last.ref === entry.ref && last.pr === entry.pr && last.at === entry.at);
    if ((last?.kind === 'auto-dropped' && last.reason === 'in-main') || retiredWithProof || droppedWithProof || ruledLegacyDrop) {
      const droppedMs = timeMs(last.at);
      const readyMs = timeMs(readyAt);
      if (!Number.isFinite(droppedMs) || !Number.isFinite(readyMs) || droppedMs >= readyMs) return false;
    } else {
      if (last?.kind !== 'removed' || typeof last.reason !== 'string') return false;
      const merged = /^graduated #\d+ \(merged ([a-f0-9]{7,40})\)$/.exec(last.reason)?.[1];
      if (!merged) return false;
      const resolved = git(['rev-parse', '--verify', `${merged}^{commit}`]);
      if (resolved?.status !== 0 || typeof resolved.stdout !== 'string') return false;
      const mergeSha = resolved.stdout.trim();
      if (!/^[a-f0-9]{40}$/.test(mergeSha)) return false;
      if (git(['merge-base', '--is-ancestor', mergeSha, build])?.status !== 0) return false;
    }
    // Custom drivers can discard overlay changes while reporting an unchanged merge tree.
    if (git(['config', '--get-regexp', '^merge\\..*\\.driver$'])?.status !== 1) return false;
    const tree = git(['rev-parse', `${build}^{tree}`]);
    const mergedTree = git(['merge-tree', '--write-tree', '--no-messages', build, sha]);
    if (tree?.status !== 0 || mergedTree?.status !== 0
      || typeof tree.stdout !== 'string' || typeof mergedTree.stdout !== 'string') return false;
    const buildTree = tree.stdout.trim();
    return /^[a-f0-9]{40}$/.test(buildTree) && mergedTree.stdout.split('\n')[0].trim() === buildTree;
  } catch { return false; }
}

/** Preserve the discard alert and escalate every refusal except routine candidate expiry/base churn. */
export function reportDiscardedCandidate({ ready, match, alert, needsYou }) {
  const detail = {
    target: ready?.adopt?.finalSha,
    reason: match?.reason,
    refs: match?.omitted ?? (ready?.adopt?.applied ?? []).map((a) => a.ref),
  };
  try { alert('ready-candidate-discarded', detail); } catch { /* still attempt escalation */ }
  if (!['expired', 'other-base', 'already-head'].includes(detail.reason)) {
    try { needsYou({ kind: 'ready-candidate-discarded', ...detail }); } catch { /* best-effort reporting */ }
  }
}

/** Where the running head sits on main: skip the rebuild-committed overlay merges at the top of its first-parent
 *  chain (committer is the rebuild identity, subject `daemon-rebuild: merge overlay …`, 2-3 parents), then take the
 *  merge-base of the first other commit with `mainTip`. A head with no rebuild merges uses the plain merge-base.
 *  Unreadable history returns '' (the caller refuses: fail closed). */
function trueMainBase(git, head, mainTip, isAncestor) {
  const log = git(['log', '--first-parent', '--format=%H%x09%P%x09%ce%x09%s', head]);
  if (log.status !== 0) return '';
  let base = head;
  const stripped = [];
  for (const l of String(log.stdout ?? '').split('\n').filter(Boolean)) {
    const [sha, parents, committer, ...rest] = l.split('\t');
    const ps = String(parents ?? '').split(' ').filter(Boolean);
    const rebuildMerge = /^daemon-rebuild: merge overlay /.test(rest.join('\t'))
      && committer === REBUILD_IDENTITY_ENV.GIT_COMMITTER_EMAIL && [2, 3].includes(ps.length);
    if (!rebuildMerge) { base = sha; break; }
    stripped.push(ps[1]);
    base = ps[0];
  }
  // An overlay not (yet) in main keeps the strict floor: use the plain merge-base of the head.
  if (stripped.some((o) => !isAncestor(o, mainTip))) base = head;
  if (!/^[0-9a-f]{40}$/.test(base ?? '')) return '';
  const mb = git(['merge-base', base, mainTip]);
  return mb.status === 0 ? String(mb.stdout ?? '').trim() : '';
}

/**
 * Is a ready record's `adopt` provably a build {@link planRebuild} could have minted — never an arbitrary commit
 * someone wrote into the state file? All of: its `mainSha` is on the current main history (an ancestor of, or
 * equal to, `mainTip`); walking back from `finalSha`, each carried overlay is exactly one merge commit whose
 * parents are `[previous step, overlay sha]` (plus the approved edge sha for an edge resolution), bottoming out
 * at `mainSha` (so an overlay-free record must BE `mainSha`); and every carried overlay sha is on its registered
 * ref's current remote-tracking tip. Any git failure reads as unverified — the caller then just smokes
 * the live plan instead.
 * @param {{git:(args:string[])=>{status:number|null, stdout?:string}, adopt:object, mainTip:string}} o
 */
export function readyBuildVerified({
  git, adopt, mainTip, prevHead, approvedEdgeShaFor = () => null,
}) {
  const isAncestor = (a, b) => git(['merge-base', '--is-ancestor', a, b]).status === 0;
  if (!adopt?.finalSha || !adopt.mainSha || !mainTip || !isAncestor(adopt.mainSha, mainTip)) return false;
  // Never a rollback: the record's main must be at or past the main the current head was built on.
  // The head's TRUE main base: an overlay the head carries may have merged into main since, which would make a plain
  // merge-base(head, mainTip) the (newer) overlay commit and read a good older plain-main fallback as a rollback.
  // So walk the head's first-parent chain across rebuild-committed overlay merges to the main commit they sit on.
  // The floor is lowered below the plain merge-base ONLY when every overlay stripped from the head is itself
  // already an ancestor of `mainTip` (its content is in main, so the next tick's live plan carries it): then the
  // floor is the main commit the head was BUILT on. Any stripped overlay not in main keeps the strict plain
  // merge-base. Candidates below the head's base are refused either way.
  const headBase = prevHead ? trueMainBase(git, prevHead, mainTip, isAncestor) : '';
  if (!headBase || !isAncestor(headBase, adopt.mainSha)) return false;
  const applied = Array.isArray(adopt.applied) ? adopt.applied : [];
  let cur = adopt.finalSha;
  for (let i = applied.length - 1; i >= 0; i -= 1) {
    const a = applied[i];
    if (!a?.ref || !a.sha) return false;
    const r = git(['rev-list', '--parents', '-n', '1', cur]);
    if (r.status !== 0) return false;
    const [self, prev, ov, ...extra] = String(r.stdout ?? '').trim().split(/\s+/);
    if (!self || !prev || ov !== a.sha) return false;
    // Older edge builds have two parents. A new third parent is allowed only for the recorded edge;
    // the current approval and its tree are verified below. Never trust arbitrary additional ancestry.
    if (extra.length > 0 && (a.resolvedVia !== 'edge-ref' || extra.length !== 1 || extra[0] !== a.edgeSha)) return false;
    // The overlay sha is still on its ref — or, once the branch is gone (merged + auto-deleted), on main.
    const tip = verifyRev(git, `refs/remotes/origin/${a.ref}^{commit}`);
    // overlay-pin: a PINNED head that was force-pushed off its ref fails this on purpose (fail closed): the ready
    // record is not trusted to prove its own provenance, so that candidate is simply smoked again.
    if (tip ? !isAncestor(a.sha, tip) : !isAncestor(a.sha, mainTip)) return false;
    // The merge's tree is exactly what planRebuild mints for (prev, overlay) — never an arbitrary tree.
    let minted;
    if (a.resolvedVia) {
      // An edge-resolved build is only as trusted as the operator's CURRENT recorded approval: the record's own
      // `edgeSha` must still equal it, and the tree is re-derived through that same approved edge.
      const approvedEdgeSha = approvedEdgeShaFor(a.ref);
      if (a.resolvedVia === 'edge-ref' && (!approvedEdgeSha || a.edgeSha !== approvedEdgeSha)) return false;
      const resolved = resolveOverlayConflict({ git, cur: prev, ovSha: a.sha, ref: a.ref, approvedEdgeSha });
      if (a.resolvedVia === 'edge-ref' && resolved.edgeSha !== a.edgeSha) return false;
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
      detail: state.held.details?.[0]?.name === 'daemon-entries-boot'
        ? state.held.details[0].detail : (state.held.details?.[0]?.detail ?? '').slice(0, 300),
      ...(state.held.details?.some(row => row.name === 'daemon-entries-boot')
        ? { details: state.held.details.filter(row => row.name === 'daemon-entries-boot') } : {}),
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
