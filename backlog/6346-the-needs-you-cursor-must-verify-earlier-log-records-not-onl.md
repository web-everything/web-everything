---
bornAs: x3kjugp
kind: story
size: 2
status: open
scope: ["we:scripts/operations/needs-you-feed.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# The needs-you cursor must verify earlier log records, not only its last one

Priority: expedite (operator 2026-10-18, from PR #5549's red-team advisory at head 71839ee, break 3, backlog card 6266 line 35). The cursor checks only its final record, so an actor with store-write access can rewrite earlier records (swap equal-length A for B, remove the appended B) and the rewrite check still passes; a short-lived override then expires unseen. The cursor check must cover the whole consumed log (for example a running hash over all records). Add a named test for the A/B swap scenario.

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
