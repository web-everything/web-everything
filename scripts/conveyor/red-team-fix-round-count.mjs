import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';

// Separate from rearm/conflict markers: this repair preserves the accepted review.
export const RED_TEAM_FIX_COMMENT_MARKER = '<!-- conveyor-red-team-sent-back-fix-round -->';

/** Durable completed repairs across the PR's history; moving the head must not reset the cap. */
export function countRedTeamFixComments(comments) {
  if (!Array.isArray(comments)) return 0;
  return comments.filter(c => isTrustedMarkerAuthor(c)
    && typeof c?.body === 'string'
    && c.body.trimStart().split('\n')[0].trimEnd() === RED_TEAM_FIX_COMMENT_MARKER).length;
}
