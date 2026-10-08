---
bornAs: xizfs72
kind: story
size: 3
parent: "5488"
status: open
blockedBy: ["3533"]
scope: ["we:scripts/backlog/frontmatter.mjs", "we:scripts/backlog/id.mjs", "we:src/_data/backlog.js", "we:src/backlog-redirects.njk"]
dateOpened: "2026-10-08"
tags: []
---

# Backlog cards carry a formerly alias and WE /backlog serves redirect stubs for moved ids

Before any card moves (ruling S7), teach the backlog model a formerly: field (for example formerly: we:#5407) and make the WE /backlog site render a redirect stub for every id that moved to another repo, so old links keep working. Needs locus-qualified ids first.

## Acceptance

- [A1] **Executable** — a card with `formerly: we:#5407` validates, and the WE `/backlog/5407/` page renders a redirect stub to its new home.
- [A2] All existing cards still validate and `/backlog` renders the same pages.

## Non-goals

- [N1] Moving any card.
