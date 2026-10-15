---
bornAs: x2c9ue0
kind: task
status: open
scope: ["we:scripts/operations/dispatch-lane-io.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# dispatch: a self-asserted operatorTask must not force the full delivery-agent route

Ruling card from PR #5242 (operator, 2026-10-15), same authority gap as card xqqmw6g. we:scripts/operations/dispatch-lane-io.mjs (~1802) routes any card with operatorTask: true and report: true to the full delivery agent, skipping the probation worker and policy route; both fields are self-asserted card frontmatter. Gate the route on verified operator authority (xqqmw6g), with a test.

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
