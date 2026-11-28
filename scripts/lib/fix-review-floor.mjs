/** @file Durable critical-fix reviewer floor.
 * THE RULE: Before a requiresReview fix launches or resumes, a trusted PR mark is posted or launch is refused; every review whose thread read finds it uses Opus, and unreadable/incomplete threads count as marked. A later mark is seen by the next dispatch.
 * Ruling 3: Trusted whole-line marks are sticky for the PR lifetime, independent of order.
 * Ruling 5: Read failures only raise the reviewer tier; panel rigor and dispatch admission are unchanged.
 * Ruling 7: Read-to-spawn serialization and drain acceptance carry are follow-ups, outside this guarantee.
 */
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';
import { readCompletePrComments } from '../conveyor/pr-comments-complete.mjs';
import { REQUIRES_REVIEW_MARK } from './fix-review-mark.mjs';
// The mark renderer/poster is a leaf (fix-review-mark.mjs) so fix-slot-borrow never imports the thread reader (import cycle).
export { REQUIRES_REVIEW_MARK, renderRequiresReviewMark, postRequiresReviewMark } from './fix-review-mark.mjs';
export function threadRequiresReview(comments) {
  if (!Array.isArray(comments)) return true;
  return comments.some(c => isTrustedMarkerAuthor(c) && typeof c?.body === 'string'
    && c.body.split(/\r?\n/).some(line => line.trim() === REQUIRES_REVIEW_MARK));
}
export function reviewCareFloor(readThread, { repo, pr }) {
  if (typeof readThread !== 'function') return true;
  try { return threadRequiresReview(readThread({ repo, pr })); } catch { return true; }
}
export const completeThreadReader = exec => ({ repo, pr }) => readCompletePrComments(Number(pr), { repo, ...(exec ? { exec } : {}) });
