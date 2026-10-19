---
bornAs: xq91hk5
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/parked-pr-conflict-watch.mjs"]
dateOpened: "2026-10-19"
tags: []
---

# parked-pr-conflict-watch: two silent-failure gaps on main (attempt marker, comment read)

Two pre-existing gaps in we:scripts/conveyor/parked-pr-conflict-watch.mjs on main. (1) The best-effort attempt-marker write (around line 1934, postComment of UNOWNED_REBASE_ATTEMPT_MARKER inside a try with an empty catch) swallows a failure, so that attempt goes uncounted and the attempt cap can be exceeded. (2) A comment-read failure sets existingComments to [] (around line 1867), which makes every marker dedup and the attempt count read as zero. Make both failures counted and visible (record an owed retry, and skip the dedup-dependent write on an unreadable thread), with a named test for each.

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
