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

/** The conflicted paths `git merge-tree --write-tree` lists after its tree line (`<mode> <sha> <stage>\t<path>`). */
function conflictFilesOf(stdout) {
  return [...new Set(String(stdout ?? '').split('\n').slice(1)
    .map((l) => l.split('\t')[1]).filter(Boolean))].sort();
}

/** Files an overlay changes relative to main (merge-base(main, tip)..tip); [] when git cannot answer. */
function changedFiles(git, mainSha, sha) {
  const mb = String(git(['merge-base', mainSha, sha]).stdout ?? '').trim();
  if (!mb) return [];
  const d = git(['diff', '--name-only', mb, sha]);
  return d.status === 0 ? String(d.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean) : [];
}

// ── overlay stacks (held item 212) ─────────────────────────────────────────────────────────────────────────

/**
 * PURE over `git` / `stateOf` / `prBaseChain`: group the registered overlays into stacks and pick what applies.
 * Live 2026-10-10 (wev-fix-daemon): #4757 is stacked on #4756, and #4792/#4797 sit on a chain that reaches #4756
 * and carries #4757. #4756 was rebased; its children still carry its OLD head. Applied as independent overlays,
 * the children conflicted with the live #4756 every rebuild and were parked, so none of the stack's fixes went live.
 *
 * An overlay C is a CHILD of a registered overlay P when C's PR base chain names P's branch, or P's tip is an
 * ancestor of C's tip (the fallback when gh cannot answer). A TOP has no registered child. Every non-top base P:
 *   - is `stack-contained` when one of its tops contains P's current tip: it is live through that top;
 *   - is `stack-base-moved` when none does (P was rebased; its children still carry the old head): set aside, the
 *     children's tops kept until they are restacked. This deliberately overrides "live overlays win" for P. A
 *     PINNED moved base is never set aside (it may carry mechanism the tops lack) — it stays an independent overlay.
 * Overlays whose PR is MERGED/CLOSED or whose ref is gone take no part (the main loop removes them).
 * @returns {Promise<{setAside:Map<string,{ref:string,pr:number|null,sha:string,reason:string,tops:Array<object>}>,
 *   tops:Array<{ref:string,pr:number|null,sha:string}>}>} `tops` = the tops of stacks only, in list order.
 */
export async function planOverlayStacks({ git, mainSha, overlays, stateOf = async () => null, prBaseChain = null, isPinned = () => false }) {
  void mainSha;
  const nodes = [];
  for (const raw of overlays) {
    if (!raw?.ref || nodes.some((n) => n.ref === raw.ref)) continue;
    const pr = raw.pr ?? null;
    const st = await stateOf(pr);
    if (st === 'MERGED' || st === 'CLOSED') continue;
    const sha = verifyRev(git, `refs/remotes/origin/${raw.ref}^{commit}`);
    if (!sha) continue;
    let chain = null;
    if (pr != null && typeof prBaseChain === 'function') {
      try { chain = await prBaseChain(pr); } catch { chain = null; }
    }
    nodes.push({ raw, ref: raw.ref, pr, sha, chain: Array.isArray(chain) ? chain : [] });
  }
  const anc = (a, b) => a !== b && git(['merge-base', '--is-ancestor', a, b]).status === 0;
  const children = new Map(nodes.map((n) => [n.ref, new Set()]));
  for (const c of nodes) {
    for (const p of nodes) {
      if (p === c || p.sha === c.sha) continue;
      if (c.chain.includes(p.ref) || anc(p.sha, c.sha)) children.get(p.ref).add(c.ref);
    }
  }
  const byRef = new Map(nodes.map((n) => [n.ref, n]));
  const descendants = (ref) => {
    const seen = new Set();
    const walk = (r) => { for (const k of children.get(r) ?? []) if (!seen.has(k) && k !== ref) { seen.add(k); walk(k); } };
    walk(ref);
    return seen;
  };
  const isTop = (ref) => (children.get(ref)?.size ?? 0) === 0;
  const setAside = new Map();
  const stackTops = new Set();
  for (const p of nodes) {
    if (isTop(p.ref)) continue;
    const tops = nodes.filter((n) => descendants(p.ref).has(n.ref) && isTop(n.ref));
    if (tops.length === 0) continue; // a cycle of equal tips — leave it to the plain loop
    const containing = tops.filter((t) => anc(p.sha, t.sha));
    if (containing.length > 0) {
      setAside.set(p.ref, { ref: p.ref, pr: p.pr, sha: p.sha, reason: 'stack-contained', tops: containing.map(({ ref, pr, sha }) => ({ ref, pr, sha })) });
    } else if (!isPinned(p.raw, p.sha)) {
      setAside.set(p.ref, { ref: p.ref, pr: p.pr, sha: p.sha, reason: 'stack-base-moved', tops: tops.map(({ ref, pr, sha }) => ({ ref, pr, sha })) });
    } else continue;
    for (const t of tops) stackTops.add(t.ref);
  }
  return {
    setAside,
    tops: nodes.filter((n) => stackTops.has(n.ref)).map(({ ref, pr, sha }) => ({ ref, pr, sha })),
  };
}

