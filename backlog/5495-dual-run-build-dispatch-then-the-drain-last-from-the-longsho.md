---
bornAs: xh1pxjn
kind: story
size: 5
parent: "5488"
status: open
blockedBy: ["5494"]
scope: ["we:scripts/daemons/shadow-compare.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Dual-run build-dispatch, then the drain last, from the Longshore mirror in shadow

Finish the one-role-at-a-time switch-over: build-dispatch, then the drain (com.plateau.drain-daemon) last, each shadowed by a WE-clone twin with journals compared for three days.

## Acceptance

- [A1] **Executable** — shadow-compare shows three days of matching actions for build-dispatch, then for the drain.
- [A2] The drain flips last; one PR lands end to end through the drain running from the Longshore clone.

## Non-goals

- [N1] Making the Longshore repo writable (the flip).
