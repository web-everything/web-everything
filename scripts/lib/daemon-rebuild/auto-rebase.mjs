/** @file scripts/lib/daemon-rebuild/auto-rebase.mjs — rebase an overlay past a PR that merged to main (overlay-rebase-on-merge).
 *
 * Live 2026-10-21 14:57 ET (review clone): #5758 merged to main and the registered overlay containers conflicted with
 * the new main in 7 files. x9diisp then held the WHOLE clone (`established-overlay-hold`). Pinning (overlay-pin) cannot
 * help when MAIN moved: the adopted head conflicts with main too.
 *
 * WHAT IT DOES. When an overlay conflicts with main, look for HARD evidence that the overlay carries an EARLIER head X of
 * a PR that has since merged: X is an ancestor of the overlay tip, not of main, and X is
 *   - a head of that PR a build this clone ADOPTED applied (its own rebuild state, `state.adoptedHeads` — never commit
 *     text, which anyone can write), with PR #N MERGED; or a base an earlier adopted auto-rebase proved;
 *   - or the `before` commit of a GitHub head_ref_force_pushed event on a PR whose merge commit is on main and whose
 *     merge touched a conflicted file.
 * Then the overlay is merged onto the build with X as the merge base (`git merge-tree --merge-base=X`). That keeps EVERY
 * change the overlay made after X (its own behaviour) and lets main's side win only for what X itself carried — the
 * merged PR's own older content. If no candidate merges cleanly, nothing is resolved: the caller sets the overlay aside.
 * X must carry only the PR's own work beyond main (no merge of another branch in main..X), so the merge can only ever
 * replace that PR's older content. No look-alike evidence (author, subject, patch text) is ever used, and no hunk is
 * ever resolved by picking a side.
 */

import { FULL_SHA_RE, verifyRev } from './shared.mjs';

const MERGE_PR_RE = /^Merge pull request #(\d+) from /;
/** How many relevant merged PRs' force-push histories one overlay may read (each is a GitHub call). */
const MAX_FORCE_PUSH_READS = 5;

const lines = (r) => (r.status === 0 ? String(r.stdout ?? '').split('\n').filter((l) => l.trim()) : []);

/**
 * X's own history beyond main is only the PR's own work: every merge commit in main..X merges main-reachable history in
 * (its other parents are all ancestors of main). A PR head that merged ANOTHER branch carries that branch's content,
 * which a merge with X as base could silently drop — such an X is never a candidate (fail closed: set aside instead).
 */
function onlyPrOwnHistory(git, mainSha, sha) {
  const merges = git(['rev-list', '--merges', '--parents', sha, '--not', mainSha]);
  if (merges.status !== 0) return false;
  for (const l of lines(merges)) {
    const [, ...parents] = l.split(' ');
    const offMain = parents.filter((p) => git(['merge-base', '--is-ancestor', p, mainSha]).status !== 0);
    if (offMain.length > 1) return false;
  }
  return true;
}

/**
 * The merged-PR old heads an overlay carries, newest first (a candidate that contains another comes before it).
 * Evidence is never read from commit text: `adoptedHeads` are the `{pr, sha}` this clone's own rebuild state recorded
 * from builds it ADOPTED (state.adoptedHeads), each kept only while its PR reads MERGED, or `proven` entries this same
 * plan already proved; `prForcePushes` are GitHub head_ref_force_pushed `before` commits of merged PRs on main.
 * @returns {Promise<{candidates:Array<{sha:string, pr:number, evidence:string}>, mergedPrs:number[]}>}
 */
export async function mergedPrOldHeads({
  git, mainSha, ovSha, conflictFiles = [], stateOf = async () => null, prForcePushes = null, adoptedHeads = [],
}) {
  const isAnc = (a, b) => git(['merge-base', '--is-ancestor', a, b]).status === 0;
  const keep = (sha) => FULL_SHA_RE.test(sha) && sha !== ovSha && isAnc(sha, ovSha) && !isAnc(sha, mainSha)
    && onlyPrOwnHistory(git, mainSha, sha);
  const found = new Map();
  const add = (sha, pr, evidence) => { if (!found.has(sha) && keep(sha)) found.set(sha, { sha, pr, evidence }); };

  // PRs main merged since the overlay's base whose merge touched a conflicted file (bounded; newest first).
  const conflictSet = new Set(conflictFiles);
  const mergedPrs = [];
  for (const l of lines(git(['log', '--first-parent', '-n', '500', '--format=%H%x09%P%x09%s', mainSha, '--not', ovSha]))) {
    const [sha, parents, ...subject] = l.split('\t');
    const hit = subject.join('\t').match(MERGE_PR_RE);
    const ps = String(parents ?? '').split(' ');
    if (!hit || ps.length !== 2) continue;
    const touched = lines(git(['diff', '--name-only', ps[0], sha]));
    if (conflictSet.size === 0 || touched.some((f) => conflictSet.has(f))) mergedPrs.push(Number(hit[1]));
  }

  // (a) heads of a now-MERGED PR that this clone's own builds adopted (recorded in its rebuild state, never in git text).
  for (const h of Array.isArray(adoptedHeads) ? adoptedHeads : []) {
    const pr = Number(h?.pr);
    if (!Number.isInteger(pr) || pr <= 0 || typeof h?.sha !== 'string' || found.has(h.sha) || !keep(h.sha)) continue;
    if (h.proven === true) { add(h.sha, pr, h.evidence ?? 'proven'); continue; }
    let st = null;
    try { st = await stateOf(pr); } catch { st = null; }
    if (st === 'MERGED') add(h.sha, pr, 'adopted-head');
  }

  // (b) heads GitHub says were force-pushed away from a relevant merged PR.
  if (typeof prForcePushes === 'function') {
    for (const pr of mergedPrs.slice(0, MAX_FORCE_PUSH_READS)) {
      let events = null;
      try { events = await prForcePushes(pr); } catch { events = null; }
      for (const e of Array.isArray(events) ? events : []) if (typeof e?.before === 'string') add(e.before, pr, 'force-pushed');
    }
  }

  const candidates = [...found.values()];
  candidates.sort((a, b) => (isAnc(b.sha, a.sha) ? -1 : isAnc(a.sha, b.sha) ? 1 : 0));
  return { candidates, mergedPrs };
}

/**
 * Merge `ovSha` onto `cur` with a proven merged-PR old head as the merge base. First clean candidate wins.
 * @returns {{ok:true, tree:string, base:{sha:string, pr:number, evidence:string}}|{ok:false}}
 */
export function tryAutoRebase({ git, cur, ovSha, candidates }) {
  const curTree = verifyRev(git, `${cur}^{tree}`);
  for (const c of candidates) {
    const mt = git(['merge-tree', '--write-tree', '--no-messages', `--merge-base=${c.sha}`, cur, ovSha]);
    const tree = String(mt.stdout ?? '').split('\n')[0].trim();
    if (mt.status === 0 && tree && tree !== curTree) return { ok: true, tree, base: c };
  }
  return { ok: false };
}

export const autoRebaseSuffix = (base) => ` (auto-rebased past PR #${base.pr} at ${base.sha})`;
