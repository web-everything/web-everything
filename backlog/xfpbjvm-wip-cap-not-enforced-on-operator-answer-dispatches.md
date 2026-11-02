---
kind: story
size: 2
status: open
scope: ["we:plan.md"]
dateOpened: "2026-11-02"
tags: []
---

# WIP cap not enforced on operator-answer dispatches

MED priority hint. ## (held 2026-10-26 07:34 ET) WIP cap not enforced on operator-answer dispatches At 07:33 ET load was 75 with 6 workers running vs the plan cap of 3 (Mon). The orchestrator dispatched a worker per operator answer (R123/R125/R126/R130/R131 + #5942) outside the work-check refill. Fix: every dispatch counts against the WIP cap; above it, queue the work into we:plan.md "Next 3 days" and start it at the next free slot.

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
