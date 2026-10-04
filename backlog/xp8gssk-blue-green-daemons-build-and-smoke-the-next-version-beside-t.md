---
kind: story
size: 8
parent: "3383"
status: open
scope: ["we:scripts/lib/daemon-rebuild.mjs", "we:scripts/lib/daemon-clone-lock.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# Blue-green daemons: build and smoke the next version beside the live one, then switch instantly

Operator direction 2026-10-03: two daemon code copies per role, blue (live) and green (next). Updates and edge overlays are built and smoke-tested in the idle copy with no reader lock, so they never wait for daemons to go quiet; the switch is a pointer flip, each daemon moves at its next pass boundary, and rollback is the same flip back. Builds on we:scripts/lib/daemon-rebuild.mjs (today: one clone, in-place move under a reader/writer lock). Covers: per-role pair of clones, an atomic 'current' pointer read by the launchd entry points, drain-safe switch (in-flight passes finish on their copy), automatic rollback when the new copy fails its first live passes, and health-watch reporting which colour is live. Done when: tests cover switch, rollback and in-flight safety; live: an update switches with no daemon pause longer than one pass, and a forced bad update rolls back automatically.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
