---
bornAs: xg9rk9c
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# R74: review daemon runs one final review at the round ceiling and publishes needs-you for the operator verdict

2026-10-24 18:24 ET, live case #5762: round ceiling hit, findings carded, daemon never re-reviewed and stayed cap-exhausted; the orchestrator session could not run /review because it opened the PR. Want: once every open finding is ruled (card, not-real or block) at the ceiling, the review daemon runs ONE final review in its own session and publishes needs-you for the operator verdict.

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