// ── planRebuild — pure over an injected git(args) runner ────────────────────────────────────────────────────

/**
 * PURE (all IO through `git`/`prState`): compute the rebuild plan — resolve `mainRef`, walk `overlays` in list
 * order applying each on top of the running `cur` tip (auto-dropping ones main/PR state has already made moot,
 * conflict-dropping ones that don't merge cleanly THIS pass without forgetting them), and return the resulting
 * final sha plus a full decision log. Never mutates the overlay list itself — {@link rebuildClone} does that
 * from the returned `decisions`.
 * Held item 212 — in `stackMode: 'tops'` (default) stacked overlays are planned as stacks (see {@link planOverlayStacks}):
 * only the tops apply, and a base contained in a top, or a base that moved away from its children, is SKIPPED (stays
 * registered) and comes back on its own only if none of its tops could apply.
 * @param {{git:(args:string[], opts?:{env?:object})=>{status:number,stdout:string,stderr:string},
 *   headSha:string, mainRef:string, overlays?:Array<{ref:string, pr?:number|null}>,
 *   prState?:(pr:number)=>(Promise<string|null>|string|null), mainOnly?:boolean, edgeResolve?:boolean,
 *   prBaseChain?:((pr:number)=>(Promise<string[]|null>|string[]|null))|null, stackMode?:'tops'|'independent',
 *   stackModeSource?:string}} o
 * @returns {Promise<{ok:false, reason:'main-unresolved'}|{ok:true, mainSha:string, finalSha:string,
 *   applied:Array<{ref:string,pr:number|null,sha:string}>,
 *   decisions:Array<{ref:string,pr:number|null,action:'remove'|'drop'|'skip'|'apply',reason:string,sha:string|null}>,
 *   alerts:Array<object>, inputsKey:string, upToDate:boolean}>}
 */
