---
kind: story
size: 3
parent: "x87psvt"
status: open
blockedBy: ["x5nmdnt"]
scope: ["we:scripts/operations/card-batch-extract.mjs", "we:scripts/operations/__tests__/card-batch-extract.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Collector batch held on an unextractable finding gets an age escape

Per decision x5ioz96 fork 4 skeptic amendment: a finding that names no single card file, or several, holds the batch for a person with no age escape today. After a bounded age (a setting with its source logged) the hold escalates to the operator as needs-you and the batch no longer blocks admission of new cards into a fresh batch. [A1] Executable: node --test we:scripts/operations/__tests__/card-batch-extract.test.mjs, where an unextractable-finding hold older than the age setting escalates and stops blocking admission.

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
