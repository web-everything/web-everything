---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/stand-down-answer-core.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# A close-superseded operator answer resolves every earlier stand-down on the PR

Live #4522: two stand-downs (fixer 04:36Z, supersede-watch 05:38Z); the close-superseded answer named only the latest, so the earlier one kept REFUSAL 1 (stood-down) firing before the disposition branch and the PR never closed. Fix: a later answer carrying a disposition supersedes every earlier stand-down (stand-down-answer-core isOperatorAnswerStandDownSuperseded); a stand-down after the answer and a live fix claim still hold.

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
