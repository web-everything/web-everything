---
bornAs: xxdr63i
kind: story
size: 3
status: open
scope: ["we:scripts/readiness/heavy-admission.mjs", "we:scripts/readiness/heavy-repair-priority.mjs"]
dateOpened: "2026-10-28"
tags: []
---

# Heavy admission P1 wiring: policy-cascade fixPatterns/unblockPatterns and per-row waiter class on the queue baseline (R203 part B)

Part A (lane/unblock-heavy-fix-priority) added classifyP1 and waitersAheadOf in we:scripts/readiness/heavy-repair-priority.mjs. Part B: resolve heavyAdmission.priority.fixPatterns/unblockPatterns through the policy cascade in we:scripts/readiness/heavy-admission.mjs; make resolveQueueBaseline waiting rows carry priorityClass from the waiter marker so the fix/ci-heal projection sees real classes; keep admission order P0>P1>P2, never preempt a holder. m2 already carries a P1 admission; reconcile with it. Live proof: a fix refused with queue-cap while builds queue is admitted after.

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
