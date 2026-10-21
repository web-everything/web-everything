---
bornAs: x7gu6mc
kind: investigation
parent: "4075"
status: open
scope: ["we:scripts/lane-pool.mjs"]
dateOpened: "2026-09-24"
tags: []
---

# Worktree-based lanes instead of full clones

2026-09-24: the lane pool grew past 100 full clones and disk and scan cost grew with it. Investigate git worktrees sharing one object store in place of full clones: which lane-pool guarantees depend on a separate .git (leases, reset --hard, per-lane hooks, daemon clones), node_modules handling, and what breaks. Relates to #4014 (hard cap, recycle, prune) and #4015 (copy-on-write node_modules).

## Done when

1. **Executable** — a findings report lists each lane-pool guarantee that depends on a separate `.git`,
   whether a worktree keeps it (proven on a throwaway worktree lane, not asserted), the disk and acquire-time
   numbers for both shapes, and a go / no-go with the follow-up card filed.
