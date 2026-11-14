---
bornAs: x0tdtd8
kind: task
status: open
scope: ["we:scripts/conveyor/fix-procedure.mjs", "we:scripts/conveyor/rearm-review.mjs"]
dateOpened: "2026-11-14"
tags: []
---

# Fixer that reports 'no change made' when the fix is already on the head should re-arm review

When a fixer returns 'no change made - fix still owed' but the fix IS already on the head (PRs #6770 and #6748), the PR stays review:changes forever (2026-11-13 23:24 ET). The empty-round guard should check whether the owed finding is resolved on the head, not only head movement since the send-back; a head that moved since the verdict being replied to re-arms review.

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

## Duplicate admission

Checked with capability-search and a backlog scan on 2026-11-14; no open card covers this exact change.
