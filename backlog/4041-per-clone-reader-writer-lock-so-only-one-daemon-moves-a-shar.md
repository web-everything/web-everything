---
bornAs: x3ecgta
kind: story
size: 3
parent: "3383"
status: active
scope: ["we:scripts/lib/daemon-self-sync.mjs", "we:scripts/lib/__tests__/daemon-self-sync.test.mjs"]
dateOpened: "2026-09-23"
dateStarted: "2026-09-24"
tags: []
---

# Per-clone reader/writer lock so only one daemon moves a shared clone

Ruling #3681 Fork 4 condition (ii), we:docs/agent/platform-decisions.md#resident-daemon-reload-lifecycle clause 3. Several daemons share one clone (wev-review-daemon). Each tick takes a shared hold on its clone; the one process that moves the clone takes an exclusive hold, so the tree never moves under a running tick or its children and two daemons never git-merge the same tree at once. A lock failure must not be treated as a merge conflict (today its merge --abort can undo another daemon's merge). Other daemons see the inputs move and restart via the boot-input check.

## Done when

1. **Executable** — `npx vitest run we:scripts/lib/__tests__/daemon-self-sync.test.mjs`: 22 of 60 cases (every
   case naming `acquireCloneTickLock`/`acquireCloneMoveLock`/`decideTickLockGate`/`decideMoveLockGate`) fail
   with `TypeError: ... is not a function` before this item lands (those exports do not exist yet) and all 60
   pass after. PR body also carries a standalone before/after repro (two simulated daemons, one real shared
   git clone): merged `merged:true` while a sibling is mid-tick BEFORE, `tick-in-progress` refusal + a stable
   tree AFTER, plus a same-host dead-pid lease reclaimed at once rather than waiting the 15-minute TTL.
