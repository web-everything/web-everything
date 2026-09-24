---
bornAs: xlpy3qt
kind: story
size: 2
parent: "3383"
status: open
blockedBy: ["4002", "4045"]
scope: ["we:skills-src/conveyor/", "we:scripts/lib/daemon-self-sync.mjs"]
dateOpened: "2026-09-23"
tags: []
---

# Outside rollback removes an overlay that crash-loops or stalls a daemon

Ruling #3681, we:docs/agent/platform-decisions.md#resident-daemon-reload-lifecycle clause 5(d). New overlay code may crash at import, so the rollback cannot live inside it. The outside heartbeat check (4045) or the relaunch wrapper, on a crash loop or a stalled heartbeat right after an overlay change, removes that overlay from the clone's list and alerts. The next rebuild then runs without it. Re-adding the overlay is an explicit act.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
