---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# A PR the CI fixer hands to a human never gets an AI review

[held entry 273] (2026-10-13, held — from #5157 approval) A PR the CI fixer hands to a human never gets an AI review. The review daemon reviews only when CI is green; red CI goes to the CI fixer first; when the fixer escalates (here: merge-gate test-gaming hold the PR itself fixes — a gate-self PR that cannot clear itself), the daemon skips review on that head forever (ci-heal-escalated). Result: #5157 (merge-gate code) reached the operator with zero AI review (12:22 to 14:17 ET). Fix: when ci-heal escalates to a human, or the only red check is a hold that needs review to clear (merge-gate review/test-gaming hold), dispatch the advisory AI review anyway so the human gets its verdict.

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
