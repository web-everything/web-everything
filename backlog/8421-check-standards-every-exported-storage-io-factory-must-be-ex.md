---
bornAs: x0vayjq
kind: task
status: active
scaffoldedBy: "fix-6580"
dateScaffolded: "2026-11-09"
dateOpened: "2026-11-09"
tags: []
related: ["6580"]
---

# check:standards: every exported *Storage/*Io factory must be exercised by a non-mocked test (PR 6580 review prevention)

check:standards: every exported *Storage/*Io factory must be exercised by a non-mocked test (PR 6580 review prevention). Context from the finding: PR 6580 review found mqFailureLedgerStorage and mqFailureRefreshIo untested because every test injected an in-memory adapter.

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

PR 6580 review found mqFailureLedgerStorage and mqFailureRefreshIo untested because every test injected an in-memory adapter

no existing rule checks that production IO factories are imported by an un-mocked test
