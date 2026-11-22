---
bornAs: xn4er4k
kind: story
size: 3
status: open
scope: ["fui:blocks/"]
dateOpened: "2026-11-22"
tags: []
---

# PD-FUI-4 Detail sheet (we-detail-sheet)

Frontier UI block we-detail-sheet (blocks/detail-sheet): composes master-detail + layout. Acceptance: opens on selection, moves focus into the sheet, closes on Esc and returns focus; selection comes from SelectionBehavior; aria-labelledby from its title; right drawer above 640 px and bottom sheet below (container query, not viewport guess; supersedes the 700 px figure); v1 modal on both with scrim, focus kept inside, Esc and browser Back close it, each step has a #step-id link. Non-modal desktop drawer is a later refinement. Tier-1 test: opens on selection, moves focus into the sheet, closes on Esc and returns focus. Max 300 non-test lines.

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
