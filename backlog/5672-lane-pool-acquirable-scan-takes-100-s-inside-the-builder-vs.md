---
bornAs: xyaugbj
kind: story
size: 3
priority: high
status: open
scope: ["we:scripts/lane-pool.mjs", "we:skills-src/conveyor/build-dispatch-daemon.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Lane-pool acquirable scan takes ~100 s inside the builder vs 13-23 s alone

The lane-pool acquirable scan takes about 100 s inside the live build daemon but 13-23 s when run alone. Found by the tick-speed worker (#4677); launchd throttling ruled out. It dominates planTick even after #4652 (scan cache) and #4677 (overlap). Fix idea: profile the scan inside the daemon (env, cwd, cache dir, concurrent scanners from other daemons, lock wait), then make the daemons share one scan result per tick. Evidence: build-dispatch-daemon.log tick timings 2026-10-09 18:19-19:23Z; #4677 report. Related: #5322 (build-daemon tick speed). Session 2026-10-09 (held item 193).

## Acceptance

- [A1] **Executable** — the build daemon's tick row records the acquirable-scan time; a profile run inside the live daemon names the cause (env, cwd, cache dir, concurrent scanners, or lock wait) in the PR.
- [A2] After the fix, the in-daemon scan time is within 2x of the standalone 13-23 s run, shown on live tick rows before/after.
- [A3] If the cause is several daemons scanning at once, one scan result per tick is shared across daemons, with a test that a second reader in the same tick reuses it.

## Non-goals

- [N1] Does not change which lanes count as acquirable.
- [N2] Does not cover the other planTick costs (#5322 owns the overall tick target).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: inputs are lane directories and git state, not free text.
2. **Truncated reads** — a half-written shared scan result is ignored and the reader scans itself.
3. **Shared state files** — a shared scan result is written atomically (temp file + rename) and stamped with the tick time.
4. **Fail closed** — if the shared result is missing or stale, fall back to a fresh scan; never acquire on a stale "free" answer.
5. **Identity scoping** — the shared result is per host and per lane pool; no reuse across pools.
6. **State over time** — the shared result expires at the end of the tick window; a lane taken since then is re-checked at acquire time.
7. **Who wrote it** — only the lane-pool scan writes the shared result.
