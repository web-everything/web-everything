---
bornAs: xl48e17
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# Chained daemon blockers are found one at a time

MED priority hint. ## (held 2026-10-25 coroner night) Chained daemon blockers are found one at a time The drain chain (overlay order, smoke origin, bootstrap, main moved) and the #5874 chain (deadlock, then gh 403, then log hid the error) each took several rounds, one blocker per round. Fix: a dry-run "walk the whole rebuild/promote path" operation that runs every stage against a copy and lists all failing stages at once; run it before the first fix, not after each. Evidence: handoff 10-25 08:02, 13:38, 20:53 ET. Scope: we:scripts/operations (rebuild smoke, daemon dry-run), Size 3.

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
