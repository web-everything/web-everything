---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/takeover-budget.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/conveyor/__tests__/takeover-budget.test.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Prevention — Add a property-style test that, for every thread shape in the suite, asserts that when planTakeov… (from web-everything/web-everything#4779 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-core.mjs:1810` — Add a property-style test that, for every thread shape in the suite, asserts that when `planTakeover` returns `takeover-awaiting-review` and the grant refuses, the plan posts an operator note. Also add a timeout: after N ticks of `takeover-awaiting-review`, fall back to the operator note. File this as a backlog item.
2. `we:scripts/conveyor/takeover-budget.mjs:58` — Add a unit test pair for resolveTakeoverBudget: an unreadable or non-JSON repo file, and `fix` as a non-object, must both give value 0 with a '-invalid' source. Longer term, a shared settings-layer reader that returns a tri-state (absent/invalid/value), used by every fail-closed setting, would remove the class.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4779@256e68fff367eaf9ecb4917de52a1aceca799a5f

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
