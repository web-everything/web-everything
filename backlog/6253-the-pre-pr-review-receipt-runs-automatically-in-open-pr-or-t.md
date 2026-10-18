---
bornAs: xgoj9po
kind: story
size: 3
status: open
scope: ["we:scripts/operations/open-pr.mjs", "we:scripts/operations/__tests__/open-pr.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# The pre-PR review receipt runs automatically in open-pr, or the advisory is dropped

Every worker PR on 2026-10-17 got the "pre-PR review receipt stale" advisory, and none produced a receipt. Either open-pr produces the receipt itself before opening, or the advisory is dropped so it stops being noise. Prefer the first; related cards 5361 and 5296. [A1] Executable: node --test we:scripts/operations/__tests__/open-pr.test.mjs shows an open-pr run leaves a fresh receipt and no stale advisory. Priority: top (operator 2026-10-17).

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
