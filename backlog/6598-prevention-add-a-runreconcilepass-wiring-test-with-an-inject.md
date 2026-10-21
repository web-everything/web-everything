---
bornAs: xjw2wtl
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/__tests__/stale-ci-rerun.test.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Add a runReconcilePass wiring test with an injected setting loader. Alternatively, make the core… (from web-everything/web-everything#5294 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-pass.mjs:1533` — Add a runReconcilePass wiring test with an injected setting loader. Alternatively, make the core `staleCiRerun` parameter required, so an omitted argument fails loudly instead of defaulting to 'off'.
2. `we:scripts/conveyor/reconcile-pass.mjs:798` — Gate the new evidence on the same `enabled` flag as enrichPrsWithTimeoutEvidence, and add a test that sets the flag to '0' and asserts no ci-timeout-rerun is planned.
3. `we:scripts/conveyor/__tests__/stale-ci-rerun.test.mjs:34` — Add stale-ci-rerun cases with `owedCiRerunRetry.head` set to a different value and `pr` set to a different number, expecting no dispatch. Add a runReconcilePass test with an injected `loadStaleCiRerunSetting` that asserts the planner receives it.
4. `we:scripts/conveyor/reconcile-pass.mjs:183` — Extend the resolver's invalid-value parameterized test to include null and other non-string JSON values, asserting off, and run it as a deterministic test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5294@58f61831a9aafdb173b499e6fa104842af260822

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
