---
kind: task
status: open
scope: ["we:scripts/conveyor/fix-procedure.mjs", "we:scripts/conveyor/rearm-review.mjs"]
dateOpened: "2026-11-14"
tags: []
---

# A fixer round with no new commit must not re-arm review or count as a round

The fixer re-arms a PR for review without pushing a commit: on PR #6713 fix-6713 posted 'repaired and re-pushed' but the head stayed 4288acd6 and the owed test was never added. The empty round still counted against the round limit (2026-11-13 17:42 ET). A round with no new head commit should report 'no change made', stay owed, not re-arm review and not count. Red-first test.

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
