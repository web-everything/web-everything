---
kind: story
size: 8
parent: "4703"
status: open
scope: ["we:scripts/operations/land-prevention-card.mjs", "we:scripts/operations/card-batch-file.mjs", "we:scripts/operations/card-batch-io.mjs", "we:scripts/lib/raised-by.mjs", "we:scripts/lib/card-batch-settings.mjs", "we:scripts/backlog/"]
dateOpened: "2026-10-20"
tags: []
---

# Rolling card batch: collect card-only changes into one PR per window

Most PRs are still card-only, even though the rolling batch from epic 4703 exists. Measured 2026-10-20: of the 200 PRs opened since 2026-10-18, 129 (65%) touch only backlog/. Of those, 83 are approval-time prevention PRs, 16 are prepares or refreshes, 28 are hand-written card PRs, and only 2 are card-batch PRs. Card 5360 alone was touched by 101 of those PRs. The leak: we:scripts/operations/land-prevention-card.mjs sends a filing to the batch only when it mentions no existing card (the mentioned.length === 0 branch). Any filing that adds an 'Also raised by' entry to an existing card, or writes a backlog/raised-by/ sidecar, still opens its own PR, with its own review, red team, queue slot and conflict on shared cards. Hand filings and prepares never use we:scripts/operations/card-batch-file.mjs at all. Proposal: every card-only writer appends to the one open batch ref per window, including edits to existing cards. Mentions merge with the 'Also raised by' union resolver (we:scripts/lib/raised-by.mjs) and the card-group union proofs from lane/hot-card-group*. Appends stay idempotent per source. A batch seals on the existing timer or count settings, gets one review and one red team, and refuses any non-backlog path. A writer that cannot append falls back to today's per-card PR. Settings use the existing cascade with the source logged. Open question for shaping: should prevention cards filed from a PR's review travel WITH that PR instead (fewer PRs, but the code PR grows)? Relation: this is creation-time; post-approval grouping (6532, xym8nt4) is merge-time. Overlaps slice 5196 (batch new filings). Suggested delivery: prototype, shadow first: for one day, compute what the batch would have held against the PRs actually opened.

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
