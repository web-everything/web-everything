---
bornAs: xce1bez
kind: task
status: open
scope: ["we:scripts/operations/coroner-extract.mjs", "we:scripts/operations/coroner-rounds.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Fixer wrapper writes one session record the coroner reads

coroner 2026-10-24 (window 02:47Z to 02:47Z): saw only 4 fix sessions and 0 fix minutes on 24 code PRs though fixers ran all day (#5848, #5759 x4, #5838); errorRates.fixSessions 4/4 and every changeRequests PR shows fixMinutes 0. Have the fixer wrapper write one record (PR, head, round, start/end, outcome) to a fixed log the extractor reads, and have the coroner fail loudly when fix sessions are far below fix-dispatch ticks (fix-dispatch-daemon.log 9822 lines).

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
