---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/conveyor/__tests__/infra-cancelled.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Extract the pending-budget hold/escalate logic into one helper that both branches call, and add a… (from web-everything/web-everything#4669 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-core.mjs:2062` — Extract the pending-budget hold/escalate logic into one helper that both branches call, and add a table test over (fresh, stale, unreadable) pending states for every ci-timeout-rerun entry point.
2. `we:scripts/conveyor/reconcile-core.mjs:2058` — Require that at least one job in `timeoutRetry.jobs` maps to a name in `requiredChecks` (or filter the evidence to required names) in this branch, and add a negative test: BLOCKED, queued, cancelled check not in `requiredChecks`, expect `nothing-owed`.
3. `we:scripts/conveyor/__tests__/reconcile-core.test.mjs:3855` — Add a review-lens checklist item: every conjunct of a safety guard needs its own negative test. A mutation-testing gate over `we:scripts/conveyor/reconcile-core.mjs` would also catch it.
4. `we:scripts/conveyor/__tests__/infra-cancelled.test.mjs:203` — Add a deterministic unit test contrasting a missing suite ID with a populated suite ID and a lower check-run ID.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4669@1622272596f493a13f9ef4b3a6e03e2b84204606

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
