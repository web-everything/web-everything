// Synthetic, producer-built threads; these are not captured incident threads.
import { buildNoteComment } from '../../../conveyor/reconcile-note-comment.mjs';
import { buildExhaustedRetryRecoveredComment } from '../../../conveyor/exhausted-retry.mjs';
import { renderRedTeamComment } from '../../../operations/review-extra-seats.mjs';
import { buildVerdictCarriedMarker } from '../../review-verdict-carried-marker.mjs';
import { redTeamGateMarker } from '../../red-team-gate.mjs';

export const A = '1'.repeat(40), B = '2'.repeat(40), C = '3'.repeat(40), D = '4'.repeat(40);
export const trusted = body => ({ body, viewerDidAuthor: true, author: { login: 'web-everything' } });
export const accepted = (sha = A) => trusted(`✅ review — accepted\n<!-- reviewed-sha: ${sha} -->`);
export const note = (kind = 'referral-hold-auto-resolved', text = 'Resolved automatically.', prNumber = 9) =>
  buildNoteComment({ kind, text, prNumber }, { informational: true });
export const recovered = (kind = 'ci-heal-exhausted', headSha = C) => buildExhaustedRetryRecoveredComment({ kind, headSha });
export function envelope(fromSha = B, toSha = C, shown = A, { findings = [], gate = true } = {}) {
  const advisory = renderRedTeamComment({ pr: 9, rev: shown, provider: 'codex', model: 'fixture', findings,
    foldedVerdict: 'accept', recheckStatus: 'ok', findingClasses: {} })
    .replace(`rev=${shown}`, `rev=${toSha}`);
  return [gate ? redTeamGateMarker(9, toSha, 'card-queued', 'a'.repeat(16)) : null,
    buildVerdictCarriedMarker({ fromSha, toSha, patchId: 'f'.repeat(40) }),
    'Review verdict carried across an identical contribution.', advisory].filter(Boolean).join('\n');
}
export const chain = (options = {}) => [accepted(), trusted(envelope(A, B, A, options)), trusted(envelope(B, C, A, options))];
