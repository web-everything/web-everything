---
bornAs: xvk1op7
kind: story
size: 3
status: open
scope: ["we:scripts/lib/drain-queue-safety.mjs", "we:scripts/lib/__tests__/drain-mq-retry-freeze-ejection.test.mjs"]
dateOpened: "2026-11-16"
tags: []
---

# Apply completeness, job-identity and shared-freeze checks to the ordinary freeze-HOLD retry path too

Reinforce-later (R952). The canonical audit noted that the pre-existing ordinary red-main freeze-HOLD same-head retry in we:scripts/lib/drain-queue-safety.mjs accepts a lone matching row without the completeness, merge-gate job/run identity, and shared-freeze checks the pending-rerun path now has. Not weakened by lane/mq-freeze-unreadable-retry; on main today.

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
