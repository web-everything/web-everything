---
bornAs: xxgbekk
kind: task
status: open
dateOpened: "2026-10-13"
tags: []
---

# Supply reviewRounds and scopeGrowthCount to prepare ratings (producer for #4385 Could A)

we:scripts/conveyor/run-rating.mjs `toScorecardRow` now passes `reviewRounds` and `scopeGrowthCount` through on a prepare row (we:backlog/4385, Could A), but nothing sets them, so they read null. Add the producer: read the round count and SCOPE-GROWTH finding count that item 13 of we:agent-memory-src/story-preparation-checklist.md has a prepare pass record in the card's `## Progress`, and put them on the rating. Coordinate with we:backlog/4304 (record whether an item was prepared).

## Acceptance

- [A1] **Executable** — a unit test in we:scripts/conveyor/__tests__/run-rating.test.mjs builds a rating for a prepared card whose Progress records two rounds and one SCOPE-GROWTH finding, and the resulting row carries `reviewRounds: 2` and `scopeGrowthCount: 1`; it fails before the producer exists.

## Non-goals

- [N1] No change to the scorecard store schema: it already passes extra fields through.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the Progress text is card prose: parse only integers, never copy text into the row.
2. **Truncated reads** — n/a: a local card file, read whole.
3. **Shared state files** — n/a: reads the card only; the store's own append lock is unchanged.
4. **Fail closed** — an unparseable or missing record yields null, never 0.
5. **Identity scoping** — the count is read from the rated item's own card, by number or `bornAs` hash.
6. **State over time** — a re-prepare under a new `preparedAgainstSha` starts a new count; read only the latest pass.
7. **Who wrote it** — n/a: the count grants no trust to anything.
