---
bornAs: xym8nt4
kind: story
size: 8
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/", "we:scripts/conveyor/"]
dateOpened: "2026-10-19"
tags: []
---

# Post-approval grouping: land several approved PRs as one combined branch

What it does: after approval, the drain groups approved PRs that touch the same files (card-only first) into ONE combined branch on current main. Their changes are merged with the card resolver's union of 'Also raised by' lists, then land as a single queue entry. Safety: CI reruns on the combined branch. On failure, the group dissolves back into individual PRs and nothing is lost. Each original PR keeps its approval record and is closed pointing at the combined PR. Code PRs are excluded at first. Settings: drain.group.maxSize, drain.group.eligibility, and an enable switch, each with its source logged. Evidence, 2026-10-19: card PRs sharing cards (backlog/5125, 5360, 5473, ...) are serialized by queue-file-overlap. In one drain pass 46 of 47 candidates were skipped behind one queued PR (#5640); merges run about 1-2 per pass. Related: card xf0q813 (#5715), the derived 'Also raised by' list, removes most collisions, so measure after it lands. Collector decision x5ioz96 batches cards before they become PRs; this is the post-approval counterpart. Delivery-modes epic xc4ft34.

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
