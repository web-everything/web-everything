---
bornAs: xct0rnw
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/__tests__/review-referral-hold.test.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/review-referral-hold.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add a planReconcile test that runs two consecutive ticks on the same head with a completed but un… (from web-everything/web-everything#4108 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#4108's review (reviewed head `0da175302a4d2565ec8d7d4fb6ac0ab802474d12`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/conveyor/reconcile-core.mjs:2158` — Add a planReconcile test that runs two consecutive ticks on the same head with a completed but unsuccessful fixer and expects the second tick to refuse. More durably, give every fix-dispatch branch an explicit attempts-per-head marker or counter, and add a lint or contract test asserting each `kind: 'fix'` branch derives its cap from a counter that its own dispatch can increment.
2. `we:scripts/conveyor/__tests__/review-referral-hold.test.mjs:410` — Add a contract test that every `mode:` value emitted by planReconcile's fix rows survives planFixesFromReconcile and reaches the dispatchFix payload prompt. Better, a gate that fails when a new dispatch-entry field is spread in planFixesFromReconcile without a test referencing it.
3. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:919` — Add one shared helper that flattens whitespace and truncates finding fields before they go into any fixer brief, and use it in both brief builders. Have a lint or test check that every brief builder interpolating finding.* calls it.
4. `we:scripts/conveyor/review-referral-hold.mjs:158` — A strict coverage gate enforcing branch coverage for newly added catch blocks to ensure error paths are exercised.
5. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:919` — A review rule or coverage gate requiring unit tests for all exported pure formatting functions.
6. `we:scripts/conveyor/review-referral-hold.mjs:192` — A lint rule or type enforcement ensuring that pipeline wrapper functions explicitly declare and pass down dependency injection parameters to their inner helpers.
7. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:919` — A unit test asserting the string output of `withBlockRuledReferrals` in a corresponding `we:reconcile-fix-dispatch.test.mjs` file.
8. `we:scripts/conveyor/__tests__/review-referral-hold.test.mjs:425` — Add a test case with multiple referrals (e.g., one ruled `block` and one pending) asserting that no fix is dispatched and the PR remains paused.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
