---
kind: story
size: 5
parent: "xpd5nhi"
status: open
blockedBy: ["x2cpivn"]
scope: ["we:skills-src/**", "we:docs/agent/**", "we:agent-memory-src/**"]
dateOpened: "2026-10-08"
tags: []
---

# Split skills, agent docs and agent memory by topic into Longshore and plateau-app

Plan step 8, second half: skills-src, docs/agent and agent-memory-src split by the same topic rule as the cards (about 93 memory entries and most delivery skills go to Longshore), with pointers left in WE so agents still find them.

## Acceptance

- [A1] **Executable** — skill deploy from each repo installs the same skill set as before the split (diff of the deployed list is empty).
- [A2] Agent memory and `docs/agent` entries that moved leave a one-line pointer in WE.

## Non-goals

- [N1] Rewriting the content of any skill or memory entry.
