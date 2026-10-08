---
kind: story
size: 8
status: active
scaffoldedBy: "hermetic-tests"
dateScaffolded: "2026-10-08"
dateOpened: "2026-10-08"
tags: []
---

# Hermetic tests by default: blocking unit/soak suites cannot reach live GitHub, conveyor state, lane pool or origin backlog; live tests move to a scheduled non-blocking suite

Main went red ~5.5h (2026-10-08) because soak scenario build-dispatch-orphan-adopt read live gh + origin/main backlog with real card numbers. Make the test + soak harness hermetic by default: a loud recording fake gh, fs guards on the real conveyor state root / lane pool / primary-checkout backlog, a per-test violation check, a ratchet scan over tests that reference live readers without injection, and a separate scheduled live suite (declared settings) that never gates PRs/main.

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
