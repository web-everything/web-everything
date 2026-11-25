---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a planner test with pendingSince slightly after now that expects the in-flight hold, and appl… (from web-everything/web-everything#7463 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-core.mjs:3190` — Add a planner test with `pendingSince` slightly after `now` that expects the in-flight hold, and apply a bounded skew tolerance (or compare against a clock read after enrichment).
2. `we:scripts/conveyor/reconcile-core.mjs:3183` — Add a table-driven planner test that runs the unstamped, unreadable and old-live markers through each of the three `timeoutRepairOwed` arms.
3. `we:scripts/conveyor/reconcile-core.mjs:3181` — Add a table-driven planner test with one pending-marker escalation case per `timeoutRepairOwed` disjunct, including queued plus codeqlFailure. A diff-scoped mutation check on compound guard conditions would catch the wider class.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7463@bac8284034c8692551a4c63eca195e303a826ac8

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
