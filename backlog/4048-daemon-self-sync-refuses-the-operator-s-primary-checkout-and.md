---
bornAs: xlqazzv
kind: story
size: 2
parent: "3383"
status: open
scope: ["we:scripts/lib/daemon-self-sync.mjs", "we:scripts/lib/__tests__/daemon-self-sync.test.mjs", "we:skills-src/conveyor/launchd/"]
dateOpened: "2026-09-23"
tags: []
---

# Daemon self-sync refuses the operator's primary checkout and any non-designated clone

Ruling #3681 Fork 4 condition (i), we:docs/agent/platform-decisions.md#resident-daemon-reload-lifecycle clause 3. Lift the drain's decideSelfSyncAllowed guard (plateau:tools/drain-daemon/lib.mjs) into we:scripts/lib/daemon-self-sync.mjs: refuse to move a checkout that is the operator's primary (compared after resolving symlinks) and require the checkout to be the designated daemon clone. Ship the designated-root setting in the plist examples under we:skills-src/conveyor/launchd/ in the same change, or the guard silently turns self-sync off. Today the primary is safe only because it sits on a detached HEAD.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
