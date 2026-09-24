---
bornAs: xlqampw
kind: story
size: 5
parent: "3383"
status: open
blockedBy: ["4044", "4043"]
relatedTo: ["3681", "3999"]
scope: ["we:scripts/lib/daemon-self-sync.mjs", "we:scripts/lib/__tests__/daemon-self-sync.test.mjs"]
dateOpened: "2026-09-23"
tags: []
---

# Live overlays: a daemon clone runs main plus a list of fix branches, each dropped once main has it

**Re-scoped 2026-09-23 by ruling #3681.** This card first asked for a "POC mode" (`DAEMON_SELF_SYNC_BRANCH`,
one clone tracking `lane/daemon-poc`). The ruling replaced that approach with **live overlays**
([we:docs/agent/platform-decisions.md#resident-daemon-reload-lifecycle](../docs/agent/platform-decisions.md#resident-daemon-reload-lifecycle)
clause 5). The POC-mode commit on `origin/lane/daemon-poc` (`69b2ec0cc`) is superseded and does not graduate.

Build the overlay core in `we:scripts/lib/daemon-self-sync.mjs`, on top of the rebuild form (4044):

- **Overlay list.** Each daemon clone reads an explicit list of overlay fix branches from a per-clone state
  file under its pinned state root (4052). The file is not checked in. An empty or missing list means plain
  `main`.
- **Rebuild.** Each tick the tree is rebuilt fresh: `origin/main`, then each overlay merged in, in list order.
- **Auto-drop once in main.** An overlay drops from the list when `git cherry origin/main origin/<overlay>`
  prints only `-` lines, or when its PR is merged or closed. With no overlays left, the daemon runs plain
  `main`.
- **Conflict = drop with an alert.** An overlay that no longer merges cleanly onto `main` (plus the overlays
  before it) is dropped from the list and an alert is raised. It is never frozen at an old head.
- **Rollback = remove the overlay** from the list; the next rebuild runs without it.
- The boot-input check (4050) counts each overlay head as an input, so adding, moving or dropping an
  overlay restarts the daemons in that clone.

Not in this card: the test gate before new overlay code is picked up, the drain / `merge-orphan-sweep`
carve-out, and the outside rollback trigger. Each has its own card under #3383 (see #3681's `## Ruling`).

## Done when

1. **Executable** — unit tests in `we:scripts/lib/__tests__/daemon-self-sync.test.mjs` cover: empty list →
   plain `main`; two overlays merged in order; an overlay whose `git cherry` is all `-` is dropped; an overlay
   whose PR is merged or closed is dropped; a conflicting overlay is dropped with an alert and the rest still
   apply.
