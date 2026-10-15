---
kind: task
status: open
scope: ["we:scripts/conveyor/exhausted-retry.mjs", "we:scripts/conveyor/__tests__/"]
dateOpened: "2026-10-15"
tags: []
---

# Exhausted retry: persist fix-loop exhaustion outside the outcome comment

Operator ruling 'card' on PR #5331 red-team break (2026-10-15 ~07:15 ET). we:scripts/conveyor/exhausted-retry.mjs ~143: exhaustion state on the new head is derived only from the outcome comment, so if that comment write is lost after a successful retry rebase the PR is treated as fresh and gets another full fix round. Fix: record exhaustion and retry count in the durable run record (or the action-store claim ledger) keyed by PR, read it before the comment; test the lost-comment case.

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
