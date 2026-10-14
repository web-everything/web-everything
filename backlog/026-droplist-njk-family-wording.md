---
kind: task
parent: "023"
status: resolved
dateOpened: '2026-06-02'
dateResolved: "2026-06-06"
tags:
  - docs
  - droplist
  - terminology
relatedReport: reports/2026-06-02-dropdown-trait-composition.md
crossRef:
  url: /blocks/droplist/
  label: droplist block page
---

# Fix we:droplist.njk: 'dropdown' family wording should say 'droplist'

we:src/_includes/block-descriptions/droplist.njk opens with "A 'dropdown' is not one behavior but a composition…" — the block is the abstract family, so that sentence should say 'droplist'. The dropdown is one concrete member.
