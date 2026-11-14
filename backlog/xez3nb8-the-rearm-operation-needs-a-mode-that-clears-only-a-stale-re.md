---
kind: task
status: open
scope: ["we:scripts/conveyor/rearm-review.mjs"]
dateOpened: "2026-11-14"
tags: []
---

# The rearm operation needs a mode that clears only a stale red-team:blocked and keeps an accepted verdict

The rearm operation on PR #6777 (review:accepted plus red-team:blocked) also dropped review:accepted and ready-to-merge, leaving review:pending and a full re-review (2026-11-13 19:24 ET). Add a mode that clears only a stale red-team:blocked and keeps the accepted verdict on the same head.

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
