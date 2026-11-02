---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# A follow-up the orchestrator promises in chat is not tracked anywhere

MED priority hint. 382. (coroner-1027, held; key: untracked-followup-promise) A follow-up the orchestrator promises in chat is not tracked anywhere. #5912 follow-up promised, never scheduled, noticed 160 min late only when the operator asked "5912?" (01:41 ET 10-28). Fix idea: when a reply says "I will check X at T", a declared op records it as a timed watch (one row, fires a needs-you or sweep line at T); the sweep lists open promises. Evidence: orchestrator session bd616854, 10-27 23:37 ET vs 01:41 ET; R170 rule set at 23:03 ET only covers the enqueue ask. Scope: we:scripts/operations. Size 3.

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
