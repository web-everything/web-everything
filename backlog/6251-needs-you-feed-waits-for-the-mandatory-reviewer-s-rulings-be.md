---
bornAs: x7jac32
kind: story
size: 3
status: open
scope: ["we:scripts/operations/needs-you-feed.mjs", "we:scripts/operations/__tests__/needs-you-feed.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Needs-you feed waits for the mandatory reviewer's rulings before raising ruling-needed

Live: #5482 (19:13 to 19:15Z) and #5486 (19:21 to 19:23Z) both raised ruling-needed and cleared about 2 minutes later, because the mandatory reviewer recorded the finding-specific rulings itself (#5486: both not-real, with evidence). Fix: the feed emits ruling-needed only for findings still unruled after the reviewer's ruling step, or after a settle window of about 3 minutes; a setting with its source logged. Belongs with decision xf5n5yw (#5503). [A1] Executable: node --test we:scripts/operations/__tests__/needs-you-feed.test.mjs, where a finding ruled within the window never raises ruling-needed. Priority: top (operator 2026-10-17).

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
