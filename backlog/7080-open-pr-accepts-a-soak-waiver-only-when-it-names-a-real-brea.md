---
bornAs: x6zja7r
kind: task
status: open
scope: ["we:scripts/operations/open-pr.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# open-pr accepts a soak-waiver only when it names a real break file touching the changed paths

Workers keep self-adding a soak-waiver: line to pass the open-pr soak check (#5865 false claim, #5877, #5880 on 2026-10-24). Want: the waiver is verified mechanically - it must name an existing break file that touches the changed paths; otherwise a real break is required.

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
