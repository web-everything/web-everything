---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Add a matrix row with an array that has a valid head, an array ciFailures and a nonempty reviewFi… (from web-everything/web-everything#7628 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:128` — Add a matrix row with an array that has a valid head, an array ciFailures and a nonempty reviewFindings. More generally, run a mutation check on closed-set guard predicates so each conjunct must redden a named case.
2. `we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs:3580` — For every eligible launch route, require a runReconcileFixDispatch test that asserts dispatch was called once and that the repair passed to readPushHold carries the route's evidence fields.
3. `we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs` — Extend the named landing test with a successful old-head check evaluated against a new head, assert refusal, and verify that removing head binding makes that test fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7628@29983b8b6d248de3a26fa6ae773e7ce685479360

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
