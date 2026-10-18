---
bornAs: x3mllo9
kind: story
size: 2
status: open
scope: ["we:scripts/operations/review-dispatch.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Operator manual re-review override keeps working (plain CLI review-dispatch --pr re-reviews a head at the same-head limit)

[A1] Executable. Binding operator item on PR #5510 (operator 2026-10-18, PR paused): an operator running the plain CLI review-dispatch --pr must still be able to re-review a head that has reached the same-head review limit. Whatever the core of #5510 changes in the claim path (the drain requesting a red team, the saved result read with provenance), the manual override must keep working. Add a named test: a plain CLI review-dispatch --pr on a head at the same-head limit still dispatches a re-review, while automatic dispatch stays capped.

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
