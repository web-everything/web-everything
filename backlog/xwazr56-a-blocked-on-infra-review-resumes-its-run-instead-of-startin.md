---
kind: story
size: 3
status: open
scope: ["we:scripts/operations/review-loop-cli.mjs", "we:scripts/operations/review-job.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# A blocked-on-infra review resumes its run instead of starting fresh

Held item 223 follow-up: a review stopped blocked-on-infra on a failed juror seat now keeps its committed and saved seat answers (run.prefilledSeats, PR #4865), but the next review start opens a fresh run; review-loop-cli/review-job should find that run for the same head and --resume it. Held by #4777 at filing.

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
