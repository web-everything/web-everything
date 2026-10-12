---
bornAs: x4bppjr
kind: story
size: 1
status: open
scope: ["we:scripts/readiness/heavy-admission.mjs", "we:scripts/readiness/heavy-repair-priority.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Red-main repair patterns resolve host-wide, not per caller

Held finding 231 (2026-10-11, operator approved #4814 with this follow-up). we:scripts/readiness/heavy-admission.mjs (~:240) declares priority.mode / priority.repairPatterns as per-caller leaves, so any process can mark itself P0 (even .* validates). Fix: resolve them once host-wide (same single source as the cap, #4799), reject patterns broader than the main-fix/revert-red shapes and log rejected ones; tests assert the "yielding to red-main repair waiter" log line and the 150 ms classification deadline.

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
