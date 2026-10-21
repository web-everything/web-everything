/** @file scripts/lib/daemon-rebuild/auto-rebase.mjs — rebase an overlay past a PR that merged to main (overlay-rebase-on-merge).
 *
 * Live 2026-10-21 14:57 ET (review clone): #5758 merged to main and the registered overlay containers conflicted with
 * the new main in 7 files. x9diisp then held the WHOLE clone (`established-overlay-hold`). Pinning (overlay-pin) cannot
 * help when MAIN moved: the adopted head conflicts with main too.
 *
 * WHAT IT DOES. When an overlay conflicts with main, look for HARD evidence that the overlay carries an EARLIER head X of
 * a PR that has since merged: X is an ancestor of the overlay tip, not of main, and X is
 *   - a head of that PR a build this clone ADOPTED applied (its own rebuild state, `state.adoptedHeads` — never commit
 *     text, which anyone can write), or a base an earlier adopted auto-rebase proved;
 *   - and GitHub says PR #N is MERGED into `main` with a merge commit that is on this main, AND GitHub links X itself to
 *     PR #N (`commits/{X}/pulls`).
 * Then the overlay is merged onto the build with X as the merge base (`git merge-tree --merge-base=X`). That keeps EVERY
 * change the overlay made after X (its own behaviour) and lets main's side win only for what X itself carried — the
 * merged PR's own older content. If no candidate merges cleanly, nothing is resolved: the caller sets the overlay aside.
 * X must carry only the PR's own work beyond main (no merge of another branch in main..X), so the merge can only ever
 * replace that PR's older content. No look-alike evidence (author, subject, patch text) is ever used, and no hunk is
 * ever resolved by picking a side.
 */

import { FULL_SHA_RE, verifyRev } from './shared.mjs';


const lines = (r) => (r.status === 0 ? String(r.stdout ?? '').split('\n').filter((l) => l.trim()) : []);

/**
 * X's own history beyond main is only the PR's own work: every merge commit in main..X merges main-reachable history in
 * — every parent after the FIRST (the branch the merge was made on) is an ancestor of main. A PR head that merged
 * ANOTHER branch (even onto a main-based first parent) carries that branch's content, which a merge with X as base
 * could silently drop — such an X is never a candidate (fail closed: set aside instead).
 */
function onlyPrOwnHistory(git, mainSha, sha) {
  const merges = git(['rev-list', '--merges', '--parents', sha, '--not', mainSha]);
  if (merges.status !== 0) return false;
  for (const l of lines(merges)) {
    const [, , ...merged] = l.split(' ');
    if (merged.some((p) => git(['merge-base', '--is-ancestor', p, mainSha]).status !== 0)) return false;
  }
  return true;
}

/**
 * The merged-PR old heads an overlay carries, newest first (a candidate that contains another comes before it).
 * Evidence is never read from commit text:
 *   - `adoptedHeads` — `{pr, sha}` this clone's own rebuild state recorded from builds it ADOPTED (`applied` only), or
 *     `proven` entries this same plan already proved;
 *   - `prMerge(pr)` — GitHub's own answer `{state, baseRefName, mergeCommit}`: the PR must be MERGED into `main` and its
 *     merge commit must be on this main. No reader, or any doubt, means no candidate (fail closed).
 * `otherHeads` (every head of any overlay this clone ever saw) are only ever used to REFUSE a candidate.
 * @returns {Promise<{candidates:Array<{sha:string, pr:number, evidence:string}>, mergedPrs:number[]}>}
 */
