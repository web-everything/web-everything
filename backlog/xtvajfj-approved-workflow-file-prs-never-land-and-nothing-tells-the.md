---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Approved workflow-file PRs never land, and nothing tells the operator

[held entry 334] (operator ok 2026-10-14 ~16:50 ET, held, HIGH) Approved workflow-file PRs never land, and nothing tells the operator. The drain refuses to enqueue a we:.github/workflows change ("only a person may land", correct guard). #5193 (8 refusals), #5253 and #5298 sat approved and silent; #5169 waited on #5298. Fix idea: operator-queue NEEDS YOU gets a "needs your merge" row (approved, all required checks green on head, workflow file touched), with the one-click enqueue command; operator status notes it. Keep the guard. Prove: #5298-style PR appears in NEEDS YOU as needs-your-merge.

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
