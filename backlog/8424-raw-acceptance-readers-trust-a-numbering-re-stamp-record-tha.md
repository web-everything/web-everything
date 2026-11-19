---
bornAs: x1wsc67
kind: story
size: 3
status: active
scaffoldedBy: "fix-5233"
dateScaffolded: "2026-10-14"
scope: ["we:scripts/lib/accept-carry-forward.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/review-set-label.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Raw acceptance readers trust a numbering re-stamp record that numbering-carry dropped as stale

Found in PR 5233 fix self-review. numbering-carry now drops a re-stamp record whose carried acceptance was superseded or held in the gap between its last pre-write re-read and postComment, but the record stays on the thread. latestAcceptRecord, parseReviewedSha and parseLatestHumanClearedSha still read it as the latest clean acceptance on the head: reconcileDrainReviewPending (merge-ai-prs) when review:accepted and review:pending are both present, review-set-label restamp carry-forward, and the human-clearance carry on the next identical-diff head move. Fix in product: share validatedThread with latestAcceptRecord so every reader agrees, or have the writer post a withdrawal record when its post-write re-plan drops its own record.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