export async function mergedPrOldHeads({
  git, mainSha, ovSha, ovPr = null, prMerge = null, commitPulls = null, adoptedHeads = [], otherHeads = [],
}) {
  const isAnc = (a, b) => git(['merge-base', '--is-ancestor', a, b]).status === 0;
  const ancStrict = (a, b) => {
    const r = git(['merge-base', '--is-ancestor', a, b]);
    return r.status === 0 ? true : r.status === 1 ? false : null;
  };
  // Who may share history with X beyond main:
  //   - heads of X's own PR: that history IS the PR;
  //   - heads of the overlay being rebased only when STRICTLY built on X (X + its own work after X); its head AT X, or
  //     inside/beside X (its own earlier work with X built on it — Codex rounds 7/9), blocks;
  //   - any other head blocks, even one built on X (a stack whose base sits inside X), even at the same SHA.
  // FAIL CLOSED: a head git cannot answer for (unresolved, object gone) blocks. A wrong block only sets aside, loudly.
  const foreign = (sha, pr) => otherHeads.some((h) => {
    if (!h || h.unresolved || !h.sha) return true;
    if (Number(h.pr) === pr) return false;
    if (!FULL_SHA_RE.test(h.sha) || git(['cat-file', '-e', `${h.sha}^{commit}`]).status !== 0) return true;
    if (ovPr != null && Number(h.pr) === Number(ovPr) && h.sha !== sha) {
      const built = ancStrict(sha, h.sha);
      if (built === null) return true;
      if (built) return false;
    }
    const mb = git(['merge-base', '--all', sha, h.sha]);
    if (mb.status === 1 && !String(mb.stdout ?? '').trim()) return false; // unrelated histories: nothing shared
    if (mb.status !== 0) return true;
    return lines(mb).some((b) => ancStrict(b, mainSha) !== true);
  });
  const keep = (sha, pr) => FULL_SHA_RE.test(sha) && sha !== ovSha && isAnc(sha, ovSha) && !isAnc(sha, mainSha)
    && onlyPrOwnHistory(git, mainSha, sha) && !foreign(sha, pr);
  const verdicts = new Map();
  const mergedIntoThisMain = async (pr) => {
    if (typeof prMerge !== 'function') return false;
    if (!verdicts.has(pr)) {
      let m = null;
      try { m = await prMerge(pr); } catch { m = null; }
      verdicts.set(pr, !!m && m.state === 'MERGED' && m.baseRefName === 'main' && typeof m.mergeCommit === 'string'
        && FULL_SHA_RE.test(m.mergeCommit) && ancStrict(m.mergeCommit, mainSha) === true);
    }
    return verdicts.get(pr);
  };

  // X ITSELF must be linked to PR N by GitHub (`commits/{X}/pulls` lists N — Codex round 10: a branch label on this clone
  // is not proof; the branch may have advanced after the merge under the old number). No reader or any doubt = no.
  const xIsThePrs = async (sha, pr) => {
    if (typeof commitPulls !== 'function') return false;
    let prs = null;
    try { prs = await commitPulls(sha); } catch { prs = null; }
    return Array.isArray(prs) && prs.map(Number).includes(pr);
  };
  const found = new Map();
  for (const h of Array.isArray(adoptedHeads) ? adoptedHeads : []) {
    const pr = Number(h?.pr);
    if (!Number.isInteger(pr) || pr <= 0 || typeof h?.sha !== 'string' || found.has(h.sha) || !keep(h.sha, pr)) continue;
    if (h.proven === true) { found.set(h.sha, { sha: h.sha, pr, evidence: h.evidence ?? 'proven' }); continue; }
    if (await mergedIntoThisMain(pr) && await xIsThePrs(h.sha, pr)) found.set(h.sha, { sha: h.sha, pr, evidence: 'adopted-head' });
  }

  const candidates = [...found.values()];
  candidates.sort((a, b) => (isAnc(b.sha, a.sha) ? -1 : isAnc(a.sha, b.sha) ? 1 : 0));
  return { candidates, mergedPrs: [...new Set(candidates.map((c) => c.pr))] };
}

/**
 * Merge `ovSha` onto `cur` with a proven merged-PR old head as the merge base. First clean candidate wins.
 * @returns {{ok:true, tree:string, base:{sha:string, pr:number, evidence:string}}|{ok:false}}
 */
export function tryAutoRebase({ git, cur, ovSha, candidates }) {
  const curTree = verifyRev(git, `${cur}^{tree}`);
  // X may only REFINE the real merge base, never replace a newer one (Codex round 12): if the overlay merged history
  // the build shares that X lacks (e.g. a later main commit, then reverted part of it), forcing X as base would read the
  // overlay's own later change as "unchanged since X" and silently take the build's side. So every real merge base of
  // (cur, overlay) must be an ancestor of X; any doubt refuses.
  const realBases = git(['merge-base', '--all', cur, ovSha]);
  if (realBases.status !== 0) return { ok: false };
  const bases = String(realBases.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (const c of candidates) {
    if (bases.length === 0 || !bases.every((b) => git(['merge-base', '--is-ancestor', b, c.sha]).status === 0)) continue;
    const mt = git(['merge-tree', '--write-tree', '--no-messages', `--merge-base=${c.sha}`, cur, ovSha]);
    const tree = String(mt.stdout ?? '').split('\n')[0].trim();
    if (mt.status === 0 && tree && tree !== curTree) return { ok: true, tree, base: c };
  }
  return { ok: false };
}

export const autoRebaseSuffix = (base) => ` (auto-rebased past PR #${base.pr} at ${base.sha})`;
