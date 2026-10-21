/** @file scripts/lib/daemon-rebuild/plan.mjs — Overlay application plan.
 * Split out of daemon-rebuild.mjs (move-only).
 */

import { verifyRev, rebuildCommitEnv, FULL_SHA_RE, REBUILD_IDENTITY_ENV } from './shared.mjs';
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

/** A full commit id — the only shape a sha read from git output or the GitHub API may take before it reaches a git argv. */
const OID = FULL_SHA_RE;
/** Who commits a daemon build's overlay merges (REBUILD_IDENTITY_ENV) — only those merges count as adopted heads. */
const REBUILD_COMMITTER = REBUILD_IDENTITY_ENV.GIT_COMMITTER_EMAIL;

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
 * Operator ruling (2026-10-11, PR #4815): only HARD evidence decides; look-alike commits (author/subject, patch-id) never do.
 * MEMBERSHIP: an overlay C is a CHILD of a registered overlay P when P's tip is an ancestor of C's tip, or C's PR base
 * chain (gh baseRefName, nearest first; else the entry's recorded `stackBases`) names P's branch. A TOP has no registered
 * child. Every non-top base P:
 *   - is `stack-contained` when one of its tops contains P's current tip: it is live through that top;
 *   - is `stack-base-moved` only when a top that really clashes with it (merge-tree status 1) contains a head P has
 *     since moved away from (not in main) — proven by (a) a head of P (same branch AND PR) an earlier daemon build
 *     merged (a rebuild-committed `daemon-rebuild: merge overlay <P> (PR #n)` on the first-parent line of HEAD or a
 *     HEAD reflog entry — "the recorded adopted head sha changing", fast-forwards included), or (b) the `before`
 *     commit of a GitHub head_ref_force_pushed event on P's PR. Set aside, the children's tops kept until they are
 *     restacked. The entry's `tops` are only the CARRIERS — clashing tops that contain a proven old head of P (for
 *     `last-adopted`, the clashing tops that build merged) — since only they replace P (see the 7b fallback). This deliberately overrides "live overlays win" for P. A sibling retargeted onto P never contains a
 *     head of P, so it never evicts P (it is reported in `unconfirmed` and parked by the plain conflict rule).
 *   - with no fresh proof — the force-push read is UNKNOWN (gh unreachable; reported in `unknown`), or the proof aged
 *     out of the reflog — the last adopted build decides: P keeps what it had there — set aside if HEAD merged a
 *     clashing top but not P, and that top still holds the head HEAD merged, else live. Never a fresh eviction. When
 *     HEAD holds a proven old head of P that no clashing top carries any more, the top that replaced P is gone (closed
 *     or rewritten): P is live again, never kept aside for an unrelated clashing top the build also merged. Only hard
 *     evidence counts here too: no merge-base guess at which commits are P's (a parent P sat on looks the same).
 * A PINNED base (flag or mechanism), contained or moved, is never set aside — it stays an independent overlay, so
 * its pin refuses a conflicting build rather than the build silently going without it. A registered overlay whose
 * tip is already an ancestor of main takes no part either (the main loop removes it as `in-main`).
 * Overlays whose PR is MERGED/CLOSED or whose ref is gone take no part (the main loop removes them).
 * If every top merges cleanly with a non-contained base, both apply independently.
 * Residue: P registered while its tip was a bare shared prerequisite H, then extended — a sibling built on H carries an
 * adopted head of P. A child built on a head of P the daemon never merged and GitHub never force-pushed away is not
 * recognised (a safe miss: nothing is evicted).
 * `keepIndependent` names refs that must never be set aside (a base whose fallback could not be merged — see the 7b
 * pass of {@link planRebuild}).
 * @returns {Promise<{setAside:Map<string,{ref:string,pr:number|null,sha:string,reason:string,evidence?:string,tops:Array<object>}>,
 *   tops:Array<{ref:string,pr:number|null,sha:string}>, unconfirmed:Array<{ref:string,base:string}>,
 *   unknown:Array<{ref:string,pr:number|null,kept:'live'|'set-aside',tops:string[]}>}>}
 *   `tops` = the tops of stacks only, in list order.
 */
export async function planOverlayStacks({
  git, mainSha, overlays, stateOf = async () => null, prBaseChain = null, isPinned = () => false, keepIndependent = new Set(),
  headSha = null, prForcePushes = null,
}) {
  const nodes = [];
  for (const raw of overlays) {
    if (!raw?.ref || nodes.some((n) => n.ref === raw.ref)) continue;
    const pr = raw.pr ?? null;
    const st = await stateOf(pr);
    if (st === 'MERGED' || st === 'CLOSED') continue;
    const sha = verifyRev(git, `refs/remotes/origin/${raw.ref}^{commit}`);
    if (!sha) continue;
    // Already in main by ancestry: no part in any stack. The main loop removes it as `in-main`; left in, it would
    // be a base of any newer overlay branched from main and be set aside, so it would never be removed.
    if (git(['merge-base', '--is-ancestor', sha, mainSha]).status === 0) continue;
    let chain = null;
    if (pr != null && typeof prBaseChain === 'function') {
      try { chain = await prBaseChain(pr); } catch { chain = null; }
    }
    if (!Array.isArray(chain)) chain = Array.isArray(raw.stackBases) ? raw.stackBases : [];
    nodes.push({ raw, ref: raw.ref, pr, sha, chain });
  }
  const anc = (a, b) => a !== b && git(['merge-base', '--is-ancestor', a, b]).status === 0;
  const outLines = (r) => (r.status === 0 ? String(r.stdout ?? '').split('\n').filter((l) => l.trim()) : []);
  // The overlay heads one daemon build merged, as `{ref, pr, sha}`: the second parent of each two-parent
  // `daemon-rebuild: merge overlay <ref> [(PR #n)] onto …` commit the rebuild identity committed on the build's
  // first-parent line above main (newest 200). Local and daemon-made: an overlay's own commits sit on second-parent
  // lines and carry their author's committer, so they never count. Cached per build.
  const buildCache = new Map();
  const mergedBy = (build) => {
    if (!build || !OID.test(build)) return [];
    if (!buildCache.has(build)) {
      const merged = [];
      const log = git(['log', '--first-parent', '-n', '200', '--format=%P%x09%ce%x09%s', build, '--not', mainSha]);
      for (const l of outLines(log)) {
        const [parents, committer, ...rest] = l.split('\t');
        const ps = parents.split(' ');
        const hit = rest.join('\t').match(/^daemon-rebuild: merge overlay (\S+) (?:\(PR #(\d+)\) )?onto /);
        if (!hit || committer !== REBUILD_COMMITTER || ps.length !== 2 || !OID.test(ps[1])) continue;
        merged.push({ ref: hit[1], pr: hit[2] != null ? Number(hit[2]) : null, sha: ps[1] });
      }
      buildCache.set(build, merged);
    }
    return buildCache.get(build);
  };
  // The same overlay: same branch AND same PR (a branch name reused by another PR is a different overlay).
  const prKey = (pr) => (pr == null || pr === '' ? null : Number(pr));
  const sameOverlay = (m, n) => m.ref === n.ref && prKey(m.pr) === prKey(n.pr);
  // Every adopted build this clone still remembers: the running HEAD, then the HEAD reflog (newest 50) — each rebuild
  // moves HEAD onto the build it adopted, so the reflog keeps the heads of P that earlier builds merged.
  let builds = null;
  const adoptedHeads = (n) => {
    if (!builds) {
      builds = [...new Set([headSha, ...outLines(git(['reflog', '-n', '50', '--format=%H', 'HEAD']))].filter((s) => s && OID.test(s)))];
    }
    return new Set(builds.flatMap((b) => mergedBy(b).filter((m) => sameOverlay(m, n)).map((m) => m.sha)));
  };
  const fpCache = new Map();
  const forcePushedHeads = async (pr) => {
    if (pr == null || typeof prForcePushes !== 'function') return null;
    if (!fpCache.has(pr)) {
      let events = null;
      try { events = await prForcePushes(pr); } catch { events = null; }
      fpCache.set(pr, Array.isArray(events) && events.every((e) => typeof e?.before === 'string' && OID.test(e.before))
        ? events.map((e) => e.before) : null);
    }
    return fpCache.get(pr);
  };
  // Hard evidence that P moved away from a head one of `clashing` was built on: `{evidence, carriers}`, where
  // `carriers` are the clashing tops that contain a proven old head of P — adopted OR force-pushed away, together (the
  // tops that replace P) — or `{evidence:null}` when it cannot be known.
  // `heads` = every proven old head of P known this pass (not in main), for the no-proof rule below.
  const movedEvidence = async (p, clashing) => {
    // A head already in main is everyone's history, not P's: never evidence.
    const ownHeads = (heads) => heads.filter((s) => s !== p.sha && git(['merge-base', '--is-ancestor', s, mainSha]).status !== 0);
    const carriersOf = (heads) => clashing.filter((t) => heads.some((s) => anc(s, t.sha)));
    const adoptedOwn = ownHeads([...adoptedHeads(p)]);
    const adopted = carriersOf(adoptedOwn);
    if (adopted.length === clashing.length) return { evidence: 'adopted-head', carriers: adopted, heads: adoptedOwn };
    const before = await forcePushedHeads(p.pr);
    if (before == null) {
      return adopted.length > 0 ? { evidence: 'adopted-head', carriers: adopted, heads: adoptedOwn } : { evidence: null, carriers: [], heads: adoptedOwn };
    }
    const pushedOwn = ownHeads(before);
    const pushed = carriersOf(pushedOwn);
    const carriers = clashing.filter((t) => adopted.includes(t) || pushed.includes(t));
    const heads = [...adoptedOwn, ...pushedOwn];
    if (carriers.length === 0) return { evidence: 'none', carriers, heads };
    return { evidence: adopted.length > 0 ? 'adopted-head' : 'force-pushed', carriers, heads };
  };
  const unconfirmed = [];
  const unknown = [];
  const children = new Map(nodes.map((n) => [n.ref, new Set()]));
  for (const c of nodes) {
    for (const p of nodes) {
      if (p === c || p.sha === c.sha) continue;
      if (anc(p.sha, c.sha) || c.chain.includes(p.ref)) children.get(p.ref).add(c.ref);
    }
  }
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
    // A PINNED base (flag or mechanism) is never set aside, contained or moved: it stays an independent overlay, so a
    // conflict reaches `refusePinned` instead of leaving the build without it.
    if (isPinned(p.raw, p.sha) || keepIndependent.has(p.ref)) continue;
    const tops = nodes.filter((n) => descendants(p.ref).has(n.ref) && isTop(n.ref));
    if (tops.length === 0) continue; // a cycle of equal tips — leave it to the plain loop
    const containing = tops.filter((t) => anc(p.sha, t.sha));
    if (containing.length > 0) {
      setAside.set(p.ref, { ref: p.ref, pr: p.pr, sha: p.sha, reason: 'stack-contained', tops: containing.map(({ ref, pr, sha }) => ({ ref, pr, sha })) });
    } else {
      // A moved base is only worth setting aside when a top really clashes with it (merge-tree status 1). Clean merge or a
      // git error: both apply on their own, as before stacks existed.
      const clashing = tops.filter((t) => git(['merge-tree', '--write-tree', '--no-messages', p.sha, t.sha]).status === 1);
      if (clashing.length === 0) continue;
      // Only the tops that replace P are recorded on the set-aside entry: the 7b fallback brings P back unless one of
      // THEM applied, so an unrelated top (one that carries no head of P, or merges cleanly with P) never suppresses it.
      let { evidence, carriers, heads } = await movedEvidence(p, clashing);
      if (evidence == null || evidence === 'none') {
        // No fresh proof (unknown, or the proof aged out of the reflog): keep what the last adopted build did with P —
        // set aside if it merged a clashing top but not P, else live. Never a fresh eviction.
        // P's tip already in HEAD (merged directly, or through a top that contained it) means P is live: never set aside.
        // A carrier here is a clashing top the last build merged that still holds the head it merged (a top rewritten
        // since carries nothing of what replaced P; one amended in place looks the same without proof, so it errs loud:
        // P comes back and the plain conflict rule parks the loser, never a silent loss). And when the last build holds a
        // proven old head of P that no clashing top carries any more, the top that replaced P is gone: P is not kept
        // aside for the others.
        const last = mergedBy(headSha);
        const pLive = !!headSha && git(['merge-base', '--is-ancestor', p.sha, headSha]).status === 0;
        const lastHeldOldHead = !!headSha && heads.some((s) => anc(s, headSha));
        carriers = lastHeldOldHead ? [] : clashing.filter((t) => last.some((m) => sameOverlay(m, t) && (m.sha === t.sha || anc(m.sha, t.sha))));
        const keptAside = !pLive && !last.some((m) => sameOverlay(m, p)) && carriers.length > 0;
        if (evidence == null) unknown.push({ ref: p.ref, pr: p.pr, kept: keptAside ? 'set-aside' : 'live', tops: clashing.map((t) => t.ref) });
        else if (!keptAside) for (const t of clashing) unconfirmed.push({ ref: t.ref, base: p.ref });
        if (!keptAside) continue;
        evidence = 'last-adopted';
      }
      setAside.set(p.ref, {
        ref: p.ref, pr: p.pr, sha: p.sha, reason: 'stack-base-moved', evidence, tops: carriers.map(({ ref, pr, sha }) => ({ ref, pr, sha })),
      });
    }
    for (const t of tops) stackTops.add(t.ref);
  }
  return {
    setAside,
    tops: nodes.filter((n) => stackTops.has(n.ref)).map(({ ref, pr, sha }) => ({ ref, pr, sha })),
    unconfirmed,
    unknown,
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
 * registered) and comes back on its own only if none of its tops could apply. Exceptions: a PINNED base is never set
 * aside (it applies on its own; listed after a top that contains it, it is `skip`ped as `pinned-contained-in-applied`
 * rather than removed as `in-main`), and an overlay already an ancestor of main is not part of any stack.
 * @param {{git:(args:string[], opts?:{env?:object})=>{status:number,stdout:string,stderr:string},
 *   headSha:string, mainRef:string, overlays?:Array<{ref:string, pr?:number|null}>,
 *   prState?:(pr:number)=>(Promise<string|null>|string|null), mainOnly?:boolean, edgeResolve?:boolean,
 *   prBaseChain?:((pr:number)=>(Promise<string[]|null>|string[]|null))|null,
 *   prForcePushes?:((pr:number)=>(Promise<Array<{before:string,after?:string|null}>|null>))|null, stackMode?:'tops'|'independent',
 *   stackModeSource?:string}} o
 * @returns {Promise<{ok:false, reason:'main-unresolved'}|{ok:true, mainSha:string, finalSha:string,
 *   applied:Array<{ref:string,pr:number|null,sha:string}>,
 *   decisions:Array<{ref:string,pr:number|null,action:'remove'|'drop'|'skip'|'apply',reason:string,sha:string|null}>,
 *   alerts:Array<object>, inputsKey:string, upToDate:boolean}>}
 */
export async function planRebuild({
  git, headSha, mainRef, overlays = [], prState, mainOnly = false, edgeResolve = true,
  prBaseChain = null, prForcePushes = null, stackMode = 'tops', stackModeSource = 'standard', keepIndependent = new Set(),
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
  // Application priority belongs to the proven TIP, but loss protection belongs to the carried OVERLAY.
  // A docs-only fast-forward (or a force-push) must not turn a live hotfix into a disposable newcomer.
  // Read only this running build's first-parent merges, never past builds from the reflog. Match ref AND PR
  // so a branch reused by a different PR does not inherit the old overlay's hold. Do not truncate this walk:
  // an early overlay in a large running stack needs the same protection as its last overlay.
  const carriedRefs = new Set(establishedRefs);
  const carriedHeads = new Map();
  if (headSha && listed.some((o) => o?.ref && !establishedRefs.has(o.ref))) {
    const prKey = (pr) => (pr == null || pr === '' ? null : Number(pr));
    const registered = new Map(listed.filter((o) => o?.ref).map((o) => [o.ref, prKey(o.pr)]));
    const recordedRefs = new Set();
    const history = git(['log', '--first-parent', '--format=%P%x09%ce%x09%s', headSha, '--not', mainSha]);
    if (history.status !== 0) {
      // Unknown carried history cannot authorize dropping a conflicting registered overlay.
      for (const ref of registered.keys()) carriedRefs.add(ref);
    } else {
      for (const line of String(history.stdout ?? '').split('\n')) {
        const [parents, committer, ...subject] = line.split('\t');
        const ps = parents.split(' ');
        const hit = subject.join('\t').match(/^daemon-rebuild: merge overlay (\S+) (?:\(PR #(\d+)\) )?onto /);
        if (!hit || committer !== REBUILD_COMMITTER || ps.length !== 2 || !OID.test(ps[1])) continue;
        recordedRefs.add(hit[1]);
        if (!registered.has(hit[1]) || registered.get(hit[1]) !== prKey(hit[2])) continue;
        // A graduated old tip is already carried by main; only its new, unproven changes can be dropped now.
        if (git(['merge-base', '--is-ancestor', ps[1], mainSha]).status === 0) continue;
        carriedRefs.add(hit[1]);
        carriedHeads.set(hit[1], [...(carriedHeads.get(hit[1]) ?? []), ps[1]]);
      }
      // A stack base may have entered the build only through its top, with no merge record of its own.
      // Shared ancestry outside main proves a carried part of its old tip even after a docs-only advance.
      // A recorded identity (including a different PR reusing that ref) takes precedence over this inference.
      for (const ref of registered.keys()) {
        if (carriedRefs.has(ref) || recordedRefs.has(ref)) continue;
        const sha = verifyRev(git, `refs/remotes/origin/${ref}^{commit}`);
        if (!sha) continue;
        const bases = git(['merge-base', '--all', headSha, sha]);
        if (bases.status !== 0) {
          if (bases.status !== 1) carriedRefs.add(ref); // unreadable history, rather than unrelated histories
          continue;
        }
        const liveBases = String(bases.stdout ?? '').split('\n').filter((s) => OID.test(s)
          && git(['merge-base', '--is-ancestor', s, mainSha]).status !== 0);
        if (liveBases.length > 0) {
          carriedRefs.add(ref);
          carriedHeads.set(ref, liveBases);
        }
      }
    }
  }
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
    ? await planOverlayStacks({
      git, mainSha, overlays: listed, stateOf, prBaseChain, keepIndependent, headSha, prForcePushes,
      isPinned: (raw, sha) => pinnedStatus(git, raw, mainSha, sha).pinned,
    })
    : { setAside: new Map(), tops: [], unconfirmed: [], unknown: [] };
  if (keepIndependent.size > 0) {
    alerts.push({
      kind: 'overlay-stack-base-restored',
      detail: {
        refs: [...keepIndependent],
        message: `stack base(s) ${[...keepIndependent].join(', ')} could not be merged after their tops failed — planned again with them as independent overlays`,
      },
    });
  }
  if (stacks.unconfirmed.length > 0) {
    alerts.push({
      kind: 'overlay-stack-claim-unconfirmed',
      detail: {
        claims: stacks.unconfirmed,
        message: `stacked on a base with no hard evidence it moved (${stacks.unconfirmed.map((u) => `${u.ref} on ${u.base}`).join('; ')}) — the base stays live, the clashing child is planned as an independent overlay`,
      },
    });
  }
  if (stacks.unknown.length > 0) {
    alerts.push({
      kind: 'overlay-stack-evidence-unknown',
      detail: {
        bases: stacks.unknown,
        message: `could not read whether stack base(s) moved (${stacks.unknown.map((u) => `${u.ref}: kept ${u.kept}`).join('; ')}) — kept as the last adopted build had them`,
      },
    });
  }
  if (stacks.setAside.size > 0) {
    const label = (o) => (o.pr != null ? `#${o.pr}` : o.ref);
    const asides = [...stacks.setAside.values()];
    for (const a of asides.filter((x) => x.reason === 'stack-base-moved')) {
      alerts.push({
        kind: 'overlay-stack-base-moved',
        detail: {
          ref: a.ref, pr: a.pr, sha: a.sha, tops: a.tops.map((t) => t.ref), evidence: a.evidence,
          message: `stack base moved (${a.evidence}): ${label(a)} set aside, tops ${a.tops.map(label).join(' ')} kept until restacked`,
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
    const inMain = (sha) => {
      if (git(['merge-base', '--is-ancestor', sha, mainSha]).status === 0) return true;
      const m = git(['merge-tree', '--write-tree', '--no-messages', mainSha, sha]);
      const t = String(m.stdout ?? '').split('\n')[0].trim();
      return m.status === 0 && !!t && t === verifyRev(git, `${mainSha}^{tree}`);
    };
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
      // A PINNED overlay is only `in-main` when MAIN has it (tip an ancestor of main, or merging it onto main changes
      // nothing — the squash-merged shape). Content that only an already-applied overlay carries (listed after its
      // top, whether or not its exact tip is an ancestor of `cur`: a rebased base keeps the old head's content in its
      // top) is live through that top, not in main: it stays registered (`skip`), so the top later leaving never
      // loses it silently. Fail closed: a git error answering "is it in main?" counts as not in main.
      if (pinnedStatus(git, raw, mainSha, ovSha).pinned && !inMain(ovSha)) {
        decisions.push({ ref, pr, action: 'skip', reason: 'pinned-contained-in-applied', sha: ovSha });
        continue;
      }
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
  //     (each was dropped for its own conflict): the stack never loses both the base and its tops. `d.tops` holds only
  //     the tops that replace the base (containing it, or carrying a proven old head of it and clashing with it): any
  //     other top of the stack applying says nothing about the base's content, so it never suppresses the fallback.
  //     A base that CANNOT be merged back (a newcomer applied first and now clashes with it, or git failed) must never
  //     vanish silently: the whole plan is run again with that base as an ordinary independent overlay, so the normal
  //     rules decide (an established base goes first and the newcomer is parked; a pinned one refuses). Each pass adds
  //     at least one ref to `keepIndependent`, and a kept ref can no longer be set aside, so this ends.
  const appliedRefs = () => new Set(applied.map((a) => a.ref));
  const lostBases = [];
  for (const d of decisions) {
    if (d.action !== 'skip' || !['stack-base-moved', 'stack-contained'].includes(d.reason) || !d.sha) continue;
    if ((d.tops ?? []).some((t) => appliedRefs().has(t))) continue;
    const mt = git(['merge-tree', '--write-tree', '--no-messages', cur, d.sha]);
    const tree = String(mt.stdout ?? '').split('\n')[0].trim();
    if (mt.status !== 0 || !tree) { lostBases.push(d.ref); continue; }
    if (tree === verifyRev(git, `${cur}^{tree}`)) continue; // the build already carries its content
    const ct = git(['commit-tree', tree, '-p', cur, '-p', d.sha, '-m',
      `daemon-rebuild: merge overlay ${d.ref}${d.pr != null ? ` (PR #${d.pr})` : ''} onto ${cur} (stack base; its tops did not apply)`], {
      env: rebuildCommitEnv(git, cur, d.sha),
    });
    const newSha = String(ct.stdout ?? '').trim();
    if (ct.status !== 0 || !newSha) { lostBases.push(d.ref); continue; }
    cur = newSha;
    applied.push({ ref: d.ref, pr: d.pr, sha: d.sha });
    d.action = 'apply';
    d.reason = 'applied-stack-fallback';
    alerts.push({ kind: 'overlay-stack-fallback', detail: { ref: d.ref, pr: d.pr, sha: d.sha, tops: d.tops } });
  }
  if (lostBases.length > 0) {
    return planRebuild({
      git, headSha, mainRef, overlays, prState, mainOnly, edgeResolve, prBaseChain, prForcePushes, stackMode, stackModeSource,
      keepIndependent: new Set([...keepIndependent, ...lostBases]),
    });
  }

  // x5059uu — say who lost, after the retry pass (a retried overlay is no longer dropped). A newcomer is PARKED: the
  // alert names its conflicting files and the established overlays they collide with, so its author can merge
  // those branches in. An established overlay that still drops (main itself moved onto it) is never silent.
  // x9diisp (live 2026-10-20T11:51Z review clone) — the overlays the RUNNING build carries that this plan would build
  // without because they conflict-dropped. `prepareRebuild` holds the clone on its last-good build instead of building
  // (and later adopting) a tree that lost live hotfixes. A pinned overlay SKIPPED by xpinskip is not counted: that
  // ruling deliberately builds without it (loudly, `pinned-overlay-conflict-skipped`) so the fleet keeps moving.
  const establishedLost = [];
  for (const d of decisions) {
    if (d.action !== 'drop' || d.reason !== 'conflict') continue;
    const files = conflictFiles.get(d.ref) ?? [];
    const carriedSurvives = carriedHeads.has(d.ref)
      && carriedHeads.get(d.ref).every((sha) => git(['merge-base', '--is-ancestor', sha, cur]).status === 0);
    // An ESTABLISHED current tip always holds: another carrier preserving only an OLDER recorded tip says nothing
    // about the newer live changes. The carriedSurvives exception applies only to changed-tip newcomers.
    if (establishedRefs.has(d.ref) || (carriedRefs.has(d.ref) && !carriedSurvives)) {
      establishedLost.push({ ref: d.ref, pr: d.pr, sha: d.sha, reason: 'conflict', files });
      alerts.push({
        kind: 'established-overlay-dropped',
        detail: {
          ref: d.ref, pr: d.pr, sha: d.sha, files,
          message: `LIVE overlay ${d.ref}${d.pr != null ? ` (PR #${d.pr})` : ''} is in the running build but conflicts on ${files.join(', ') || '?'} — this rebuild drops it; rebase its branch onto main`,
        },
      });
      // A carried overlay's changed tip still gets newcomer conflict attribution below. It loses application
      // priority, but prepare must hold rather than adopt a build without the previous tip's live changes.
      if (establishedRefs.has(d.ref)) continue;
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
    ok: true, mainSha, finalSha: cur, applied, decisions, alerts, inputsKey, upToDate: cur === headSha, establishedLost,
  };
}
