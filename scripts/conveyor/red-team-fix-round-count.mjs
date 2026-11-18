import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { redTeamFact } from './dispatch-eligibility-facts.mjs';

// Separate from rearm/conflict markers: counted before the repair executor starts.
export const RED_TEAM_FIX_COMMENT_MARKER = '<!-- conveyor-red-team-sent-back-fix-round -->';

/** Durable repair launches across the PR's history; moving the head must not reset the cap. */
export function countRedTeamFixComments(comments) {
  if (!Array.isArray(comments)) return 0;
  return comments.filter(c => isTrustedMarkerAuthor(c)
    && typeof c?.body === 'string'
    && c.body.trimStart().split('\n')[0].trimEnd() === RED_TEAM_FIX_COMMENT_MARKER).length;
}

/** One receipt per launch, including failed/no-change repairs and all executor fallbacks within it. */
export function publishRedTeamFixLaunch({ comments, pr, head, attemptId, publish }) {
  const result = redTeamFact(comments, pr, head)?.value;
  if (result?.state !== 'send-back' || !/^[\w-]{1,128}(?![\s\S])/.test(String(attemptId ?? ''))) {
    throw new Error('red-team repair dispatch evidence unreadable; retry with a fresh reconciliation or ask an operator');
  }
  const body = `${RED_TEAM_FIX_COMMENT_MARKER}\n\nRed-team repair dispatched: head=${head} result=${result.resultId} attempt=${attemptId}`;
  if (comments.some(c => isTrustedMarkerAuthor(c) && c.body === body)) return false;
  publish(body); // Publication failure must prevent execution.
  return true;
}
