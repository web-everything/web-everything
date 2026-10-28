---
bornAs: xr6n5ta
kind: story
size: 3
status: open
scope: ["we:scripts/operations/judge-sweep-facts.mjs", "we:scripts/operations/judge-sweep-facts-io.mjs"]
dateOpened: "2026-10-28"
tags: []
---

# HIGH: judge-sweep-facts lets unowned fire alongside evidence-unavailable

HIGH. 2026-10-28 09:13 ET. evidence-unavailable (comment read fails; 11-14 of 15 PRs today under load) leads and masks unowned/stall reasons. Follow-up to #6028 and complements #7094 (budget/paging): find why the evidence read fails (rate limit? timeout under load?) and let unowned fire alongside evidence-unavailable (fail closed for judgment, not for ownership).

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
