/** Read-only live-state evaluation shared by the label writer and outcome observer. */
import { decideSetLabel, assertMandatoryReferralsCleared } from '../review-set-label.mjs';
import { classifyPrLiveness, inertPrMessage } from './pr-liveness.mjs';
import { currentActorId, parseAuthorActorId, decideClearerIndependence, hasStampLostMarker } from './review-independence.mjs';
import { hasReviewLabel } from './review-escalation.mjs';

export function reviewSetLabelPreflight({ state, repo, pr, to, expectedHead,
  clearerId = currentActorId(), referralOptions = {}, decisionOptions = {},
} = {}) {
  const refuse = reason => { throw new Error(reason); };
  if (expectedHead !== undefined && state?.headRefOid !== expectedHead) refuse('live head differs from --expect-head');
  const stampsAcceptance = ['accepted', 'restamp', 'clear-human'].includes(to);
  const referralCarry = stampsAcceptance
    ? assertMandatoryReferralsCleared(state, { repo, pr, ...referralOptions })?.carry ?? null : null;
  const liveness = classifyPrLiveness({ state: state?.state });
  if (liveness.outcome !== 'reviewable') refuse(inertPrMessage({ pr, state: liveness.state }));
  const independence = (stampsAcceptance && to !== 'restamp')
    // #3067 WIRED HERE — the module's own header named this as the owed follow-up: the pure decider grew
    // `prCreatedAt` and `stampLostMarked` as OPT-IN inputs, and until a live caller passed them a stripped
    // stamp stayed indistinguishable from an absent one. Both are supplied now, so a post-regime PR with no
    // stamp resolves to STAMP_LOST instead of UNKNOWN_AUTHOR; neither proves independence.
    ? decideClearerIndependence({
      authorId: parseAuthorActorId(state.body),
      clearerId,
      prCreatedAt: state.createdAt,
      stampLostMarked: hasStampLostMarker(state.body),
    })
    : null;
  if (to === 'accepted' && independence && independence.independent === false) {
    // THE MESSAGE NAMES ONLY ROUTES THAT ACTUALLY WORK (PR #1100 review). The first cut inherited the decider's
    // "…or let a human clear it", which pointed at a door this same refusal had shut. There is deliberately NO
    // `--force` and no flag on this command: an agent recording an accept on its own session's PR is not an
    // independent review, and #2844 exists to stop that record being written as if it were.
    refuse(
      `${independence.reason} — nothing was changed (#2844). TWO ROUTES ACTUALLY CLEAR THIS PR, and neither is a `
      + 'flag on this command. (1) THE HUMAN CEREMONY: if the PR carries review:human, re-run with '
      + '--to=clear-human --actor=<name> --reason="<the operator instruction authorising it>" — that target is '
      + 'EXEMPT from this refusal and the durable comment records the clearance as a human ceremony; it is itself '
      + 'refused when the PR does NOT carry review:human. (2) A DIFFERENT SESSION: run the review, and this '
      + 'command, from a session that did not open the PR — its own session id is then the clearing actor and the '
      + 'independence bar is genuinely met. There is no --force.',
    );
  }

  const decision = decideSetLabel({ ...decisionOptions, to, currentLabels: state.labels });
  const readableLabels = Array.isArray(state.labels) && state.labels.every(label =>
    typeof (typeof label === 'string' ? label : label?.name) === 'string'
      && (typeof label === 'string' ? label : label.name).trim().length > 0);
  const removals = decision.removeLabels.filter(label => hasReviewLabel(state.labels, label));
  return { decision, independence, referralCarry,
    settled: readableLabels && decision.allowed && hasReviewLabel(state.labels, decision.addLabel) && removals.length === 0 };
}
