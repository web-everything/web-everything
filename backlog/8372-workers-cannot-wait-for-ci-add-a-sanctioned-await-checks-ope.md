---
bornAs: x2uz77l
kind: story
size: 3
status: open
scope: ["we:scripts/operations"]
dateOpened: "2026-11-15"
tags: []
---

# Workers cannot wait for CI: add a sanctioned await-checks operation

2026-11-15 10:17 ET MED: workers cannot wait for CI (the hook refuses gh pr checks --watch even as a harness-tracked background call), so every load-after-CI worker stops and the orchestrator must re-dispatch it (#6873, #6882, #4283 today). Fix: a sanctioned declared op (e.g. an await-checks operation taking --pr=N --check=test) that workers may run as a tracked background call, or let the hook allow --watch when run_in_background.

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
