---
bornAs: xonio3f
kind: task
status: open
scope: ["we:scripts/operations/coroner-extract.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# health-watch records a cause line when no merge lands for 60 minutes; coroner ranks gaps by cause

coroner 2026-10-22: 8 merge gaps over 90 min in 54 h (203, 106, 194, 367, 176, 221, 156, 171 min; longest ended 10-22 07:31 ET) and only 71 merges against 622 in the prior 90 h, cause unknown. health-watch writes one cause line when no merge has landed for 60 min (red main, queue empty, all PRs held with hold reasons, host overload, daemon down); the coroner reads and ranks.

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
