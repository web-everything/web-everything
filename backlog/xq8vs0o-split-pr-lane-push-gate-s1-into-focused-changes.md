---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/fix-claim-store.mjs", "we:scripts/conveyor/fix-dispatch-claim.mjs", "we:scripts/conveyor/fix-procedure.mjs", "we:scripts/conveyor/soak/breaks/push-gate-hold-refusal.mjs", "we:scripts/lib/authorized-push.mjs", "we:scripts/lib/gh-throttle.mjs", "we:scripts/lib/protected-path-floor.mjs", "we:scripts/lib/review-hold-model.mjs", "we:scripts/lib/strict-utc-timestamp.mjs", "we:scripts/readiness/file-locks.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Split PR lane/push-gate-s1 into focused changes

size-split-key:4f786fb0d43d0d207e8c6e11780521dfd6ec192ae5491207d736bbfc6dcc91f3. Plan follow-up splits for PR lane/push-gate-s1. File groups: we:scripts/conveyor: 150; we:scripts/lib: 272; we:scripts/readiness: 33

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
