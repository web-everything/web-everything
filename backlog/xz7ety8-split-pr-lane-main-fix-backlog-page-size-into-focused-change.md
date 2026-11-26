---
kind: story
size: 3
status: open
scope: ["we:docs/agent/testing/backlog-tile-chunks.md", "we:src/_data/backlogPrioChunks.js", "we:src/_data/backlogTileChunks.js", "we:src/_includes/backlog-prio-rows.njk", "we:src/_includes/backlog-tiles.njk", "we:src/_includes/backlog-tracked.njk", "we:src/assets/js/backlog-table-sort.js", "we:src/assets/js/home-display.js", "we:src/backlog-prio-rows.njk", "we:src/backlog-resolved-tiles.njk", "we:src/backlog-tracked-tiles.njk", "we:src/backlog.njk"]
dateOpened: "2026-11-25"
tags: []
---

# Split PR lane/main-fix-backlog-page-size into focused changes

size-split-key:58cb052f038dde27ed840122d933af0eddb6c2c4e1ae519892ac9c7ba4df16a2. Plan follow-up splits for PR lane/main-fix-backlog-page-size. File groups: we:docs/agent: 16; we:src/&#95;data: 39; we:src/&#95;includes: 65; we:src/assets: 275; we:src/backlog-prio-rows.njk: 11; we:src/backlog-resolved-tiles.njk: 11; we:src/backlog-tracked-tiles.njk: 11; we:src/backlog.njk: 34

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
