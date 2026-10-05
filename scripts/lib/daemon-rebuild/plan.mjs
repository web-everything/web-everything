/** @file scripts/lib/daemon-rebuild/plan.mjs — Overlay application plan.
 * Split out of daemon-rebuild.mjs (move-only).
 */

import { verifyRev, rebuildCommitEnv } from './shared.mjs';
import { resolveOverlayConflict } from './overlay-strategies.mjs';
import { recordedEdgeSha } from './edge-fetch.mjs';
import { createHash } from 'node:crypto';

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
  // The move-only split put the mechanism's code in this folder; a directory pathspec covers every file in it,
  // so an overlay changing that code is pinned exactly as one changing `daemon-rebuild.mjs` was before the split.
  'scripts/lib/daemon-rebuild/',
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
export function pinnedStatus(git, raw, mainSha, ovSha) {
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
 *   prState?:(pr:number)=>(Promise<string|null>|string|null), mainOnly?:boolean, edgeResolve?:boolean}} o
 * @returns {Promise<{ok:false, reason:'main-unresolved'}|{ok:true, mainSha:string, finalSha:string,
 *   applied:Array<{ref:string,pr:number|null,sha:string}>,
 *   decisions:Array<{ref:string,pr:number|null,action:'remove'|'drop'|'skip'|'apply',reason:string,sha:string|null}>,
 *   alerts:Array<object>, inputsKey:string, upToDate:boolean}>}
 */
export async function planRebuild({
  git, headSha, mainRef, overlays = [], prState, mainOnly = false, edgeResolve = true,
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
      ...(alerts.length ? { alerts } : {}),
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
    const dropOrRefuse = (reason, extra = {}) => {
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
      decisions.push({ ref, pr, action: 'drop', reason, sha: ovSha, ...extra });
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
    let resolution;
    let tree = String(mt.stdout ?? '').split('\n')[0].trim();
    if (mt.status === 1) {
      if (edgeResolve) resolution = resolveOverlayConflict({ git, cur, ovSha, ref, approvedEdgeSha: recordedEdgeSha(raw) });
      if (resolution?.ok) tree = resolution.tree;
      else {
        if (resolution) alerts.push({
          kind: 'overlay-conflict-unresolved',
          detail: { ref, pr, sha: ovSha, files: resolution.files, tried: resolution.tried },
        });
        const refused = dropOrRefuse('conflict', resolution ? { files: resolution.files } : {});
        if (refused) return refused;
        continue;
      }
    }
    if (mt.status !== 0 && !resolution?.ok) {
      const refused = dropOrRefuse('merge-tree-failed');
      if (refused) return refused;
      continue;
    }

    // 5. content already there (e.g. squash-merged) — cherry's patch-id compare can miss this; a direct tree
    //    compare against `cur` catches it regardless of history shape.
    const curTree = verifyRev(git, `${cur}^{tree}`);
    if (tree && curTree && tree === curTree) {
      decisions.push({ ref, pr, action: 'remove', reason: 'in-main', sha: ovSha });
      continue;
    }

    // 6. mint the merge commit — fixed identity, date = the later of the two parents' committer dates, so the
    //    same (cur, ovSha) pair always mints the identical sha (see file header — DETERMINISM).
    const message = `daemon-rebuild: merge overlay ${ref}${pr != null ? ` (PR #${pr})` : ''} onto ${cur}`
      + (resolution?.ok ? ` (resolved via ${resolution.via})` : '');
    const ct = git(['commit-tree', tree, '-p', cur, '-p', ovSha, '-m', message], {
      env: rebuildCommitEnv(git, cur, ovSha),
    });
    const newSha = String(ct.stdout ?? '').trim();
    if (ct.status !== 0 || !newSha) {
      const refused = dropOrRefuse('commit-tree-failed');
      if (refused) return refused;
      continue;
    }
    cur = newSha;
    const edge = resolution?.edgeSha ? { edgeSha: resolution.edgeSha } : {};
    applied.push({ ref, pr, sha: ovSha, ...(resolution?.ok ? { resolvedVia: resolution.via, ...edge } : {}) });
    decisions.push({ ref, pr, action: 'apply', reason: resolution?.ok ? `applied-${resolution.via}` : 'applied', sha: ovSha });
    if (resolution?.ok) alerts.push({ kind: 'overlay-conflict-resolved', detail: { ref, pr, via: resolution.via, ...edge } });
  }

  const inputsKey = createHash('sha256')
    .update(JSON.stringify({ main: mainSha, overlays: applied.map((a) => a.resolvedVia
      ? [a.ref, a.sha, a.resolvedVia, a.edgeSha ?? null] : [a.ref, a.sha]) }))
    .digest('hex')
    .slice(0, 16);

  return {
    ok: true, mainSha, finalSha: cur, applied, decisions, alerts, inputsKey, upToDate: cur === headSha,
  };
}
