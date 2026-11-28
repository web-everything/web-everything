/** @file Leaf module: render and post the durable requires-review PR mark.
 * Kept free of the PR-thread readers on purpose: `fix-slot-borrow` (in `fix-executor-chain`'s static graph) posts the mark,
 * and importing the thread reader from there closes an import cycle back to `ai-routing` (`FIX_EXECUTOR_RUNGS` read before
 * it is initialised). The reader side lives in `fix-review-floor.mjs`, which re-exports everything here.
 */
import { execFileSyncThrottled } from './gh-throttle.mjs';
import { ghRepoSlug } from './constellation-repos.mjs';

export const REQUIRES_REVIEW_MARK = '<!-- dispatch requires-review: true -->';
export const renderRequiresReviewMark = ({ kind, rung }) => [
  'conveyor requires-review — a critical repair was routed to this PR', '',
  `This ${kind} repair (rung \`${rung ?? 'default'}\`) was routed **requiresReview**: every later review dispatched on this PR uses the Opus reviewer.`,
  REQUIRES_REVIEW_MARK].join('\n');
export function postRequiresReviewMark({ repo, pr, kind, rung, exec = execFileSyncThrottled }) {
  exec('gh', ['pr', 'comment', String(pr), '--repo', ghRepoSlug(repo), '--body', renderRequiresReviewMark({ kind, rung })],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 1024 * 1024 });
}
