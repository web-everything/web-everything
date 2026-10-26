---
bornAs: x2em6qa
kind: task
status: open
scope: ["we:scripts/operations"]
dateOpened: "2026-10-25"
tags: []
---

# A ci-heal verify request carries a deadline and re-queues once itself

coroner 2026-10-23: a ci-heal session on #5829 waited 128.6 of 137 minutes for a verify verdict that never came and ended 'blocked-on-infra, not pushed' (2 re-requests; 102 supersedes and 140 code-changed restarts in the window). The verify request carries a deadline; when the verify daemon was superseded or killed, the harness re-queues it once itself and records the cause.

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
