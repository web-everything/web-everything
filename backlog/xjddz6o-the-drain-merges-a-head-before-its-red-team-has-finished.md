---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# The drain merges a head before its red team has finished

[held entry 298] (coroner 2026-10-13, held) The drain merges a head before its red team has finished. #5165 merged 09:25 ET, red team confirmed a broken break at 09:30; #5238 merged 17:10, break at 17:15 (#5238 also turned main red, card 283). Fix idea: the drain/merge gate waits for the red-team row of the merging head when redTeamOwedFor says one is owed (timeout -> park, not merge); fast-track merges included. Evidence: scratchpad redteam/pr-states.tsv. Scope: we:scripts drain merge gate, we:review-extra-seats.mjs redTeamOwedFor. Size 2.

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
