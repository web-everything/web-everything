---
kind: story
size: 3
parent: "5445"
status: open
scope: ["we:schemas/verdict-ledger-event.v1.json", "we:scripts/lib/__tests__/verdict-ledger-event-schema.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Ledger standard: event schema published as JSON Schema

Slice of #5445 (A2). Publish a JSON Schema for every event type in we:scripts/lib/verdict-ledger.mjs EVENT_TYPES (verdict, referral, ruling, review-run, hold, release, approval, send-back, author, label-input, finding). The schema names states (for example held-for-human), never GitHub label strings (D5). Done when a test validates every buildLedgerEvent/buildVerdictRecord fixture against the schema and proves the schema and validateLedgerEvent agree on accept and reject for the same cases.

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
