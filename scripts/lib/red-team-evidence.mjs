/** Shared red-team evidence readers for reconciliation and the seat runner, without runner dependencies. */
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';
import { REVIEW_SEAT_DISPATCH_KIND } from './provider-routing.mjs';
import { redTeamMarker } from './red-team-gate.mjs';

export const RED_TEAM_SEAT = Object.freeze({ seat: 'red-team', lens: 'red-team', key: 'red-team' });

/** Did a TRUSTED principal already post this head's red-team comment? A marker from any other login never counts. PURE. */
export function redTeamCommentPosted(comments, pr, rev) {
  const marker = redTeamMarker(pr, rev);
  return (Array.isArray(comments) ? comments : []).some((c) => {
    const body = typeof c === 'string' ? c : c?.body;
    return typeof body === 'string' && body.trimStart().startsWith(marker) && isTrustedMarkerAuthor(c);
  });
}

/** The latest red-team seat row that ran cleanly for this `(pr, head)`, or null. PURE. */
export function priorRedTeamRow(records, pr, rev) {
  return (Array.isArray(records) ? records : []).filter((r) => r && r.dispatchKind === REVIEW_SEAT_DISPATCH_KIND
    && r.seat === RED_TEAM_SEAT.seat && r.pr === Number(pr) && r.rev === rev && r.status === 'ok').at(-1) ?? null;
}
