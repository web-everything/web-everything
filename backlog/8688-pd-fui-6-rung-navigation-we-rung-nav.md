---
bornAs: xqganip
kind: story
size: 3
status: open
scope: ["fui:blocks/"]
dateOpened: "2026-11-22"
tags: []
---

# PD-FUI-6 Rung navigation (we-rung-nav)

Frontier UI block we-rung-nav (blocks/rung-nav); needed by every rung, PD-LADSET and the DZ-SHELL breadcrumb; independent of FUI-1 to 5. Acceptance: breadcrumb that follows the ladder (Plan, Stream, Feature, PR) plus a rung switch (segmented control on desktop, menu on phone); rungs come from data (the ladder setting, preset B, D15 cascade), hard-coded rungs are a test failure; each rung has a hash link; Esc and browser Back go up one rung. Tier-1 test: renders the rungs from the ladder setting; selecting a rung updates the hash; Back returns to the previous rung.

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
