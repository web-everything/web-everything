/**
 * @file Decide which prototype registrations can retire on their own.
 * WHY (incident 2026-11-01, R310): the review and health-watch daemons froze for ~3h and ~9h on
 * `pinned-overlay-conflict`. A superseded registration (#6056's `lane/unblock-dead-redteam-redispatch-m*`,
 * replaced by merged #6132) and old combined tops conflicted with main. prototype-load registers with no
 * `--pr`, so the rebuild's own `pr-merged` cleanup never saw them, and nothing else could drop them.
 *
 * A registration retires only on git-proved evidence:
 *   - `in-main` / `pr-merged`: merging it onto main changes nothing (exact tree compare, so any history shape:
 *     merged, squash-merged, or a loader `-m<N>` merge ref of a merged branch).
 *   - `superseded`: its PR is CLOSED unmerged, a MERGED PR of the same repository, merged into main and reachable
 *     from main, cross-references it and says `Supersedes #N` in its body, and every non-merge commit the
 *     registration carries beyond main is one of that closed PR's own commits (merges must be clean or the PR's own).
 *     Those commits are not on main, but the merged superseder replaced them on main: that is the declared exception.
 * A flag-pinned registration of a CLOSED PR is kept (as in the rebuild), and so is one with an approved edge
 * resolution. Anything else is kept. A registration with unique commits that are not on main and not replaced on main is
 * never dropped. An unreadable git or GitHub answer keeps it too.
 * All IO is injected: `git(args)` and `gh(args)` return `{ code, stdout }`.
 */

const SHA = /^[a-f0-9]{40}$/;
const lines = (text) => String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

/** Supersession line in a merged PR body: `Supersedes #N`, optionally among other numbers on the same line. */
export function declaresSupersedes(body, pr) {
  if (!Number.isInteger(pr)) return false;
  return new RegExp(String.raw`^[\s>*_-]*supersedes\b:?[^\n]*#${pr}(?!\d)`, 'im').test(String(body || ''));
}

/** The branch a loader merge ref (`<branch>-m<N>`) was built from, or null. */
export function mergeRefBase(ref) {
  const match = /^(.+)-m\d+$/.exec(ref || '');
  return match ? match[1] : null;
}

/**
 * What the registration carries beyond `mainRef`, proved with git.
 * @returns {{ok:boolean, tip?:string, unique?:string[], merges?:string[], uncleanMerges?:string[], cleanMerges?:boolean,
 *   contentInMain?:boolean, reason?:string}}
 */
