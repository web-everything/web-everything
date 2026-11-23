---
bornAs: xn146t1
kind: story
size: 3
parent: "3931"
status: open
locus: plateau-app
dateOpened: "2026-09-22"
tags: []
---

# Add on-demand agent watches to the /wip relay — watch/unwatch, interest to the laptop, delta fan-out, nothing stored

plateau:wip-relay.js gains `watch`/`unwatch` from pages (stored in each socket attachment, so hibernation-safe), sends the laptop `interest {l1, cards}` when the union changes, fans `agent-delta` out only to watching pages, and adds `agent-step` to the closed ASKS list. Bounds: 16 KB per delta, 3 card watches per page, 6 overall. Design: plateau:docs/wip-live-agent.md §3.

## Done when

1. **Executable** — the relay unit tests in plateau-app (plateau:scripts/wip-relay.test.mjs under `npx vitest run`) cover: no page open → the laptop receives `interest {l1:false, cards:[]}`; two pages watching different cards → the union; after a simulated hibernation wake the union is rebuilt from attachments; an `agent-delta` over 16 KB is dropped; a 4th card watch from one page is refused; the `snap` table is unchanged after 100 deltas.

Merged into plan step PD-LIVE (PL-WIP-CLEANUP, 2026-11-22).
