---
kind: story
size: 2
status: open
scope: ["frontierui"]
dateOpened: "2026-11-22"
tags: []
---

# PD-FUI-3 Status card with source-word tag (we-status-card)

Frontier UI block we-status-card (blocks/status-card): card, we-badge state, source-word slot rendered with we-tag. Acceptance: renders state badge, title and source-word tag; the word is text, not only colour; words Measured, Derived, Assumed, Edited, Stale, Plan as small mono uppercase ink-muted, never coloured, never sun; border style is the second carrier (solid, dotted, dashed, solid with pencil, dashed with clock, solid no fill); unknown word falls back to a neutral tag; no animation (no pulse). Tier-1 test: renders state badge, title and source-word tag; the source word is text, not only colour. Check whether to merge with the Attention Card entry in MISSING_BLOCKS. Max 300 non-test lines.

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
