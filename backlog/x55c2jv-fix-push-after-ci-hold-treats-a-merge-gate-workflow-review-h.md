---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/await-verify-pass.mjs", "we:scripts/lib/review-timing.mjs", "we:scripts/lib/merge-gate-hold-class.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Fix push-after-CI hold treats a merge-gate workflow-review hold on the old head as a repairable CI failure

Live on PR 7142 (2026-11-22): a verified-green conflict-fix commit was withheld because the previous head's merge-gate was red. That red was only the review-acceptance human-only hold for a .github/workflows edit. we:scripts/conveyor/await-verify-pass.mjs reads previous-head checks via raw readReviewChecks (we:scripts/lib/review-ci-gate-io.mjs) and never applies excuseMergeGateRows (we:scripts/lib/merge-gate-hold-class.mjs), so isReviewHoldGate in we:scripts/lib/review-timing.mjs#fixPushGate never sees mergeGateReviewHold and the hold is reported as a CI failure the fixer must repair. No commit can clear a human-review hold, so every conflict-fix on a review:human workflow PR loops to a false gate-red; PR 7142 already carries four leftover fix alt branches. Fix: excuse merge-gate review holds in the previous-head read the same way the review CI gate does, with a soak break replaying PR 7142.

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
