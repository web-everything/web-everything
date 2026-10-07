---
kind: task
status: open
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Diagnose unknown prepare result failure (227036f0c649fb28)

Prepare #4560 is held. Cause is unknown. Evidence is retained in the coordination-root prepare failure ledger under cause key 227036f0c649fb28 and item 4560; inspect the recorded terminal output before making a diagnosis. Recover the terminal evidence, fix the cause and add a regression. Release requires a reviewed fix commit. Cause key: 227036f0c649fb28.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
