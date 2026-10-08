---
kind: story
size: 1
status: open
scope: ["plateau:src/wip/glance/glance-mount.ts", "plateau:src/wip/glance/glance.css", "plateau:tests/e2e"]
dateOpened: "2026-10-08"
tags: []
---

# /wip deep links: ?card=N highlights a card, ?agent=<session> opens its agent panel (P3 of 128)

Slice P3 of card 128. /wip?card=N scrolls to and highlights that card on /wip, and /wip?agent=<session> opens that session's agent panel (the /sessions page links this way). An unknown card or session shows a small inline notice, no error. Done when a mount test proves ?card=ID focuses the card and an unknown id or session shows a note.

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
