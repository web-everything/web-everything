---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/__tests__/referral-hold-auto-resolve.test.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — A check that compares the PR's declared Files and prep Scope against the net changed set and fail… (from web-everything/web-everything#7564 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-core.mjs:1832` — A check that compares the PR's declared Files and prep Scope against the net changed set and fails on an undeclared source file. This extends an existing scope-declaration gate rather than adding a lens.
2. `we:scripts/conveyor/__tests__/referral-hold-auto-resolve.test.mjs:590` — Add a soak-break scenario that stacks N uncounted failed runs on one head and asserts the dispatch count stays at or below a fixed bound. Then add a check:standards rule requiring a bounded-termination assertion for any new auto-dispatch path.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7564@95effc63cbd81dd50f7c1cbff1bafd9f87395413

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
