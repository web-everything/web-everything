---
bornAs: xibzioo
kind: story
size: 3
parent: "3383"
status: open
blockedBy: ["4002"]
scope: ["we:scripts/lib/daemon-self-sync.mjs", "we:scripts/lib/__tests__/daemon-self-sync.test.mjs"]
dateOpened: "2026-09-23"
tags: []
---

# Tests pass on the rebuilt tree before a daemon picks up new overlay code

Ruling #3681, we:docs/agent/platform-decisions.md#resident-daemon-reload-lifecycle clause 5(a). Before the live clone moves to a new overlay head, rebuild main plus the overlays in a scratch worktree and run the daemon's own tests there. Move the live clone only if they pass; otherwise keep the current tree and alert. This is the gate that would have stopped the 2026-09-23 lane-pool hang (an unreviewed commit hand-merged into wev-review-daemon).

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
