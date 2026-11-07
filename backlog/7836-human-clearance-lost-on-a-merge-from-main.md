---
bornAs: xl1ghmj
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# Human clearance lost on a merge-from-main

MED priority hint. ## (held 2026-10-26 09:44 ET) Human clearance lost on a merge-from-main #5962: the operator cleared it at 06:53 on 8642c8b828. It then conflicted with main (#5961/#5948 merged), the fixer merged origin/main (e63e0cd28e), and the clearance was voided → needs-you again. The PR's own diff stat is unchanged; only conflict resolution changed. Fix: carry the clearance across a merge-from-main when the PR's net diff (vs the new base) equals the cleared diff modulo conflict-resolution hunks in files the PR already touched, and re-ask only if new files or new hunks appear. Show the resolution diff in the carry comment.

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
