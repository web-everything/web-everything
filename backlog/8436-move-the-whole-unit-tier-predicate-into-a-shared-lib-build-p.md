---
bornAs: x4vdcyh
kind: task
status: active
scaffoldedBy: "fix-6769"
dateScaffolded: "2026-11-14"
dateOpened: "2026-11-14"
tags: []
related: ["8230"]
---

# Move the whole-unit-tier predicate into a shared lib; build-policy and worker-brief still key on the raw finalGate value

Move the whole-unit-tier predicate into a shared lib; build-policy and worker-brief still key on the raw finalGate value. Context from the finding: same defect class as PR 6769 round 3 (whole-tier decided from setting value, not effective gate).

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

same defect class as PR 6769 round 3 (whole-tier decided from setting value, not effective gate)
