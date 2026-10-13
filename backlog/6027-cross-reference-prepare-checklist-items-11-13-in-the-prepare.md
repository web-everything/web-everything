---
bornAs: xj0j0lg
kind: task
status: open
dateOpened: "2026-10-13"
tags: []
---

# Cross-reference prepare checklist items 11-13 in the prepare-item agent brief (Could C of #4385)

Add one paragraph to we:skills-src/conveyor/prepare-item-agent-brief.md step 5 pointing at we:agent-memory-src/story-preparation-checklist.md items 11-13 (BLOCKER / SCOPE-GROWTH / NOT-AN-ISSUE, 2-round cap), so a dispatched prepare agent applies the cap without reading the memory file first. Mirror the paragraph already added to we:skills-src/conveyor/prepare-decision-agent-brief.md step 5 (Could B of we:backlog/4385). That brief's step 5 also says `## MVP`; the checklist's item 11 names `## Explicit MVP cut` as the heading form the #4438 lint reads — align the brief in the same edit.

## Acceptance

- [A1] **Executable** — counting the lines containing "story-preparation-checklist" in we:skills-src/conveyor/prepare-item-agent-brief.md gives 0 before and at least 1 after (the paragraph must name the checklist file on one line, so a re-wrap cannot hide it); `npm run check:standards` stays green.

## Non-goals

- [N1] No new enforcement script: classification stays manual judgment (the checklist's own framing).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: static prose, no runtime input.
2. **Truncated reads** — n/a: no `gh`/`git` read is added.
3. **Shared state files** — n/a: no state file or writer added.
4. **Fail closed** — the paragraph must repeat that an unclassifiable finding counts as BLOCKER.
5. **Identity scoping** — n/a: the paragraph adds no key; follow-ups cite the parent by `we:backlog/<NNN>`.
6. **State over time** — the paragraph must say rounds are recorded in the card's `## Progress` as they finish.
7. **Who wrote it** — n/a: the rule grants no trust to any comment or label.
