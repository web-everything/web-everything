---
kind: story
size: 3
status: open
blockedBy: ["xrf4ker"]
scope: ["fui:blocks/"]
dateOpened: "2026-11-22"
tags: []
---

# PD-FUI-7 Heat strip (we-heat-strip)

Frontier UI block we-heat-strip (blocks/heat-strip) for the project rung (PD-PROJ, P1, later); needs PD-FUI-1. Acceptance: one thin strip per machine on the shared time axis; colour = busy percent against that machine's own target (calm under, warm near, hot over); colour never the only carrier: hover or focus gives text like Studio 82% of 75% target; hot cells have a pattern-free outline; no hatching (reserved for forecast). Tier-1 test: maps busy/target to calm, warm or hot and exposes the value as text on focus.

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