export async function planRebuild({
  git, headSha, mainRef, overlays = [], prState, mainOnly = false, edgeResolve = true,
  prBaseChain = null, stackMode = 'tops', stackModeSource = 'standard',
}) {
  const mainSha = verifyRev(git, `${mainRef}^{commit}`);
  if (!mainSha) return { ok: false, reason: 'main-unresolved' };

  const alerts = [];
  const decisions = [];
  const applied = [];
  let cur = mainSha;

  // x5059uu (live 2026-10-09 19:54:32Z) — an overlay whose tip is already in the running HEAD is ESTABLISHED: it is
  // live and proven. A changed or newly added overlay is a NEWCOMER. Established overlays apply first (each group
  // keeps list order), so when a newcomer conflicts with them it is the newcomer that is parked, never the proven
  // ones. Before this, #4643 (registered first) pushed a conflicting commit and the rebuild conflict-dropped the
  // live #4658/#4663 instead. With no newcomer (or no established overlay) the order is plain list order.
  const isEstablished = (raw) => {
    if (!headSha || !raw?.ref) return false;
    const sha = verifyRev(git, `refs/remotes/origin/${raw.ref}^{commit}`);
    return !!sha && git(['merge-base', '--is-ancestor', sha, headSha]).status === 0;
  };
  const listed = mainOnly ? [] : overlays;
  const establishedRefs = new Set(listed.filter(isEstablished).map((o) => o.ref));
  const conflictFiles = new Map(); // ref → the files its conflict named (for the x5059uu alerts below)
  const toProcess = [
    ...listed.filter((o) => establishedRefs.has(o?.ref)), ...listed.filter((o) => !establishedRefs.has(o?.ref)),
  ];
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

  // Each PR's state is read ONCE per plan (the stack pass below needs it before the main loop does).
  const stateCache = new Map();
  const stateOf = async (pr) => {
    if (pr == null || !prState) return null;
    if (!stateCache.has(pr)) stateCache.set(pr, await prState(pr));
    return stateCache.get(pr);
  };

  // Held item 212 (live 2026-10-10) — stacked overlay PRs are one stack: apply only its tops. See planOverlayStacks.
  const stacks = stackMode === 'tops' && listed.length > 1
    ? await planOverlayStacks({ git, mainSha, overlays: listed, stateOf, prBaseChain, isPinned: (raw, sha) => pinnedStatus(git, raw, mainSha, sha).pinned })
    : { setAside: new Map(), tops: [] };
  if (stacks.setAside.size > 0) {
    const label = (o) => (o.pr != null ? `#${o.pr}` : o.ref);
    const asides = [...stacks.setAside.values()];
    for (const a of asides.filter((x) => x.reason === 'stack-base-moved')) {
      alerts.push({
        kind: 'overlay-stack-base-moved',
        detail: {
          ref: a.ref, pr: a.pr, sha: a.sha, tops: a.tops.map((t) => t.ref),
          message: `stack base moved: ${label(a)} set aside, tops ${a.tops.map(label).join(' ')} kept until restacked`,
        },
      });
    }
    const why = asides.map((a) => (a.reason === 'stack-base-moved'
      ? `${label(a)} set aside (base moved; its children carry its old head)`
      : `${label(a)} set aside (contained in ${a.tops.map(label).join(' ')})`));
    alerts.push({
      kind: 'overlay-stack-tops',
      detail: {
        mode: stackMode, source: stackModeSource, tops: stacks.tops.map(label),
        setAside: asides.map((a) => ({ ref: a.ref, pr: a.pr, reason: a.reason, tops: a.tops.map((t) => t.ref) })),
        message: `overlay stacks (overlay.stackMode=${stackMode}, ${stackModeSource}): tops ${stacks.tops.map(label).join(' ')}; ${why.join('; ')}`,
      },
    });
  }

  for (const raw of toProcess) {
    const ref = raw?.ref;
    const pr = raw?.pr ?? null;

    // 1. PR state — MERGED/CLOSED means the overlay is moot; never call prState for a PR-less overlay.
    const state = await stateOf(pr);
    if (state === 'MERGED' || state === 'CLOSED') {
      if (state === 'CLOSED' && raw?.pinned === true) return refusePinned(ref, pr, null, 'pr-closed', 'flag');
      decisions.push({ ref, pr, action: 'remove', reason: state === 'MERGED' ? 'pr-merged' : 'pr-closed', sha: null });
      continue;
    }

    // 1b. a stack base set aside for its tops (held item 212): skipped this pass, never dropped or removed.
    const aside = stacks.setAside.get(ref);
    if (aside) {
      decisions.push({ ref, pr, action: 'skip', reason: aside.reason, sha: aside.sha, tops: aside.tops.map((t) => t.ref) });
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
        conflictFiles.set(ref, resolution?.files ?? conflictFilesOf(mt.stdout));
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

  // 7. retry pass (held item 168, live 2026-10-09) — an overlay conflict-dropped (or a pinned one skipped) above may
  //    merge cleanly once a LATER overlay in the list has applied: e.g. the later one moved shared settings keys out
  //    of the file both edited. List order is only registration order, so without this the fixing overlay can never
  //    help the one it fixes until it reaches main. One plain retry each, in list order, on the final tip; a still-
  //    conflicting overlay stays dropped. Deterministic: same inputs → same tips, same order.
  for (const d of decisions) {
    const retriable = (d.action === 'drop' && d.reason === 'conflict')
      || (d.action === 'skip' && d.reason === 'pinned-overlay-conflict-skipped');
    if (!retriable || !d.sha) continue;
    const mt = git(['merge-tree', '--write-tree', '--no-messages', cur, d.sha]);
    const tree = String(mt.stdout ?? '').split('\n')[0].trim();
    if (mt.status !== 0 || !tree) continue;
    if (tree === verifyRev(git, `${cur}^{tree}`)) continue;
    const ct = git(['commit-tree', tree, '-p', cur, '-p', d.sha, '-m',
      `daemon-rebuild: merge overlay ${d.ref}${d.pr != null ? ` (PR #${d.pr})` : ''} onto ${cur} (retried after later overlays)`], {
      env: rebuildCommitEnv(git, cur, d.sha),
    });
    const newSha = String(ct.stdout ?? '').trim();
    if (ct.status !== 0 || !newSha) continue;
    cur = newSha;
    applied.push({ ref: d.ref, pr: d.pr, sha: d.sha });
    d.action = 'apply';
    d.reason = 'applied-retry';
    alerts.push({ kind: 'overlay-conflict-retried', detail: { ref: d.ref, pr: d.pr, sha: d.sha } });
  }

  // 7b. stack fallback (held item 212) — a base set aside for its tops comes back when NONE of those tops applied
  //     (each was dropped for its own conflict): the stack never loses both the base and its tops.
  const appliedRefs = () => new Set(applied.map((a) => a.ref));
  for (const d of decisions) {
    if (d.action !== 'skip' || !['stack-base-moved', 'stack-contained'].includes(d.reason) || !d.sha) continue;
    if ((d.tops ?? []).some((t) => appliedRefs().has(t))) continue;
    const mt = git(['merge-tree', '--write-tree', '--no-messages', cur, d.sha]);
    const tree = String(mt.stdout ?? '').split('\n')[0].trim();
    if (mt.status !== 0 || !tree || tree === verifyRev(git, `${cur}^{tree}`)) continue;
    const ct = git(['commit-tree', tree, '-p', cur, '-p', d.sha, '-m',
      `daemon-rebuild: merge overlay ${d.ref}${d.pr != null ? ` (PR #${d.pr})` : ''} onto ${cur} (stack base; its tops did not apply)`], {
      env: rebuildCommitEnv(git, cur, d.sha),
    });
    const newSha = String(ct.stdout ?? '').trim();
    if (ct.status !== 0 || !newSha) continue;
    cur = newSha;
    applied.push({ ref: d.ref, pr: d.pr, sha: d.sha });
    d.action = 'apply';
    d.reason = 'applied-stack-fallback';
    alerts.push({ kind: 'overlay-stack-fallback', detail: { ref: d.ref, pr: d.pr, sha: d.sha, tops: d.tops } });
  }

  // x5059uu — say who lost, after the retry pass (a retried overlay is no longer dropped). A newcomer is PARKED: the
  // alert names its conflicting files and the established overlays they collide with, so its author can merge
  // those branches in. An established overlay that still drops (main itself moved onto it) is never silent.
  for (const d of decisions) {
    if (d.action !== 'drop' || d.reason !== 'conflict') continue;
    const files = conflictFiles.get(d.ref) ?? [];
    if (establishedRefs.has(d.ref)) {
      alerts.push({
        kind: 'established-overlay-dropped',
        detail: {
          ref: d.ref, pr: d.pr, sha: d.sha, files,
          message: `LIVE overlay ${d.ref}${d.pr != null ? ` (PR #${d.pr})` : ''} is in the running build but conflicts on ${files.join(', ') || '?'} — this rebuild drops it; rebase its branch onto main`,
        },
      });
      continue;
    }
    const collidesWith = applied
      .filter((a) => establishedRefs.has(a.ref))
      .map((a) => ({ ref: a.ref, pr: a.pr, files: changedFiles(git, mainSha, a.sha).filter((p) => files.includes(p)) }))
      .filter((c) => c.files.length > 0);
    // A newcomer that only conflicts with main or with another newcomer is an ordinary conflict drop (reported as
    // overlay-conflict-dropped); "parked" means it lost to the live set.
    if (collidesWith.length === 0) continue;
    alerts.push({
      kind: 'overlay-newcomer-parked',
      detail: {
        ref: d.ref, pr: d.pr, sha: d.sha, files, collidesWith,
        message: `parked ${d.ref}${d.pr != null ? ` (PR #${d.pr})` : ''}: its new head conflicts on ${files.join(', ') || '?'}`
          + ` with live overlay(s) ${collidesWith.map((c) => c.ref).join(', ')} — merge them into it`,
      },
    });
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
