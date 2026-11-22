---
kind: story
size: 3
status: open
blockedBy: ["xrf4ker"]
scope: ["frontierui"]
dateOpened: "2026-11-22"
tags: []
---

# PD-FUI-2 Milestone flags (we-milestone-flag)

Frontier UI block we-milestone-flag (child of we-time-tracks; needs PD-FUI-1). Acceptance: selecting a flag shows its window in place; ] selects next flag and [ the previous; one flag selected at a time; Esc or tapping the flag again clears; window opens in place, not a modal; the axis does not zoom; other flags dim. Accessible name = milestone name plus a relative window (in 3-9 days or window unknown); a calendar date only when the FCST-6 date policy allows it (default off). Dense flags de-fan (stack or offset) at 390 px with a test. Tier-1 test: selecting a flag shows its window in place; ] selects the next flag and [ the previous. Needs Time Marker intent entry. Max 300 non-test lines.

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

## Duplicate admission

new PD-FUI card
