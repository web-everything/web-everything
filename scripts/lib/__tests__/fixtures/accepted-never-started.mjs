// Synthetic, producer-built threads; these are not captured incident threads.
import { buildNoteComment } from '../../../conveyor/reconcile-note-comment.mjs';
import { buildExhaustedRetryRecoveredComment } from '../../../conveyor/exhausted-retry.mjs';
import { renderRedTeamComment } from '../../../operations/review-extra-seats.mjs';
import { buildVerdictCarriedMarker } from '../../review-verdict-carried-marker.mjs';
import { redTeamGateMarker } from '../../red-team-gate.mjs';
import { planReconcile } from '../../../conveyor/reconcile-core.mjs';

export const A = '1'.repeat(40), B = '2'.repeat(40), C = '3'.repeat(40), D = '4'.repeat(40);
export const trusted = body => ({ body, viewerDidAuthor: true, author: { login: 'web-everything' } });
export const accepted = (sha = A) => trusted(`✅ review — accepted\n<!-- reviewed-sha: ${sha} -->`);
// Synthetic full SHAs with the incident prefixes; these are not saved live threads.
export const REFERRAL_HEAD = `2ca4275da${'a'.repeat(31)}`;
export const OTHER_REFERRAL_HEAD = `c045bba8f${'b'.repeat(31)}`;
export function producedNote(kind, { head = REFERRAL_HEAD, prNumber = 9, counts = null, human = false,
  reason = 'log-unreadable' } = {}) {
  const why = counts
    ? `every referral finding on head ${head.slice(0, 9)} is ruled (${Object.entries(counts).map(([key, n]) => `${n} ${key}`).join(', ')}); no ruling is owed`
    : `no referral finding exists on head ${head.slice(0, 9)}; no ruling is owed`;
  const pr = { number: prNumber, headRefOid: head, state: 'OPEN', isDraft: true, headRefName: 'lane/fixture',
    labels: human ? ['review:human'] : [], comments: [], aheadByOnMain: 0,
    ...(kind === 'referral-hold-auto-resolved' ? {
      referralHold: { kind: 'same-head', head, count: 1, attemptsSinceWake: 1 },
      referralHoldAutoResolve: { outcome: 'resume', head, why, ...(counts ? { counts } : {}) },
      statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    } : {
      timeoutRetry: { eligible: false, reason },
      timeoutRetryBudget: { confirmed: 0, rejected: 0 },
      statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE',
        completedAt: '2026-11-27T11:00:00Z', detailsUrl: 'https://github.com/fixture/repo/actions/runs/1/job/2' }],
    }) };
  const plan = planReconcile({ repo: 'we', prs: [pr], agents: [], now: Date.parse('2026-11-27T12:00:00Z'),
    requiredChecks: ['test'], reviewTiming: { startAfter: 'ci-green' }, fixTiming: { joinCiAndReview: false },
    ciHealBudget: { cap: 3, resetOnFixHead: false }, ciHealBudgetRestore: {}, verdictSettings: {}, codeqlOwnBudget: {},
    operatorRulingExtraRounds: { value: 0 }, roundExtensionAnchor: { value: 'fixture' }, reviewLabelHeal: 'off',
    shadowDeps: { mode: 'off', now: () => Date.parse('2026-11-27T12:00:00Z') } });
  const output = plan.notes.find(n => n.kind === kind);
  if (!output) throw Error(`fixture producer did not emit ${kind}`);
  return output;
}
// A timeout note can follow any accepted head; referral fixtures supply their head explicitly.
export const note = (kind = 'timeout-retry-fallback-heal', text, prNumber = 9) =>
  buildNoteComment({ kind, text: text ?? producedNote(kind === 'referral-hold-auto-resolved' ? kind : 'timeout-retry-fallback-heal', { prNumber }).text,
    prNumber }, { informational: true });
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
