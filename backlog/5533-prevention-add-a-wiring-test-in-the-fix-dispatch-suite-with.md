---
bornAs: xnrpnxc
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/__tests__/delivery-priority-shadow.test.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a wiring test in the fix-dispatch suite with an injected priorityShadow spy that asserts it r… (from web-everything/web-everything#4543 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1459` — Add a wiring test in the fix-dispatch suite with an injected `priorityShadow` spy that asserts it receives `ranks` and `refusals`. In general, any new parameter threaded through an injected collaborator gets a spy assertion.
2. `we:scripts/conveyor/__tests__/delivery-priority-shadow.test.mjs:26` — Add a deterministic regression case with an admitted disjoint PR ranked ahead of a scope-refused waiter, asserting zero waiters; verify that removing the shared-path predicate makes that named test fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4543@d0a44ed1669346e9eabcc4abd16d925238727bf0

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
