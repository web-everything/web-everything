---
bornAs: xx69xw6
kind: story
size: 3
status: open
scope: ["plateau:src/wip/", "plateau:src/wip/glance/"]
dateOpened: "2026-10-08"
tags: []
---

# Add mobile-friendly navigation menu to /wip and related pages

Filed from owner request R-LQDDN (story). On a phone (366px wide) there is no easy way to move between /wip and its related pages (e.g. /sessions, glance). Add a compact, touch-friendly menu (hamburger or bottom bar) that lists those pages, highlights the current one, and works at mobile widths without horizontal scroll. Assumption: 'related pages' means the existing WIP-family pages (/wip, /wip glance, /sessions); desktop layout stays as is or reuses the same nav. Done when the menu appears on all those pages, every link navigates correctly, and it is usable at 366x791.

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
