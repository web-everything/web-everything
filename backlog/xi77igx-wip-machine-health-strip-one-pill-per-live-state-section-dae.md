---
kind: story
size: 3
parent: "3931"
status: active
blockedBy: ["xvz55jf"]
scope: ["plateau-app:src/wip/wip-view.ts", "plateau-app:src/wip/wip-read.ts", "plateau-app:src/wip/wip-live.ts", "plateau-app:src/wip/types.ts"]
dateOpened: "2026-09-26"
dateStarted: "2026-09-26"
tags: []
---

# /wip machine-health strip: one pill per live-state section (daemons, tests, lanes, drain, GitHub auth, load)

A compact strip at the top of the /wip page: one pill per live-state section, green/yellow/red, with a hover or expand for the one-line reason. Fed by the WE `live-state` operation's snapshot (card xvz55jf) the same way /wip already gets its other WE-sourced data — study plateau-app:src/wip/wip-publish.ts and plateau-app:src/wip/wip-read.ts for how WE data reaches the page. Publisher: the launchd job com.plateau.wip-publisher. Built in its own plateau-app lane (we:scripts/lane-pool.mjs acquire --repo=plateau-app), never editing the primary plateau-app checkout directly. Follows plateau-app's own repo-profile gate (its own npm test scripts), not WE's.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
