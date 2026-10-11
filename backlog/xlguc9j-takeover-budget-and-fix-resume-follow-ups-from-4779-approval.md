---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/takeover-budget.mjs", "we:scripts/conveyor/fix-resume.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/__tests__/"]
dateOpened: "2026-10-11"
tags: []
---

# Takeover budget and fix-resume follow-ups from #4779 approval

Operator approved #4779 (2026-10-11) with these referral/advisory findings deferred: we:scripts/conveyor/takeover-budget.mjs findingWeight gives unrecoverable less weight than broken so a worsening takeover reads as progress; a review of the pre-takeover head (or one arriving after a takeover) can authorize another takeover without takeover progress (same-head bound); we:scripts/conveyor/fix-resume.mjs:236 treats an expired session lease as ownership and skips reacquisition; we:scripts/conveyor/reconcile-core.mjs:1805 refuses an unjudged takeover push as takeover-awaiting-review with no note; plus tests for the readMechanicalRoundFacts ref-safety guard and the fix-resume 4 MB journal-tail bound and torn lines.

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
