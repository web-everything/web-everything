---
bornAs: xi8kud8
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/stand-down-answer.mjs", "we:scripts/conveyor/rearm-review.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Stand-down and rearm-review answer residuals (#6840)

we:stand-down-answer.mjs:34 falls back to commit timestamps when the stand-down recorded no head (a force-pushed older-dated commit passes): require the SHA. The operator-rearm-answer-deadlock soak harness should use it.fails so a vacuous pass is caught. we:rearm-review.mjs:207 accepts automation-authored answers (the CLI posts via the App identity with a declared operator actor): bind acceptance to the stand-down-answer CLI record (declared actor and channel), not comment author type. Pre-existing gaps: we:rearm-review.mjs:339 read failure fails open; :329 --round=conflict and --only-if skip the empty-round guard.

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
