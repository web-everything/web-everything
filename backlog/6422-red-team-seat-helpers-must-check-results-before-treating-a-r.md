---
bornAs: x8upf00
kind: story
size: 3
priority: high
parent: "4075"
status: open
scope: ["we:scripts/operations/review-extra-seats.mjs", "we:scripts/operations/__tests__/review-extra-seats.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Red-team seat helpers must check results before treating a row as proof

we:scripts/operations/review-extra-seats.mjs helpers (priorRedTeamRow, redTeamAlreadyRan, missRowRecorded, redTeamCommentPosted) consume persisted rows/comments without validating shape or head/run binding, so a malformed or foreign row can stand in for a red-team that ran. Validate each helper input and fail closed.

## Acceptance

- [A1] Executable: we:scripts/operations/__tests__/review-extra-seats.test.mjs — priorRedTeamRow, redTeamAlreadyRan, missRowRecorded and redTeamCommentPosted given malformed, wrong-head, wrong-run or foreign-author inputs must not count as proof; red before: such rows are accepted.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the 7 approved prototype relaxations or other guards; fixes only this gap, which is already present on main (pre-existing gap, expedited).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — comment bodies are matched only from a trusted author's marker.
2. **Truncated reads** — a truncated or non-array record list counts as no proof.
3. **Shared state files** — the seat store is read-only here.
4. **Fail closed** — any unreadable or malformed row means not proven, so the red team runs.
5. **Identity scoping** — rows are bound to the exact (pr, head, run).
6. **State over time** — a row for an earlier head never stands for the current head.
7. **Who wrote it** — only trusted principals' markers count.
