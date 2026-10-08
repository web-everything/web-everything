---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/infra-blocked.mjs", "we:scripts/conveyor/__tests__/infra-blocked.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add '', false and [] to the fail-closed junk list in the parseInfraStore test. Alternatively, acc… (from web-everything/web-everything#4396 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/infra-blocked.mjs:183` — Add '', false and [] to the fail-closed junk list in the parseInfraStore test. Alternatively, accept only typeof number or numeric-string input and treat everything else as spent.
2. `we:scripts/conveyor/infra-blocked.mjs:413` — Add a deterministic regression test that changes the stored cause to a non-outage cause before calling the locked helper with the earlier outage classification, asserting no reset or budget increment.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4396@cd7e92cd242077d4eaca8cf85bedd1ae98d13743

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
