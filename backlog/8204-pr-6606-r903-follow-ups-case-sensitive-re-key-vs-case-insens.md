---
bornAs: xl7lsq1
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-13"
tags: []
---

# PR 6606 R903 follow-ups: case-sensitive re-key vs case-insensitive MARKER_RE, lock-identity case test, remoteHold cleanup, comment-retrieval and fail-closed outbox tests

Salvaged card xlvsnf3 (carried from PR 6606 round 10 under R903, not regressions): (1) case-sensitive re-key vs case-insensitive MARKER_RE; (2) case-insensitive lock-identity test; (3) remoteHold cleanup; (4) complete-comment-retrieval test; (5) fail-closed outbox tests. Also: file-item should refuse a lane release while a card is uncommitted.

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

capability-search found no matching open card
