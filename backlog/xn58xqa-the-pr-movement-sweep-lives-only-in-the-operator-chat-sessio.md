---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# The PR movement sweep lives only in the operator chat session

[held entry 335] (operator ok 2026-10-14 ~17:20 ET, held, HIGH, build first) The PR movement sweep lives only in the operator chat session. It is a session-only cron (17,47 * * * *): when the session ends, no one watches PR movement. Fix idea: run the sweep (idle PRs 45+ min, owner check from fix/review/drain logs + watchdog smells, operator-queue NEEDS YOU/RULING, quiet hours, one diagnosis agent per batch of stuck PRs) as a health-watch daemon job with settings (interval, idle threshold, quiet window), with push alerts per quiet rules. Prove: the sweep runs with the chat closed and catches a stuck PR.

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
