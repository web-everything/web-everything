---
bornAs: x8kenvp
kind: task
parent: "3383"
status: open
blockedBy: ["3998", "4002"]
scope: ["we:scripts/lib/poc-branches.json", "we:backlog/3999-graduate-lane-daemon-poc-to-main.md"]
dateOpened: "2026-09-23"
tags: []
---

# Retire lane/daemon-poc now that daemons use live overlays

Ruling #3681 superseded the long-lived POC-branch approach for daemons (we:docs/agent/platform-decisions.md#resident-daemon-reload-lifecycle clause 5(g)). Wind down origin/lane/daemon-poc under its tracking epic 3999: its pass-daemon self-sync commit graduates through 3998; its POC-mode commit (69b2ec0cc) is dropped as superseded by the overlay card 4002; its session-note commit needs no graduation. Then remove the lane/daemon-poc entry from we:scripts/lib/poc-branches.json and resolve 3999 with a note naming what was dropped.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
