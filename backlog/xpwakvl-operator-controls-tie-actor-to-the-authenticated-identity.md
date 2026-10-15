---
kind: task
status: open
scope: ["we:scripts/operations/operator-controls.mjs", "we:scripts/operations/operator-controls-io.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# operator controls: tie --actor to the authenticated identity

Ruling card from PR #5169 (operator, 2026-10-15). we:scripts/operations/operator-controls.mjs checks --actor only as a string against OPERATOR_LOGINS, so an automation shell can write an operator-attributed audit record for unpark, retry-prepare, rearm, refresh and clear-claim. Bind the actor to the authenticated gh/role-App identity; do with the role-App work (card 346).

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
