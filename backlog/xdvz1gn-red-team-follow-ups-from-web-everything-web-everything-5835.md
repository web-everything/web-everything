---
kind: story
size: 2
status: open
scope: ["we:scripts/codex-direct-task.mjs"]
dateOpened: "2026-10-23"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5835 (head 645cffc72)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5835 (reviewed head `645cffc724bc8dab17c1cdbbe389e269a20e3a32`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/codex-direct-task.mjs:1220` — (edge-case, degraded) Synchronous PID lookup exceeds the shared wait deadline
   - Scenario: Run 'wait --job=&lt;running-job&gt; --max-ms=250' for a record with pidStart while the ps lookup stalls. readPidStart synchronously blocks with an independent 1000 ms timeout, preventing the wait deadline from firing. A read-only probe substituted a real two-second subprocess for ps: waitForJob took 1010 ms and returned code 2; the CLI reproduction also exited 2 after exceeding its budget. It should return running/code 75 at the requested deadline, with the PID probe bounded by the remaining budget.
   - Claude's re-check: demonstrated break

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
