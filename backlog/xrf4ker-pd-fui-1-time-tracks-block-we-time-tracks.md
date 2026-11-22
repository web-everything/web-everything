---
kind: story
size: 5
status: open
scope: ["frontierui"]
dateOpened: "2026-11-22"
tags: []
---

# PD-FUI-1 Time tracks block (we-time-tracks)

Frontier UI block we-time-tracks (blocks/time-tracks). Acceptance: lanes keep order; same time maps to same x; today marker splits past and a forecast slot; Up/Down moves focus lane to lane; no hex colours and no @keyframes. Tier-1 test: stacks lanes on one shared axis and places an item by its time. Needs Time Track intent entry. Max 300 non-test lines.

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

new card for the PD-FUI plan; none filed yet
