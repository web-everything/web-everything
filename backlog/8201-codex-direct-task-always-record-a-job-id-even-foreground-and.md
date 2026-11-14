---
bornAs: xd822pm
kind: story
size: 2
status: open
scope: ["we:scripts/codex-direct-task.mjs"]
dateOpened: "2026-11-13"
tags: []
---

# codex-direct-task: always record a job id (even foreground) and add a wait --pid mode

2026-11-13 09:00 ET (worker a9adb173). A worker that ran codex-direct-task without --detach has no job id and no allowed wait (shell until/sleep and Monitor-until are all denied), so it stalls. Fix: always record a job id, even in the foreground, and add a wait --pid mode. Orchestrator workaround meanwhile: caffeinate -w <pid> in a background Bash. Code: we:scripts/codex-direct-task.mjs

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

## Duplicate admission

capability-search found no matching open card
