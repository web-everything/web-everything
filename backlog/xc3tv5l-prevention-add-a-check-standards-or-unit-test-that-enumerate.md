---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/operations/review-pr.mjs", "we:scripts/operations/__tests__/review-pr.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add a check:standards or unit test that enumerates every = *Cap comparison in planReconcile and a… (from web-everything/web-everything#4053 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-core.mjs:2077` — Add a check:standards or unit test that enumerates every `>= *Cap` comparison in planReconcile and asserts each is either extended by roundExtensions or on an explicit exemption list.
2. `we:scripts/conveyor/__tests__/reconcile-core.test.mjs:1933` — Make the tests table-driven over every cap kind (review/fix, advisory-fix, conflict-fix, stacked-rebase) so adding a cap forces a row.
3. `we:scripts/conveyor/__tests__/reconcile-core.test.mjs:1933` — Add a table-driven test over every cap kind (review/fix, advisory-fix, conflict-fix, stacked-rebase). Each case would assert that an operator grant extends the cap, an automation-authored grant does not, and any absolute ceiling still holds. A lint that flags a `*FixCap` identifier used in planReconcile without the `Here` extension would also catch it.
4. `we:scripts/operations/review-pr.mjs:2539` — Add a deterministic regression test with identical file and summary values at different lines, blocking only one referral and asserting that the other remains deferred; preserve full referral identity when matching.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4053@a0115540b6dcf743a7aac2c67b4580beaa944b55

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
