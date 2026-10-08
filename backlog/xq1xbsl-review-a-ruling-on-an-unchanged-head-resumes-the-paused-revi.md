---
kind: story
size: 5
status: open
scope: ["we:scripts/operations/review-loop-cli.mjs", "we:scripts/operations/review-pr.mjs", "we:scripts/conveyor/review-referral-hold.mjs", "we:scripts/operations/review-pr-io.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Review: a ruling on an unchanged head resumes the paused review; no fresh panel, no new referrals

After an operator ruling on an unchanged head the review daemon (we:scripts/conveyor/review-referral-hold.mjs release then we:scripts/operations/review-loop-cli.mjs fresh start) ran a full new panel that raised NEW mandatory referrals, so the PR flipped back to advisory:ruling-needed and never reached the operator (live 2026-10-08: #4361 ruling 12:09Z then fresh review 12:15Z with 2 new referrals; #4388 round 2 at 12:20Z re-raised a finding the fixer had already fixed). Fix: resume the parked run (rewind to the mandatoryReferrals step) and reuse its verdict and findings; findings first raised in a later round on the same head become card suggestions (rule of #3999), and a re-raised finding matched by finding identity (#4233) is not re-referred. New referrals come only from a new push. Gate change: needs human review.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
