---
bornAs: xvxs2u3
kind: story
size: 3
parent: "3383"
status: open
scope: ["we:scripts/conveyor/queue-store.mjs", "we:scripts/conveyor/run-scorecard-store.mjs", "we:scripts/review-set-label.mjs", "we:skills-src/conveyor/launchd/"]
dateOpened: "2026-09-23"
tags: []
---

# Daemon state files live at a pinned root, not next to the script

Ruling #3681 Fork 4 condition (iii), we:docs/agent/platform-decisions.md#resident-daemon-reload-lifecycle clause 3; see also #state-lives-where-its-nature-dictates. State a daemon finds by script location moves to a root given by env or flag: the .conveyor/ queue (we:scripts/conveyor/queue-store.mjs) and the tracked scorecard file (SCORECARD_STORE_PATH in we:scripts/conveyor/run-scorecard-store.mjs, committed locally by we:scripts/review-set-label.mjs). Without this a rebuilt clone can wipe or fork state, and the staged dispatcher plist would read the daemon clone's queue instead of the operator's. The dispatcher plist is not installed until this lands. The per-clone overlay list lives under the same root.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
