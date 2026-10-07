---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/pr-merge-gate.mjs", "we:scripts/lib/__tests__/pr-merge-gate.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add table rows where head is omitted and coverage.headSha is missing, and decide the intended out… (from web-everything/web-everything#4328 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/pr-merge-gate.mjs:319` — Add table rows where `head` is omitted and `coverage.headSha` is missing, and decide the intended outcome: hold or defer when the head can't be verified, at least under `ledger`. A pure-function property test, 'clear implies head and coverage both present and equal', would also guard this class.
2. `we:scripts/lib/pr-merge-gate.mjs:322` — Add table rows for a clearing ledger with head=null and with coverage.headSha absent, in `both` and `ledger` modes. Make the code treat a missing sha as a defer or a hold, whichever the statute prefers. A deterministic option is a lint or test rule that every gate predicate has an 'unknown input' row.
3. `we:scripts/lib/pr-merge-gate.mjs:317` — Add a test row with a malformed `holds` value and wrap the unreadable check with `Array.isArray`, treating anything else as unreadable.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4328@6471e698edcab06fd605a9e34c3b8c2d082f58ab

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
