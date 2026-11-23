---
bornAs: x27g4f0
kind: story
size: 2
parent: "3931"
status: open
locus: plateau-app
blockedBy: ["3932", "3934"]
dateOpened: "2026-09-22"
tags: []
---

# Carry a coarse agent summary on each /wip card in the snapshot — closed vocabulary only, stale-safe

`WipItem.agent` = `{role, state, phase, startedAt, runs}` in plateau:src/wip/types.ts, filled by plateau:src/wip/wip-read.ts shelling `agent-activity`, validated by the Worker snapshot schema, rendered as the L1 role · phase · rail. No free text is ever stored. Design: plateau:docs/wip-live-agent.md §2, §3.

## Done when

1. **Executable** — `npx vitest run src/wip` in plateau-app passes with new cases: the relay refuses a snapshot whose `agent.state` is outside the vocabulary or has an unknown field; the view renders a stale snapshot's agent line with "as of N min ago" and never as running; a failed `agents` source (new `WipSource`) renders `?`, never "No agent found".

Merged into plan step PD-LIVE (PL-WIP-CLEANUP, 2026-11-22).
