// Synthetic, producer-checked threads; these are not captured incident threads.
import { buildNoteComment } from '../../../conveyor/reconcile-note-comment.mjs';
import { buildExhaustedRetryRecoveredComment } from '../../../conveyor/exhausted-retry-recovered-comment.mjs';
import { buildVerdictCarriedMarker } from '../../review-verdict-carried-marker.mjs';
import { redTeamGateMarker } from '../../red-team-gate.mjs';

export const A = '1'.repeat(40), B = '2'.repeat(40), C = '3'.repeat(40), D = '4'.repeat(40);
export const trusted = body => ({ body, viewerDidAuthor: true, author: { login: 'web-everything' } });
export const accepted = (sha = A) => trusted(`✅ review — accepted\n<!-- reviewed-sha: ${sha} -->`);
export const note = (kind = 'referral-hold-auto-resolved', text, prNumber = 9) => {
  text ??= kind === 'timeout-retry-fallback-heal' ? `PR #${prNumber}: timeout retry ineligible (log-unreadable); falling back to ordinary ci-heal (1 of 3 attempts spent)` : `referral hold auto-resolved — no referral finding exists on head ${A.slice(0, 9)}; no ruling is owed; the head's one finished review is resumed once`;
  return buildNoteComment({ kind, text, prNumber }, { informational: true });
};
export const recovered = (kind = 'ci-heal-exhausted', headSha = C) => buildExhaustedRetryRecoveredComment({ kind, headSha });
// Pin the empty producer output in accept-carry-forward.test.mjs. Importing the
// review-seat runner here adds hundreds of modules to every consumer's worker.
export const emptyAdvisoryFixture = rev => `<!-- we:red-team-advisory pr=9 rev=${rev} -->
### Post-accept red team — no break found

Advisory only: this comment changes no label itself; the red-team gate (setting \`redTeam.confirmedBreaks\`) sends a confirmed broken break back to the fixer. Head \`${rev.slice(0, 12)}\` · red team codex/fixture · recorded verdict \`accept\`.

The red team tried to break this change and reported nothing.`;

export function envelope(fromSha = B, toSha = C, shown = A, { findings = [], gate = true, renderAdvisory } = {}) {
  if (findings.length && !renderAdvisory) throw Error('findings fixtures require the real advisory producer');
  const advisory = (renderAdvisory ? renderAdvisory({ pr: 9, rev: shown, provider: 'codex', model: 'fixture', findings,
    foldedVerdict: 'accept', recheckStatus: 'ok', findingClasses: {} }) : emptyAdvisoryFixture(shown))
    .replace(`rev=${shown}`, `rev=${toSha}`);
  return [gate ? redTeamGateMarker(9, toSha, 'card-queued', 'a'.repeat(16)) : null,
    buildVerdictCarriedMarker({ fromSha, toSha, patchId: 'f'.repeat(40) }),
    'Review verdict carried across an identical contribution.', advisory].filter(Boolean).join('\n');
}
export const chain = (options = {}) => [accepted(), trusted(envelope(A, B, A, options)), trusted(envelope(B, C, A, options))];
