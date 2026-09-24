---
bornAs: x0o7184
kind: story
size: 2
parent: "3383"
status: open
scope: ["we:skills-src/conveyor/", "we:scripts/lib/daemon-self-sync.mjs"]
dateOpened: "2026-09-23"
tags: []
---

# Daemons restart via a request file read at the next safe point, never kickstart -k

Ruling #3681, we:docs/agent/platform-decisions.md#resident-daemon-reload-lifecycle clause 1. A launchctl kickstart -k mid-tick SIGKILLs a daemon stuck in a synchronous call, so its lease is never released and every relaunch fails until the TTL expires (seen twice on 2026-09-23). Add a daemon restart operation that drops a request file the daemon reads before its next tick and then exits cleanly. #3952 (dead-pid lease reclaim) is the companion prerequisite for daemons that were already killed hard.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
