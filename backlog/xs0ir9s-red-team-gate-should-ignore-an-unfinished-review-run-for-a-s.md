---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/drain-red-team-evidence.mjs", "we:scripts/lib/__tests__/drain-red-team-evidence.test.mjs"]
dateOpened: "2026-11-12"
tags: []
---

# red-team gate should ignore an unfinished review run for a superseded head (held #6664 x117, #6684 x24 with 'review-unfinished')

The red-team evidence gate in we:scripts/lib/drain-red-team-evidence.mjs returns reason review-unfinished (failureFor, ~line 280) when any unfinished review run exists, even one started for a superseded head. Found live 2026-11-12: #6664 held 117 times and #6684 held 24 times on stale heads until an operator abstained the runs. The gate should only count an unfinished run for the head under evaluation.

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
