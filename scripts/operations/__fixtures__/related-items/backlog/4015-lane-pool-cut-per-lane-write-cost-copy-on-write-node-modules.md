---
bornAs: x6oeb4m
kind: story
size: 5
status: open
blockedBy: ["4000"]
scope: ["we:scripts/lane-pool.mjs"]
dateOpened: "2026-09-23"
tags: []
---

# Lane pool: cut per-lane write cost - copy-on-write node_modules template and git object hygiene

Observed 2026-09-23: 52 WE lanes ran a fresh npm ci in one day with package-lock unchanged for a week (fresh clones, not lockfile bumps) - each ~18.8k files / 463MB; 17 lanes exceed git's gc.auto loose-object threshold (lane-27: 8,584 loose, 6,946 prunable); and the shared alternates object store (the main checkout .git) sat 11h behind origin, so every lane fetched objects into its own .git. Together this fed fseventsd ~100% CPU. Plan: (1) cheap deps - we:scripts/lane-pool.mjs#ensureDeps populates node_modules via APFS copy-on-write (cp -Rc) from a template dir keyed by the lockfile hash (the same hash depsReady/lockHash already compute), falling back to npm ci when the template is missing or the clone fails; (2) git hygiene - fetch once in the alternates source before a pool-wide refresh/provision so lanes borrow objects instead of duplicating them; set gc.auto=0 in lanes plus a scheduled git maintenance / repack -adl; core.untrackedCache=true in lane config. SEQUENCING: PR #2547 (card #4000, was 4000; merged 2026-09-23) reworked we:scripts/lane-pool.mjs list --acquirable / aheadIsProvablyPushed; build on top of it.

## Done when

1. **Executable** — a new `we:scripts/__tests__/` vitest proves `ensureDeps` copies from a lockfile-hash-keyed template when one exists (no `npm ci` spawned), falls back to `npm ci` when it does not or the copy fails, and seeds the template after a successful `npm ci`. Fails on origin/main, passes after.
2. **Observed** — on the real WE pool: a freshly cloned lane gets `node_modules` in seconds via `cp -Rc` (log line shows the template path); `git -C <lane> config gc.auto` prints `0` and `core.untrackedCache` prints `true`; a pool-wide refresh logs one fetch in the alternates source before touching lanes.

## Sizing note

Two independent halves (deps template; git hygiene). If either grows past a small change, split the git-hygiene half into its own card — the deps half is the bigger win.

## Additions from 2026-09-24 incident review

Operator proposal 4: "lighter lanes (git worktrees instead of 0.8 GB full clones)". No open card weighs worktrees; this card is the right home. Add it as a design fork before building the git-hygiene half:

- **Option A — keep clones, fix the waste (this card as filed).** Copy-on-write node_modules plus a shared alternates store. Keeps today's isolation: each lane has its own `.git`, its own lease files and its own hooks. Lowest risk.
- **Option B — git worktrees off one shared repo.** Shares objects and refs natively, so a lane costs only its checked-out files. Costs: one branch can be checked out in only one worktree at a time; `.git` becomes a file, so every tool that reads `<lane>/.git/.lane-lease` or runs `git -C <lane>` with repo-level config must be checked (we:scripts/lane-pool.mjs, we:scripts/lib/lane-lease.mjs, we:scripts/guard-lane.mjs, the stop-hook git checks); a `git gc` or a corrupt index in the shared repo hits every lane at once (the daemon clone refresh failures of #3731 show that risk is real).
- **Recommendation:** ship Option A first (it removes most of the 463 MB per lane, which is node_modules, not git). Measure per-lane size after it. Only take Option B if git files are still the main cost. Note that #4028 (trim) and #4037 (bounded growth) resolved on 2026-09-24 and already cover part of #4014's cap and prune goals; recheck #4014 before building.
