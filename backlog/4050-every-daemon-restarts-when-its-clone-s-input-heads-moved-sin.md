---
bornAs: xt8j3yk
kind: story
size: 3
parent: "3383"
status: open
scope: ["we:scripts/lib/daemon-self-sync.mjs", "we:scripts/lib/__tests__/daemon-self-sync.test.mjs"]
dateOpened: "2026-09-23"
tags: []
---

# Every daemon restarts when its clone's input heads moved since boot, with a 5-minute floor

Ruling #3681 Fork 2, we:docs/agent/platform-decisions.md#resident-daemon-reload-lifecycle clause 2. At boot, withSelfSync in we:scripts/lib/daemon-self-sync.mjs records, per repo the daemon loads code from, the input heads its clone was built from (origin/main sha plus each active overlay head). Each tick it compares them with the clone's current inputs, whoever moved the clone, and exits for relaunch when they differ. Compare inputs, not HEAD, so a rebuild that re-merges an unchanged overlay does not loop. Add the drain's 5-minute restart floor (minRestartIntervalSec) counted from process start. Fixes the live gap where only the daemon that merged restarted.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
