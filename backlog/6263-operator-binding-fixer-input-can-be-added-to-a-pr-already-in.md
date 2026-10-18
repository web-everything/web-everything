---
bornAs: xzr443y
kind: story
size: 2
status: open
scope: ["we:scripts/review-set-label.mjs", "we:scripts/operations/record-referral-ruling.mjs", "we:scripts/conveyor/fix-context-pack.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Operator binding fixer input can be added to a PR already in review:changes

Live 2026-10-17 #5551: the operator ruled block on two findings, but the PR was already review:changes, so review-set-label --to=changes was skipped and the binding instructions had no sanctioned channel. The session posted a plain '🔁 human review — changes requested' comment instead. Also, record-referral-ruling rejected the full finding text as --finding and accepted only 'file:line'. Fix: review-set-label accepts --to=changes on a review:changes PR as an 'add binding input' action (posts the binding body, keeps the label); record-referral-ruling accepts the finding text or key as printed in the mandatory-review comment.

## Acceptance

- [A1] **Executable** — `[A1] Executable` tests for both: review-set-label `--to=changes` on a review:changes PR posts the binding body and keeps the label; record-referral-ruling accepts the finding text or key as printed in the mandatory-review comment. Both fail before this item lands and pass after.

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
