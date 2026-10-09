---
bornAs: xps83ev
kind: story
size: 1
priority: now
status: open
scope: ["plateau:docs/wip-page.md"]
dateOpened: "2026-10-09"
tags: []
---

# Document the "Build now" choice in the WIP page doc

Filed from owner request R-BNOW1 (story). The WIP page doc doesn't yet explain the per-request "Build now" choice. Add a short "Build now" section to plateau:docs/wip-page.md stating that each request has a Build now choice, on by default, which files the card at P1 and lands the filing PR without waiting for review, while "Just file it" parks the request for review instead. Done when the section is in the doc and no code files changed. Assumption: placed alongside the doc's other request-flow sections, with wording kept to a few sentences.

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
