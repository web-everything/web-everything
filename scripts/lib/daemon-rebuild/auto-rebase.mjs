/** @file scripts/lib/daemon-rebuild/auto-rebase.mjs — rebase an overlay past a PR that merged to main (overlay-rebase-on-merge).
 *
 * Live 2026-10-21 14:57 ET (review clone): #5758 merged to main and the registered overlay containers conflicted with
 * the new main in 7 files. x9diisp then held the WHOLE clone (`established-overlay-hold`). Pinning (overlay-pin) cannot
 * help when MAIN moved: the adopted head conflicts with main too.
 *
 * WHAT IT DOES. When an overlay conflicts with main, look for HARD evidence that the overlay carries an EARLIER head X of
 * a PR that has since merged: X is an ancestor of the overlay tip, not of main, and X is
 *   - a head of that PR this clone itself merged as an overlay (a rebuild-committed `merge overlay <ref> (PR #N)` record
 *     on HEAD or its reflog), or one an earlier auto-rebase recorded (`auto-rebased past PR #N at <X>`), with PR #N MERGED;
 *   - or the `before` commit of a GitHub head_ref_force_pushed event on a PR whose merge commit is on main and whose
 *     merge touched a conflicted file.
 * Then the overlay is merged onto the build with X as the merge base (`git merge-tree --merge-base=X`). That keeps EVERY
 * change the overlay made after X (its own behaviour) and lets main's side win only for what X itself carried — the
 * merged PR's own older content. If no candidate merges cleanly, nothing is resolved: the caller sets the overlay aside.
 * No look-alike evidence (author, subject, patch text) is ever used, and no hunk is ever resolved by picking a side.
 */

import { FULL_SHA_RE, REBUILD_IDENTITY_ENV, verifyRev } from './shared.mjs';

const MERGE_PR_RE = /^Merge pull request #(\d+) from /;
const REBUILD_RECORD_RE = /^daemon-rebuild: merge overlay (\S+) (?:\(PR #(\d+)\) )?onto /;
const REBASED_RE = / \(auto-rebased past PR #(\d+) at ([0-9a-f]{40})\)/;
/** How many relevant merged PRs' force-push histories one overlay may read (each is a GitHub call). */
const MAX_FORCE_PUSH_READS = 5;

const lines = (r) => (r.status === 0 ? String(r.stdout ?? '').split('\n').filter((l) => l.trim()) : []);

/**
 * The merged-PR old heads an overlay carries, newest first (a candidate that contains another comes before it).
 * @returns {Promise<{candidates:Array<{sha:string, pr:number, evidence:string}>, mergedPrs:number[]}>}
 */
export async function mergedPrOldHeads({
  git, mainSha, ovSha, headSha = null, conflictFiles = [], stateOf = async () => null, prForcePushes = null,
}) {
  const isAnc = (a, b) => git(['merge-base', '--is-ancestor', a, b]).status === 0;
  const keep = (sha) => FULL_SHA_RE.test(sha) && sha !== ovSha && isAnc(sha, ovSha) && !isAnc(sha, mainSha);
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

  // (a) heads this clone merged itself (or recorded at an earlier auto-rebase), for a PR that is now MERGED.
  const builds = [...new Set([headSha, ...lines(git(['reflog', '-n', '50', '--format=%H', 'HEAD']))].filter((s) => s && FULL_SHA_RE.test(s)))];
  const recorded = [];
  for (const b of builds) {
    for (const l of lines(git(['log', '--first-parent', '-n', '200', '--format=%P%x09%ce%x09%s', b, '--not', mainSha]))) {
      const [parents, committer, ...rest] = l.split('\t');
      const subject = rest.join('\t');
      const ps = String(parents ?? '').split(' ');
      if (committer !== REBUILD_IDENTITY_ENV.GIT_COMMITTER_EMAIL || ps.length !== 2) continue;
      const rb = subject.match(REBASED_RE);
      if (rb) recorded.push({ sha: rb[2], pr: Number(rb[1]), evidence: 'recorded-auto-rebase' });
      const hit = subject.match(REBUILD_RECORD_RE);
      if (hit?.[2] != null && FULL_SHA_RE.test(ps[1])) recorded.push({ sha: ps[1], pr: Number(hit[2]), evidence: 'adopted-head' });
    }
  }
  for (const r of recorded) {
    if (found.has(r.sha) || !keep(r.sha)) continue;
    let st = null;
    try { st = await stateOf(r.pr); } catch { st = null; }
    if (st === 'MERGED') add(r.sha, r.pr, r.evidence);
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
