---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/takeover-review.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs", "we:scripts/conveyor/__tests__/takeover-review.test.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Prevention — Add a runReconcilePass wiring test with an injected loadReviewSettings that asserts the grant dis… (from web-everything/web-everything#4759 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#4759's review (reviewed head `78b9ff41c9b2c11b67412c40c970ddce402410f6`) to prevention-outstanding by naming a guard neither captured nor filed:
1. `we:scripts/conveyor/reconcile-pass.mjs:1365` — Add a runReconcilePass wiring test with an injected `loadReviewSettings` that asserts the grant dispatch. More generally, a check:standards rule: every planReconcile option with a pure-core default that differs from the built-in setting must have a runReconcilePass-level test.
2. `we:scripts/conveyor/takeover-review.mjs:65` — Add an allowance=2 case to we:takeover-review.test.mjs. Alternatively, cap the setting at 1 until reviews are counted per head or per round.
3. `we:scripts/conveyor/takeover-review.mjs:66` — Add a planner test where a granted review has no verdict (reviewer failure) and assert the bound still holds. Alternatively count the dispatch with a durable marker, as the rearm counter does.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 2 → #5848.

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
