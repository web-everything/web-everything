---
kind: story
size: 3
status: open
scope: ["we:scripts/verify-lane.mjs"]
dateOpened: "2026-10-28"
tags: []
---

# verify-lane records RED for a file that fails identically on main

2026-10-28 10:04 ET. we:scripts/verify-lane.mjs ~:889-893: 'Comparing 1 failing file(s) outside the diff with origin/main' ran but still recorded RED for a file failing identically on main (we:scripts/lib/__tests__/fix-handoff.test.mjs, lane-11 cc84008e). If base failures are meant to be demoted, measureBaseFailures/baseFailures handling is broken: trace and fix; a main-red test blocks every lane's verify.

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
