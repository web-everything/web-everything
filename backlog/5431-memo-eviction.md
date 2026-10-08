---
bornAs: xzxi69a
kind: task
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/__tests__/lane-pool-clean-verdict-memo.test.mjs"]
dateOpened: "2026-10-08"
estimatedLoc: 20
tags: []
---

# Lane-pool scans without the clean-verdict memo env evict the build daemon's clean verdicts, keeping the tick over its interval

noteVerdict in we:scripts/lane-pool.mjs writes a null update for a fully clean lane whenever the env is off, so any acquire or list scan deletes the daemon's opt-in clean entries; the daemon then re-probes the pool each tick (83 s cold vs 16 s warm measured on 2026-10-08, tick totalMs 194-387 s vs the 120 s interval after #4356).

## Done when

1. **Executable** — `npx vitest run we:scripts/__tests__/lane-pool-clean-verdict-memo.test.mjs` includes a case where a scan with the clean-memo env unset leaves an existing clean entry in the memo file untouched, and the next scan with the env set reuses it (no git spawned for that lane). It fails before this item lands and passes after.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the memo holds only stat fingerprints written by lane-pool itself.
2. **Truncated reads** — n/a: an unreadable memo file already reads as empty.
3. **Shared state files** — the env-off scan must not delete or rewrite another caller's clean entries; merge-on-write stays.
4. **Fail closed** — a kept clean entry is still only used when the env is on and its fingerprint plus tree signature match; otherwise the lane is re-probed.
5. **Identity scoping** — n/a: the memo is per pool and per branch, unchanged.
6. **State over time** — a kept entry still expires by the staggered max age; an env-off scan never refreshes it.
7. **Who wrote it** — n/a: only lane-pool writes the memo.
