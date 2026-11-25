---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/__tests__/scope-overlap-aging.test.mjs", "we:scripts/conveyor/__tests__/landing-holder-blocked-state.test.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add one integration test of runReconcileFixDispatch with an injected landing holder and an aged p… (from web-everything/web-everything#7501 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:2268` — Add one integration test of runReconcileFixDispatch with an injected landing holder and an aged pair clock. Assert one post and one notify when live, none under dryRun or notesDryRun, and no throw when write fails. A review lens could also require every new output field of a pure planner to have a shell-level consumer test.
2. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:2250` — Add an integration-level test that builds landingHolders through `runReconcileFixDispatch` with a failing holder-state reader. Also fall back to `holderEntries.get(pr).headRefOid` (already carried on the entry) when `stateFor` yields no head. A cheaper guard is a lens rule: any 'fail closed' claim needs a test that goes through the real producer of the input.
3. `we:scripts/conveyor/__tests__/scope-overlap-aging.test.mjs:108` — Extend the named null-age test with an empty-planned assertion and run it in the existing test gate.
4. `we:scripts/conveyor/__tests__/landing-holder-blocked-state.test.mjs:22` — Add a deterministic regression test connecting missing/corrupt persisted history to an aged waiter's dispatch refusal, with a mutation that removes protection only when the pair clock is absent.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7501@e5d1ea4e89c3ad97d913a8bfb134cc2bd940c57a

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
