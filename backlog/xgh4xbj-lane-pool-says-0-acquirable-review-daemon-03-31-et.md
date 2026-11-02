---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# Lane pool says "0 acquirable" (review daemon 03:31 ET

HIGH priority hint. - [HIGH] Lane pool says "0 acquirable" (review daemon 03:31 ET; ci-heal lane-acquire scan timeouts earlier) while only 9 of 74 lanes are leased → the acquirability scan (dirty/salvage/reserved checks or scan timeout under load) is rejecting ~65 free lanes. Delays every review/fix dispatch. Also "SALVAGE PUSH FAILED: unknown transport config scope" on most releases tonight — likely the same root (lanes left in a salvage-pending state count as unacquirable).

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
