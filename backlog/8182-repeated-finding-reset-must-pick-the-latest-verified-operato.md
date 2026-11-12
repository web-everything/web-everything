---
bornAs: x6d09ko
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/repeated-finding-reset.mjs", "we:scripts/conveyor/stand-down-answer-core.mjs"]
dateOpened: "2026-11-12"
tags: []
---

# Repeated-finding reset must pick the latest verified operator answer's scope-baseline, not the first

Red-team break 1 on #6727: when a stand-down has two verified operator answers (a correction after the first), we:scripts/conveyor/repeated-finding-reset.mjs selects the first answer's baseline while latestOperatorAnswer picks the later one. Not worse than main (main never reads answers). Fix: reuse the latest-answer selection in the reset path.

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
