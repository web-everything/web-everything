---
kind: task
parent: "5399"
status: open
scope: ["we:scripts/backlog/scaffold.mjs", "we:scripts/backlog/__tests__/scaffold.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Task agreement: new cards get the numbered Acceptance and Non-goals skeleton

Follow-up to S1 of #5399 (we:backlog/xj67z1d). The card skeleton in we:scripts/backlog/scaffold.mjs should emit renderTaskAgreementSkeleton() from we:scripts/backlog/task-agreement.mjs instead of the legacy Done-when block, keeping the two Hint lines under Acceptance, with we:scripts/backlog/__tests__/scaffold.test.mjs updated. Deferred from S1 only because PR #4463 held that file; start once that PR has landed or closed.

## Done when

1. **Executable** — `npm run test:unit -- we:scripts/backlog/__tests__/scaffold.test.mjs we:scripts/backlog/__tests__/task-agreement.test.mjs` passes with a test asserting a freshly rendered card reads back through `readTaskAgreement` with `acceptance-todo` and `non-goals-todo` problems and no `## Done when` heading (fails before: the skeleton still writes `## Done when`).

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