export function carriedBeyondMain({ git, ref, mainRef = 'origin/main' }) {
  const tipRes = git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${ref}^{commit}`]);
  const tip = String(tipRes.stdout || '').trim();
  if (tipRes.code !== 0 || !SHA.test(tip)) return { ok: false, reason: 'tip-unresolved' };
  const mainTreeRes = git(['rev-parse', '--verify', `${mainRef}^{tree}`]);
  const mainTree = String(mainTreeRes.stdout || '').trim();
  if (mainTreeRes.code !== 0 || !SHA.test(mainTree)) return { ok: false, reason: 'main-unresolved' };
  // Every non-merge commit not reachable from main. Patch equivalence is not used: patch ids ignore whitespace,
  // even inside string literals, so an "equivalent" commit can still differ from what main has.
  const uniqueRes = git(['rev-list', '--no-merges', `${mainRef}..${tip}`]);
  const mergesRes = git(['rev-list', '--merges', `${mainRef}..${tip}`]);
  if (uniqueRes.code !== 0 || mergesRes.code !== 0) return { ok: false, reason: 'history-unreadable' };
  const unique = lines(uniqueRes.stdout);
  const merges = lines(mergesRes.stdout);
  if (![...unique, ...merges].every((sha) => SHA.test(sha))) return { ok: false, reason: 'history-unreadable' };
  // A merge counts as carrying nothing of its own only when git recomputes the same tree from its parents.
  const uncleanMerges = merges.filter((merge) => {
    const parents = lines(git(['rev-list', '--parents', '-n', '1', merge]).stdout)[0]?.split(/\s+/).slice(1) || [];
    if (parents.length !== 2) return true;
    const recomputed = git(['merge-tree', '--write-tree', '--no-messages', parents[0], parents[1]]);
    const actual = git(['rev-parse', '--verify', `${merge}^{tree}`]);
    return recomputed.code !== 0 || actual.code !== 0 || lines(recomputed.stdout)[0] !== String(actual.stdout || '').trim();
  });
  const cleanMerges = uncleanMerges.length === 0;
  const onto = git(['merge-tree', '--write-tree', '--no-messages', mainRef, tip]);
  const contentInMain = onto.code === 0 && lines(onto.stdout)[0] === mainTree;
  return { ok: true, tip, unique, merges, uncleanMerges, cleanMerges, contentInMain };
}

function ghJson(gh, args) {
  const result = gh(args);
  if (result.code !== 0) return { ok: false };
  try { return { ok: true, value: JSON.parse(String(result.stdout || 'null')) }; } catch { return { ok: false }; }
}

/** The registration's PR: its recorded number, else a PR whose head is the ref, else (for `-m<N>`) its base branch. */
function findPr({ gh, row }) {
  if (Number.isInteger(row.pr)) {
    const view = ghJson(gh, ['pr', 'view', String(row.pr), '--json', 'number,state,headRefName']);
    return view.ok && view.value ? { ok: true, pr: view.value, via: 'registration' } : { ok: false };
  }
  for (const [head, via] of [[row.ref, 'head'], [mergeRefBase(row.ref), 'merge-ref-base']]) {
    if (!head) continue;
    const list = ghJson(gh, ['pr', 'list', '--head', head, '--state', 'all', '--json', 'number,state,headRefName', '--limit', '5']);
    if (!list.ok || !Array.isArray(list.value)) return { ok: false };
    const exact = list.value.filter((pr) => pr?.headRefName === head);
    if (exact.length > 1) return { ok: false, ambiguous: true };
    if (exact.length === 1) return { ok: true, pr: exact[0], via };
  }
  return { ok: true, pr: null };
}

/** A MERGED PR of this repo, merged into main and on `mainRef`, that cross-references `pr` and says `Supersedes #pr`. */
function findSuperseder({ gh, git, pr, repo, mainRef }) {
  const [owner, name] = String(repo || '').split('/');
  if (!owner || !name) return { ok: false };
  const query = 'query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){'
    + 'timelineItems(itemTypes:[CROSS_REFERENCED_EVENT],first:100){nodes{... on CrossReferencedEvent{source{'
    + '... on PullRequest{number merged body baseRefName repository{nameWithOwner} mergeCommit{oid}}}}}}}}}';
  const refs = ghJson(gh, ['api', 'graphql', '-f', `query=${query}`, '-F', `o=${owner}`, '-F', `r=${name}`, '-F', `n=${pr}`]);
  const nodes = refs.ok ? refs.value?.data?.repository?.pullRequest?.timelineItems?.nodes : null;
  if (!Array.isArray(nodes)) return { ok: false };
  const mainBranch = mainRef.replace(/^origin\//, '');
  const hit = nodes.map((node) => node?.source).find((src) => src?.merged === true && Number.isInteger(src.number)
    && src.number !== pr && declaresSupersedes(src.body, pr)
    // `#N` in another repository's PR names that repository's PR N, not this one.
    && String(src.repository?.nameWithOwner || '').toLowerCase() === String(repo).toLowerCase()
    && src.baseRefName === mainBranch && SHA.test(src.mergeCommit?.oid || '')
    // The replacement must actually be on the main this registration is compared against.
    && git(['merge-base', '--is-ancestor', src.mergeCommit.oid, mainRef]).code === 0);
  return { ok: true, supersededBy: hit ? hit.number : null, ...(hit ? { mergeCommit: hit.mergeCommit.oid } : {}) };
}

/** The commit shas of `pr`, or null when unreadable. */
function prCommits({ gh, pr }) {
  const view = ghJson(gh, ['pr', 'view', String(pr), '--json', 'commits']);
  const commits = view.ok && Array.isArray(view.value?.commits) ? view.value.commits.map((c) => c?.oid) : null;
  return commits && commits.every((sha) => SHA.test(sha || '')) ? new Set(commits) : null;
}

/**
 * Decide, per registration, whether it retires. Never mutates anything.
 * @param {{rows:Array<{ref:string, pr?:number|null}>, git:Function, gh:Function, repo:string, mainRef?:string}} o
 * @returns {Array<{ref:string, action:'retire'|'keep', reason:string, tip?:string, pr?:number|null, evidence?:object}>}
 */
export function planRetirements({ rows, git, gh, repo, mainRef = 'origin/main' }) {
  return rows.map((row) => {
    const keep = (reason, extra = {}) => ({ ref: row.ref, action: 'keep', reason, ...extra });
    const carried = carriedBeyondMain({ git, ref: row.ref, mainRef });
    if (!carried.ok) return keep(carried.reason);
    const { tip } = carried;
    const evidence = { unique: carried.unique.length, merges: carried.merges.length, cleanMerges: carried.cleanMerges,
      contentInMain: carried.contentInMain };
    const found = findPr({ gh, row });
    if (!found.ok) return keep(found.ambiguous ? 'pr-ambiguous' : 'pr-state-unknown', { tip, evidence });
    const pr = found.pr;
    const prNumber = pr ? pr.number : null;
    // An open PR may still receive commits that belong on the prototype.
    if (pr && pr.state === 'OPEN') return keep('pr-open', { tip, pr: prNumber, evidence });
    // Same rule as the rebuild (plan.mjs refuses a CLOSED PR with `pinned:true` before anything else).
    if (pr?.state === 'CLOSED' && row.pinned === true) return keep('pinned-closed-pr', { tip, pr: prNumber, evidence });
    // An approved edge resolution can carry conflict-resolution commits that neither the ref nor main has.
    if (row.edgeResolution) return keep('edge-resolution-recorded', { tip, pr: prNumber, evidence });
    // On main = merging it onto main changes nothing (exact trees, any history shape).
    if (carried.contentInMain) {
      return { ref: row.ref, action: 'retire', reason: pr?.state === 'MERGED' ? 'pr-merged' : 'in-main', tip, pr: prNumber,
        evidence: { ...evidence, ...(pr ? { prVia: found.via, prState: pr.state } : {}) } };
    }
    if (pr?.state === 'CLOSED') {
      const sup = findSuperseder({ gh, git, pr: prNumber, repo, mainRef });
      if (!sup.ok) return keep('superseder-unknown', { tip, pr: prNumber, evidence });
      if (sup.supersededBy == null) return keep('unique-commits-not-on-main', { tip, pr: prNumber, evidence });
      const own = prCommits({ gh, pr: prNumber });
      if (!own) return keep('pr-commits-unknown', { tip, pr: prNumber, evidence });
      // The closed PR's own commits (merges included) are what the superseder replaced. Anything else must be a
      // clean merge, or the registration carries work that nothing on main replaced.
      const foreign = [...carried.unique, ...carried.uncleanMerges].filter((sha) => !own.has(sha));
      if (foreign.length) {
        return keep('carries-more-than-superseded-pr', { tip, pr: prNumber, evidence: { ...evidence, foreign: foreign.slice(0, 10) } });
      }
      return { ref: row.ref, action: 'retire', reason: 'superseded', tip, pr: prNumber,
        evidence: { ...evidence, prVia: found.via, supersededBy: sup.supersededBy, supersederCommit: sup.mergeCommit } };
    }
    return keep('unique-commits-not-on-main', { tip, pr: prNumber, evidence });
  });
}
