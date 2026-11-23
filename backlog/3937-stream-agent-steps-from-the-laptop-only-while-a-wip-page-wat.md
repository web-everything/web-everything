---
bornAs: xd47p14
kind: story
size: 3
parent: "3931"
status: open
locus: plateau-app
blockedBy: ["3932", "3934", "3933"]
dateOpened: "2026-09-22"
tags: []
---

# Stream agent steps from the laptop only while a /wip page watches — deltas with sequence numbers, full frame on re-watch

plateau:src/wip/wip-agent.ts handles `interest`, tails the watched runs through `agent-activity`, sends L1 deltas (coalesced, at most one per 2 s) and per-card deltas with consecutive `seq`, a `base` full frame on (re-)watch, and re-asks `interest?` every 30 s. Empty interest → no tailing. Design: plateau:docs/wip-live-agent.md §3.

## Done when

1. **Executable** — plateau:src/wip/wip-agent.test.ts under `npx vitest run`, with a fake clock: with no interest the agent-activity reader is not called beyond the snapshot cycle; interest in card N gives a `base: true` frame then deltas with consecutive `seq`; a re-watch after a gap gives a fresh full frame; a burst of 50 steps produces at most one L1 message per 2 s.

Merged into plan step PD-LIVE (PL-WIP-CLEANUP, 2026-11-22).
