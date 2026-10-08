---
kind: story
size: 5
parent: "xpd5nhi"
status: open
blockedBy: ["x2cpivn", "x0ymykb", "xizfs72"]
scope: ["we:backlog/**", "we:scripts/backlog/move-by-topic.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Move backlog cards by topic into each repo, resolved included, with old numbers kept as aliases

Rulings S1 and S7: one backlog per repo, cards moved by topic (delivery to Longshore, product to plateau-app, FUI to frontierui), resolved cards included, bornAs kept and the old number recorded as formerly. Cross-repo epics use locus-qualified parents; the resolve guard reads sibling repos through the repo registry.

## Acceptance

- [A1] **Executable** — a count check: cards before the move equal the sum of cards in WE, Longshore, plateau-app and frontierui after.
- [A2] Every old `/backlog/N` link resolves (stub or page).
- [A3] `/next` and the conveyor pick items in each repo; a cross-repo epic's no-open-child guard reads children in sibling repos.
- [A4] Resolved cards move too (ruling S7); bornAs is unchanged so ledgers and run records still join.

## Non-goals

- [N1] A hosted combined index in Plateau (optional, ruling S1).
