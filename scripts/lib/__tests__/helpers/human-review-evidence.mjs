import { redTeamMarker } from '../../red-team-gate.mjs';

/** Upgrade historical advisory fixtures with separate, current-head red-team evidence. */
export function withHumanReviewEvidence(pr) {
  return { ...pr,
    labels: [...(pr.labels ?? []), { name: 'red-team:clear' }],
    comments: [{ author: { login: 'web-everything' }, createdAt: '2026-01-01T00:00:00Z',
      body: `${redTeamMarker(pr.number, pr.headRefOid)}\n### Post-accept red team — no break found\n\nrecorded verdict \`accepted\`.` }, ...(pr.comments ?? [])],
  };
}
