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
import { execRead } from '../lib/proc-read.mjs';
import { defaultListPrComments } from './parked-pr-conflict-watch.mjs';

/** `gh pr list --json comments` page size; a listed thread this long may be truncated. */
export const LIST_COMMENTS_PAGE_SIZE = 100;

/** Complete, paginated read of one PR's comments; throws ProcReadError on any failed read. */
export function readCompletePrComments(number, { repo = null, exec = execRead } = {}) {
  return defaultListPrComments({ number, repo, exec: (file, args, opts) => exec(file, args, opts) });
}

/**
 * Replace each possibly-truncated `comments` array with the complete thread. PRs whose read fails are dropped
 * (fail closed) and reported through `onError`.
 * @param {Array<object>} prs
 * @param {{repo?:string|null, readComments?:Function, onError?:Function}} [o]
 */
export function enrichPrsWithCompleteComments(prs, {
  repo = null, readComments = readCompletePrComments,
  onError = (pr, e) => console.error(`pr-comments-complete: PR #${pr?.number} comments unreadable, skipped this tick: ${String(e?.message ?? e).split('\n')[0]}`),
} = {}) {
  if (!Array.isArray(prs)) return prs;
  const out = [];
  for (const pr of prs) {
    if (!Array.isArray(pr?.comments) || pr.comments.length < LIST_COMMENTS_PAGE_SIZE) { out.push(pr); continue; }
    try {
      const comments = readComments(pr.number, { repo });
      if (!Array.isArray(comments)) throw new Error('comments read returned no array');
      out.push({ ...pr, comments });
    } catch (e) { onError(pr, e); }
  }
  return out;
}
