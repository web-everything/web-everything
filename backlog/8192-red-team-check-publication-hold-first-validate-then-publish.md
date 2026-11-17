---
bornAs: x3pgjwn
kind: story
size: 5
status: open
dateOpened: "2026-11-13"
tags: []
related: ["6606"]
---

# red-team check publication: hold-first, validate-then-publish under one host lock; retry markers under the same lock

Design: red-team check publication must be hold-first, validate-then-publish under one host lock, with retry markers under the same lock. Evidence: PR 6606 two recurring red-team confirmed breaks, and its head 01ae38b11 shard 7 failure in we:scripts/operations/__tests__/review-job-rebase-carry.test.mjs (default publisher and on-skip recovery default publisher each got 2 entries, expected 1). 6606 used its final structural round (R88) and is parked.

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

#6606 final round: its two recurring red-team breaks plus the deterministic shard-7 failure share one cause

capability-search found no card for hold-first publication under one host lock
