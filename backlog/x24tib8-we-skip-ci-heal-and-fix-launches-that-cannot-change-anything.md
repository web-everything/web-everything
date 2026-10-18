---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/operations/ci-heal-pr-dispatch.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# we: Skip ci-heal and fix launches that cannot change anything

Why: 20 of 181 fix outcomes in the window (11%) were no-change, on 11 PRs. 9 launches (7 no-change, 2 failed) were a ci-heal started on the intentional review:pending hold, or on a PR with no failing check. 18 extra passes repeated a PR and head that already had an outcome (16 cases). Change: skip the ci-heal or fix launch when the only failure is review-gate on review:pending, when there is no failing check, or when the PR and head already have an outcome. Scope: we:scripts/conveyor/reconcile-fix-dispatch.mjs and we:scripts/operations/ci-heal-pr-dispatch.mjs. Edge cases to handle: when the hold clears, the launch must be admitted again; a new head is not a repeat.

[A1] Executable: npx vitest run we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs

## Acceptance

- [A1] **Executable** — a new test in we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs asserts no launch when the only failure is review-gate on review:pending, when no check is failing, or when the PR and head already have an outcome. It fails before this lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the review hold itself or the ci-heal retry cap. Does not skip a launch when a check is actually failing on a new head.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — check names are matched exactly, never by free-text search of PR bodies or comments.
2. **Truncated reads** — if the check list or the outcome ledger cannot be read in full, the skip does not fire and the launch proceeds as it does today.
3. **Shared state files** — the skip reads the outcome ledger and writes nothing new to it.
4. **Fail closed** — a skip needs positive evidence. A read error means launch, not skip.
5. **Identity scoping** — n/a: the skip is decided per PR and head, not per user or session.
6. **State over time** — a new head is never a repeat. When the review hold clears, the launch is admitted again.
7. **Who wrote it** — n/a: each skip is logged to the existing dispatch log with its reason.
