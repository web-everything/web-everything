---
bornAs: xw75lku
kind: story
size: 3
parent: "5488"
status: open
blockedBy: ["5487"]
scope: ["we:scripts/lib/daemon-self-sync.mjs", "we:scripts/lib/daemon-rebuild.mjs", "we:scripts/lib/daemon-overlays.mjs", "we:scripts/lib/__tests__/daemon-core-root.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Daemon self-sync and rebuild read a coreRoot setting instead of assuming the WE layout

Before any file moves into packages, daemon-self-sync, daemon-rebuild and daemon-overlays must find delivery code through one coreRoot setting rather than hardcoded WE checkout paths, so the package move and the later repo flip are a setting change for the running daemons.

## Acceptance

- [A1] **Executable** — a unit test sets coreRoot to a fixture layout and self-sync, rebuild and overlays resolve every file from it.
- [A2] With coreRoot unset, behaviour is unchanged (same paths as today); one live self-sync and one rebuild pass prove it.

## Non-goals

- [N1] Moving any file.
