---
bornAs: xljfg47
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/build-dispatch-orphan-adopt.mjs", "we:scripts/conveyor/__tests__/", "we:scripts/conveyor/soak/breaks/build-dispatch-orphan-adopt.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Orphan-adopt: pin the production defaults readBuildDelivery and defaultSessionLiveness with an end-to-end test

Follow-up from #4361 advisory review (operator approved with follow-up cards 2026-10-08). we:scripts/conveyor/build-dispatch-orphan-adopt.mjs:520 defaults readDelivery=readBuildDelivery and sessionLivenessFor=defaultSessionLiveness are untested; the test wrapper overrides both. Add a default-wiring test (real adoptOrphanedBuildClaims with only gh exec + jobs dir injected) or extend the orphan-adopt soak break to cover a delivered claim and a paused await-verify claim.

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
