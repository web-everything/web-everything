---
kind: story
size: 2
status: active
scaffoldedBy: "fix-7281"
dateScaffolded: "2026-11-23"
scope: ["we:scripts/conveyor/rearm-review.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# rearm-review: re-arm a no-change round when an operator ruling accepts the hold

When an operator ruling accepts a hold and orders a re-arm with no code change (live PR #7281, ruling R1035: a deliberate test-file deletion accepted), we:scripts/conveyor/rearm-review.mjs refuses with 'no change made — fix still owed (head unchanged since fix-begin)'. Its decideEmptyFixRound has no exemption for an answered stand-down, so every relayed ruling dispatches a fixer that cannot re-arm, in a loop. Add a ruling-applied mode: the guard verifies a trusted operator-answer marker for the latest stand-down at the live head, then allows the review:changes → review:pending swap. Review gates (merge-gate test-gaming human clearance) stay in force. Live proof: PR #7281 re-arms through the new mode.

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
