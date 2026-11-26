---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a deterministic dispatcher integration test with a nonempty overdue hold, asserting refusal,… (from web-everything/web-everything#7501 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:2271` — Add a deterministic dispatcher integration test with a nonempty overdue hold, asserting refusal, persisted clock, holder comment, and notification; verify that removing the production escalation call makes this named test fail.
2. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:2975` — Add a table-driven test over (holder state × file ordering) that pins the admit-or-hold outcome for every holder state, not just landing ones. Review lens: when a selection rule changes, list the downstream branches that consume its result.
3. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:2268` — Add a test that injects a throwing `write()` and asserts no throw plus the logged line. Consider a stateless fallback, such as using the waiter's `waitingSince` as a floor for the pair clock, or surfacing repeated write failures. Track as a backlog item.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7501@74b50bdfe208d8bf6e2ad02ac2e1ea32fad970b7

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
