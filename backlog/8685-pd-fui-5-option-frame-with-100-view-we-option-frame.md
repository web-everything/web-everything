---
bornAs: xkjijbm
kind: story
size: 3
status: open
scope: ["fui:blocks/"]
dateOpened: "2026-11-22"
tags: []
---

# PD-FUI-5 Option frame with 100% view (we-option-frame)

Frontier UI block we-option-frame (blocks/option-frame). First task: check story-canvas and deck for an existing block. Acceptance: the 100% view is a full-screen takeover at 1:1 pixels (desktop up to 1400 px, phone device width, scrolls if wider) with prev/next (arrow keys, swipe unless content scrolls sideways), a position marker (B, 2 of 3), Pick this, and Close (Esc); the pick control is a real button with aria-pressed in the takeover header and the card, never inside the drawn option; the frame label names the option. Tier-1 test: opens the 100% view of the selected option, moves between options with prev/next, and keeps the pick state. Needs Option Frame intent entry. Max 300 non-test lines.

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
