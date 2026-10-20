---
bornAs: x4pif3w
kind: story
size: 2
status: open
scope: ["we:scripts/lib/drain-prestage.mjs", "we:scripts/lib/__tests__/drain-prestage.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# drain-prestage: cached admission must not survive changes to acceptance evidence (expedite)

TOP PRIORITY (expedite). Red-team break at we:scripts/lib/drain-prestage.mjs:95 (PR #5480): cached admission survives changes to the acceptance evidence. Scenario: a prestaged admission is cached, then the acceptance evidence (review label, head, or result) changes; the cached admission is still honored instead of being invalidated, so a PR can be admitted on stale evidence. Fix: key or invalidate the cache on the acceptance evidence and add tests for the changed-evidence case. Ruled EXPEDITE by the operator 2026-10-17 (Ok to all). [A1] Executable.

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
