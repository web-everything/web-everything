---
bornAs: xmiknhd
kind: story
size: 2
parent: "3383"
status: open
blockedBy: ["4002"]
scope: ["we:scripts/lib/daemon-self-sync.mjs", "we:skills-src/conveyor/daemon-manifest.mjs", "we:skills-src/conveyor/launchd/"]
dateOpened: "2026-09-23"
tags: []
---

# Drain and merge-orphan-sweep never run overlays and never share a clone that does

Ruling #3681, we:docs/agent/platform-decisions.md#resident-daemon-reload-lifecycle clause 5(e). The daemons that merge to main stay main-only: the drain daemon and the merge-orphan-sweep pass (it runs we:scripts/merge-ai-prs.mjs, listed in we:skills-src/conveyor/daemon-manifest.mjs). Refuse a non-empty overlay list in code for a caller that merges to main, and move merge-orphan-sweep out of the shared wev-review-daemon clone (which may now run overlays) into a main-only clone. The drain side reads the same refusal from the WE helper it already loads.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
