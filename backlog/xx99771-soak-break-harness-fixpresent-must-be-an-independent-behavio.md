---
kind: task
status: open
scope: ["we:scripts/conveyor/soak/define-break-test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Soak break harness: fixPresent must be an independent behavioural probe, not a circular it.fails switch

we:scripts/conveyor/soak/define-break-test.mjs: a break whose fixPresent is false switches its test to it.fails, so a broken or absent fix still lets the suite pass. Flagged by the audit on #5865 and #5877 (2026-10-24). Want: fixPresent is an independent behavioural probe and the harness fails loudly when fixPresent is false in a lane where the fix commit is present. Related open card 5292.

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
