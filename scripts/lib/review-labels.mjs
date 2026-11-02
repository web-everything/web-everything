/**
 * @file review-labels.mjs
 * @description Review label names, shared by policy and forge IO without importing their module graphs.
 */

/** The ratified reviewer-verdict labels (#2171). The reviewer's disposition is a LABEL, never comment-parsing:
 *  independent *disposition* (reviewer accepts/rejects) is split from hot-context *fixing* (the author lane). */
export const REVIEW_LABELS = {
  pending: 'review:pending',   // the drain parked this PR — an independent review is owed before merge
  accepted: 'review:accepted', // reviewer accepted → the drain may merge
  changes: 'review:changes',   // reviewer wants changes → the author lane fixes hot-context + re-pushes
  human: 'review:human',       // #2285 v1 — the diff edits the gate's DECLARATIVE LEASH (the contract / roster / invariant suites) or the STATUTE layer; only a HUMAN may clear it. Policy-tier derivation code (#2771/#2785) and the engine tier (#2445) are agent-reviewable
  redteamAccepted: 'redteam:accepted', // #2439 — the INDEPENDENT hardened validator (a fresh-context adversary that took no part in the negotiation and never saw the peers' self-assessment) signed off on the FINAL diff. The "non-author accepts" invariant, applied by the drain; enforcement (requiring it before an engine-tier auto-land) is #2412's concern
  // mechanical-dispatcher lane — the operator's standing rule: a review:human PR is never reviewed cold, and
  // "hasn't had its advisory panel run yet" must be visible as a LABEL, not something checked by grepping for a
  // bot comment. Applied ALONGSIDE review:human at every site that adds it (pr-land.mjs at PR-open,
  // merge-ai-prs.mjs's park + its two tamper-triggered re-parks); removed ONLY by review-pr.mjs's `advise` step,
  // atomically with the moment it actually posts the panel's findings comment for that PR (#xlw02hw) — never a
  // separate poll/cron that could drift out of sync with whether the comment really landed. The removal is
  // declared as a SECOND effect there, strictly ordered after the comment post: the executor halts at the first
  // effect that does not land, so a failed/errored post leaves this label in place rather than silently
  // dropping it with no comment behind it.
  awaitingAdvisory: 'review:awaiting-advisory',
  // card x5f2daz — a PREPARE PR (card-only) got the light single-reviewer pass (`we:scripts/conveyor/prep-review.mjs`).
  // It is a RECORD that a review looked, not a verdict: it never blocks, never unblocks, and is never applied to a code PR.
  prep: 'review:prep',
  // card xu7kxtt (PR #4631, operator ruling 2026-10-10 ~14:20 ET, option a) — the drain's MECHANICAL park: its
  // anti-test-gaming re-park of a PR the operator already cleared on an older head (the merge queue / a rebase moved
  // the SHA). ONLY the drain writes it, so its presence is the positive proof the hold is mechanical, and it is the
  // ONLY hold accept carry-forward may lift (`review-set-label.mjs --to=restamp`, on a byte-identical net diff).
  // `review:human` always means a person set the hold and is never removed automatically. A hold like any other
  // (`REVIEW_HOLD_LABELS`): the PR may not merge while it stands.
  heldMechanical: 'review:held-mechanical',
};

/** R130 delegation may clear review:human only; every other blocking disposition stays with the operator. */
export const DELEGATED_CLEARANCE_INELIGIBLE_LABELS = Object.freeze([
  REVIEW_LABELS.changes, REVIEW_LABELS.heldMechanical, REVIEW_LABELS.pending, REVIEW_LABELS.awaitingAdvisory,
  'advisory:changes', 'advisory:ruling-needed', 'red-team:blocked', 'red-team:pending', 'operator:hold', 'hold:fix',
]);
