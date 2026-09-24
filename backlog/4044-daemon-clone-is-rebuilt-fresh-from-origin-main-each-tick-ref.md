---
bornAs: xgomze7
kind: story
size: 3
parent: "3383"
status: open
blockedBy: ["4041"]
scope: ["we:scripts/lib/daemon-self-sync.mjs", "we:scripts/lib/__tests__/daemon-self-sync.test.mjs"]
dateOpened: "2026-09-23"
tags: []
---

# Daemon clone is rebuilt fresh from origin/main each tick, refusing to wipe local changes

Ruling #3681 Fork 4 sub-question, we:docs/agent/platform-decisions.md#resident-daemon-reload-lifecycle clause 4. Replace the merge-on-top form in we:scripts/lib/daemon-self-sync.mjs (the clone drifted 54 commits off main) with a rebuild: reset to origin/main, then merge each active overlay in order. Before any reset, refuse and alert if the tree has uncommitted changes or local commits that are in none of its inputs; never wipe them. Reset without clean until the pinned state root lands. Blocked on the per-clone lock so the tree never moves under a running tick.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
