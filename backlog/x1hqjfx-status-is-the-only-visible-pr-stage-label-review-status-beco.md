---
kind: story
size: 5
parent: "xyr5c8u"
status: open
scope: ["we:scripts/conveyor/pr-status-label.mjs", "we:scripts/conveyor/review-status-tag.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# status:* is the only visible PR stage label; review-status:* becomes internal state

Operator 2026-10-10 ~12:35 ET: PRs carry both status:fixing and review-status:fixing (and awaiting-ci, …). Map every review-status:* value (reviewing, fixing, fixing-conflict, awaiting-ci, awaiting-base, draft-withdrawn, fix-stalled, …) onto a status:* value in we:scripts/conveyor/pr-status-label.mjs; stop writing review-status:* labels in we:scripts/conveyor/review-status-tag.mjs (keep the value as internal state/ledger); remove old labels from open PRs through that single writer; first migrate every reader (operator-queue, /wip, coroner, drain, we:scripts/conveyor/takeover-budget.mjs#gateHoldReason) to internal state or status:*, with tests. Setting labels.legacyReviewStatus (cascade) switches the old labels back on. Proof: after adoption, open PRs show exactly one stage label and no review-status:*.

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
