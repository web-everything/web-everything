/**
 * @file pr-comments-complete.mjs — complete PR comment threads for the conveyor's open-PR snapshots.
 *
 * `gh pr list --json comments` returns only the first page (100) of each PR's comments. Every durable marker
 * counter (operator round-extension grants, note-episode dedup, rearm counts) reads that array, so on a long
 * thread the newest comments — exactly where a fresh grant or an earlier note lives — were invisible: the cap
 * ignored the grants and the "needs your decision" note was re-posted every tick (#4017).
 *
 * A PR whose listed comments reach the page size is re-read through the complete paginated REST reader, with
 * the safe process reader (no 1 MiB default buffer). A failed read NEVER yields an empty or partial thread:
 * the PR is left out of this tick's snapshot, so nothing is decided (or posted) on a view that may miss grants.
 */
import { readFixLoopRows, fixLoopConfig, fixLoopRedMainLapse } from './fix-loop-ledger.mjs';
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';
import { annotateLapsedStandDowns, standDownComments, standDownHead, standDownHeadChangeAt, resolveStandDownHoldsAcrossHeads, STAND_DOWN_MARKER } from './stand-down.mjs';
import { execRead } from '../lib/proc-read.mjs';
import { defaultListPrComments } from './pr-comments-list.mjs'; // the leaf — parked-pr-conflict-watch would close an import cycle via rearm-review

/** `gh pr list --json comments` page size; a listed thread this long may be truncated. */
export const LIST_COMMENTS_PAGE_SIZE = 100;

/** Complete, paginated read of one PR's comments; throws ProcReadError on any failed read. */
export function readCompletePrComments(number, { repo = null, exec = execRead } = {}) {
  return defaultListPrComments({ number, repo, exec: (file, args, opts) => exec(file, args, opts) });
}

/** Complete edit history metadata: REST updated_at cannot prove a comment was never edited. Throws on any
 * failed, malformed or incomplete GraphQL page, so callers never trust a partial thread. */
export function readCompletePrCommentEditHistory(number, { repo, exec = execRead } = {}) {
  const [owner, name] = String(repo ?? '').split('/');
  if (!owner || !name) throw new Error('comment edit history requires an explicit repository');
  const query = `query($owner:String!,$name:String!,$n:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$n){comments(first:100,after:$cursor){nodes{id lastEditedAt} pageInfo{hasNextPage endCursor}}}}}`;
  const comments = [];
  const cursors = new Set();
  let cursor;
  for (;;) {
    const args = ['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `n=${number}`,
      ...(cursor ? ['-f', `cursor=${cursor}`] : [])];
    const page = JSON.parse(String(exec('gh', args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
    })));
    const connection = page?.data?.repository?.pullRequest?.comments;
    const info = connection?.pageInfo;
    if (page?.errors?.length || !Array.isArray(connection?.nodes) || typeof info?.hasNextPage !== 'boolean'
      || connection.nodes.some((c) => typeof c?.id !== 'string' || !(c.lastEditedAt === null || typeof c.lastEditedAt === 'string'))) {
      throw new Error('comment edit history returned an invalid page');
    }
    comments.push(...connection.nodes);
    if (!info.hasNextPage) return comments;
    if (typeof info.endCursor !== 'string' || !info.endCursor || cursors.has(info.endCursor)) {
      throw new Error('comment edit history pagination did not advance');
    }
    cursor = info.endCursor;
    cursors.add(cursor);
  }
}

/** Read commits per PR only for a legacy unbound hold. A matching current-head commit date proves a later head. */
export function enrichStandDownHeadChange(pr, { repo = null, exec = execRead } = {}) {
  if (!/^[0-9a-f]{7,40}$/i.test(pr?.headRefOid ?? '') || standDownHeadChangeAt(pr)
    || !standDownComments(pr?.comments).some(c => !standDownHead(c.body) && Number.isFinite(Date.parse(c.createdAt)))
    || resolveStandDownHoldsAcrossHeads().value) return pr;
  try {
    const args = ['pr', 'view', String(pr.number), '--json', 'commits'];
    if (repo) args.push('--repo', repo);
    const { commits } = JSON.parse(exec('gh', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }));
    return Array.isArray(commits) ? { ...pr, commits } : pr;
  } catch { return pr; } // Missing evidence leaves the operator's question visible.
}

/**
 * Replace each possibly-truncated `comments` array with the complete thread. PRs whose read fails are dropped
 * (fail closed) and reported through `onError`. Annotate head-bound lapses on every returned PR.
 * @param {Array<object>} prs
 * @param {{repo?:string|null, readComments?:Function, annotate?:Function, readRows?:Function, readConfig?:Function, onError?:Function}} [o]
 */
export function enrichPrsWithCompleteComments(prs, {
  repo = null, readComments = readCompletePrComments, annotate = null, readRows = readFixLoopRows, readConfig = fixLoopConfig,
  onError = (pr, e) => console.error(`pr-comments-complete: PR #${pr?.number} comments unreadable, skipped this tick: ${String(e?.message ?? e).split('\n')[0]}`),
} = {}) {
  if (!Array.isArray(prs)) return prs;
  let context, contextRead = false;
  const annotatePr = annotate ?? (pr => {
    if (!contextRead && pr?.comments?.some(c => (typeof c === 'string' ? c : c?.body)?.trimStart().startsWith(STAND_DOWN_MARKER))) {
      contextRead = true;
      try { context = { rows: readRows(), config: readConfig(), repo: repoKeyForSlug(repo) }; }
      catch { context = null; }
    }
    return annotateLapsedStandDowns(enrichStandDownHeadChange(pr, { repo }), context ? {
      redMainLapse: head => fixLoopRedMainLapse({ ...context, pr: pr.number, head }),
    } : {});
  });
  const out = [];
  for (const pr of prs) {
    if (!Array.isArray(pr?.comments) || pr.comments.length < LIST_COMMENTS_PAGE_SIZE) { out.push(annotatePr(pr)); continue; }
    try {
      const comments = readComments(pr.number, { repo });
      if (!Array.isArray(comments)) throw new Error('comments read returned no array');
      if (comments.length < pr.comments.length) throw new Error('complete comments read returned fewer comments than the listed page');
      const ids = c => [c?.node_id, c?.id, c?.url, c?.html_url].filter(v => v !== undefined && v !== null && v !== '');
      const covered = pr.comments.every(c => comments.some(full => {
        if (typeof c?.body !== 'string' || c.body !== full?.body) return false;
        const embeddedIds = ids(c), fullIds = ids(full);
        if (embeddedIds.length && fullIds.length) return embeddedIds.some(id => fullIds.includes(id));
        return (c.createdAt ?? c.created_at) === (full.createdAt ?? full.created_at);
      }));
      if (!covered) throw new Error('complete comments read did not cover the listed page');
      if (comments.length === pr.comments.length && comments.length === LIST_COMMENTS_PAGE_SIZE) {
        throw new Error('thread may be truncated at the page size — retry with a complete paginated thread');
      }
      // The covering read extends beyond a full first page, proving pagination advanced. The planner trusts
      // `commentsComplete` before counting markers (`takeover-budget.mjs#threadMayBeTruncated`).
      out.push(annotatePr({ ...pr, comments, commentsComplete: true }));
    } catch (e) { onError(pr, e); }
  }
  return out;
}
