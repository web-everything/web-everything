---
bornAs: x6yjnex
kind: story
size: 3
parent: "2610"
status: open
blockedBy: ["2776"]
scope: ["we:scripts/conveyor/", "we:scripts/memory-reflect.mjs", "we:scripts/pr-land.mjs"]
dateOpened: "2026-07-28"
tags: []
---

# Route accepted feedback suggestions into the learnings intake

Route a suggestion the owner accepted on the review screen into the learnings intake (red-team then lane then PR), the multi-tenant generalization of the single-tenant close-session sweep survivors path (we:scripts/conveyor/close-session-sweep.mjs) into the memory intake (we:scripts/memory-reflect.mjs) and the lane-to-PR transport (we:scripts/pr-land.mjs). Mostly greenfield glue over existing machinery; blockedBy the owner-review slice since it acts on reviewed and accepted items.

Ruled PARK in the master plan (2026-11-22); kept open with blockedBy #2776 instead, so it re-enters readiness when #2776 resolves.
