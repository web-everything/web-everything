---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/__tests__/stale-ci-rerun.test.mjs", "we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Add a planner invariant test: any refusal that continues past ci-heal must either carry an expiry… (from web-everything/web-everything#5294 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-core.mjs:3020` — Add a planner invariant test: any refusal that `continue`s past ci-heal must either carry an expiry or surface an operator note. A lint on `refuse('...in-flight')` sites without a window check would enforce it.
2. `we:scripts/conveyor/__tests__/stale-ci-rerun.test.mjs:33` — A shared parametrized 'evidence binding' test helper that every mechanical re-run branch must call, so a new branch cannot skip it.
3. `we:scripts/conveyor/reconcile-pass.mjs:1371` — An integration test through `hydrateChecks` into `planReconcile` for each fail-closed signal. A lint rule that flags planner inputs set only by the IO shell and never by a shell test is the stronger gate.
4. `we:scripts/conveyor/reconcile-pass.mjs:1371` — Add a deterministic reconcile-pass regression test covering refused and truncated hydration with a retained failed check, asserting that both mechanical rerun and heal dispatches are absent.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5294@c1d3f80ed9c95aa09b057fabb15b6891b71e141e

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
