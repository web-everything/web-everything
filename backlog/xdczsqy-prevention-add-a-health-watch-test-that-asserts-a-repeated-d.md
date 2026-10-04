---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/operations/dispatch-lane-io.mjs", "we:scripts/conveyor/fixer-ladder.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs", "we:scripts/operations/__tests__/dispatch-lane-io.test.mjs", "we:scripts/conveyor/__tests__/fixer-ladder.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Add a health-watch test that asserts a repeated dispatch-env-fault refusal on one PR across N pas… (from web-everything/web-everything#3957 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:989` — Add a health-watch test that asserts a repeated `dispatch-env-fault` refusal on one PR across N passes raises an alert. Alternatively, have the notice catch re-kind only after classifying the error as transient, as `isTrustRefusal` does, and let a permanent error surface as `dispatch-failed`.
2. `we:scripts/operations/dispatch-lane-io.mjs:2240` — Establish a shared serialization protocol for configuration writes and add a deterministic two-writer regression test covering both write orders, including an update between read and replacement.
3. `we:scripts/conveyor/fixer-ladder.mjs:51` — Reject non-Claude dispatch rungs with null taskType during deterministic policy validation, and test provider overrides with both omitted and explicit taskType values.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3957@eefecd8d1a089acf9ed2ba5778fa24ae2845a02b

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
