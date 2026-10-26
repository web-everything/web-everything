---
bornAs: x361vel
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Use the Antigravity Claude allocation opportunistically

[held entry 287] (operator 2026-10-13 ~21:10 ET: "we have a small agy allocation on Claude, not large but should be used") Use the Antigravity Claude allocation opportunistically: #5228 moved the agy shadow seats to Argon, so the agy-hosted Claude quota now goes unused; before that it was held 98% of the time (2,086/2,134), which also suggests the agy quota hold is not released when the window resets (see the stale-hold concern on the agy quota record). Route one Claude-family review seat (or Claude helper work) to agy-Claude WHEN its quota is available, falling back to Claude Max — saves Max quota, never blocks. Quota-aware scheduler + hold that re-checks instead of waiting out an old timer. Settings; logged source. Fold into the value analysis plans (card 286).

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
