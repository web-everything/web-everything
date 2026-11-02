---
bornAs: x4dslss
kind: story
size: 2
status: open
scope: ["we:verify-lane.mjs", "we:fix-handoff.test.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# we:verify-lane.mjs ~:889-893

MED priority hint. - (2026-10-28 10:04 ET) we:verify-lane.mjs ~:889-893: 'Comparing 1 failing file(s) outside the diff with origin/main' ran but still recorded RED for a file that fails identically on main (we:fix-handoff.test.mjs, lane-11 cc84008e). If base failures are meant to be demoted, measureBaseFailures/baseFailures handling is broken — trace + fix; a main-red test blocks every lane's verify. → filed as xo4ukyk in PR #6034

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
