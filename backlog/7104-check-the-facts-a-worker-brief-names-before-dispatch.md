---
bornAs: xrqdwql
kind: task
status: open
scope: ["we:scripts/worker-brief.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Check the facts a worker brief names before dispatch

coroner 2026-10-22: workers stopped 3 times because the brief rested on a wrong premise (a red team assumed not run when only its comment post failed; a named gap that did not exist) - each cost a lane lease, a worker start and an orchestrator turn. Before dispatch a script checks the facts the brief names (file and symbol exist on main, PR head, status of the cited run) and refuses or annotates the brief when one fails. Prove on a replay of the three stopped briefs.

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
