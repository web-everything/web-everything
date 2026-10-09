---
bornAs: xc9m7mh
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-self-sync.mjs", "we:scripts/lib/daemon-background-build.mjs", "we:scripts/lib/daemon-background-build-settings.json", "we:scripts/lib/daemon-rebuild-builder.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Daemon builds its next version off the tick path — the fix daemon's tick no longer starves behind a 10-24 min rebuild smoke

Starvation half of 5561 (PR #4575). Live 2026-10-09: the fix daemon's `withSelfSync` (we:scripts/lib/daemon-self-sync.mjs) awaited the gated rebuild at the start of every tick. With a 10-24 min live smoke, and an adopted rebuild restarting instead of ticking, no tick completed 06:03Z-07:11Z — no fix / ci-heal dispatches, green drafts unpromoted. Ruled design E5 ("a separate builder process", "restart only between handlers").

Fix: a detached builder process (we:scripts/lib/daemon-rebuild-builder.mjs) runs the SAME gated `rebuildClone` (same lease, unlocked candidate smoke, locked finalize) while the daemon keeps ticking on its current code. It is started only between ticks. The swap stays the existing HEAD-moved restart at a tick boundary, at most once per `swapMinIntervalMs`. Builder starts are coalesced (`buildMinIntervalMs`, none while a swap is pending). A `tick-starved` smell (no completed tick for `tickStarvedSmellMs` while rebuilds adopt) runs for every daemon, logged and appended to the clone's alerts.jsonl. Pure rules and settings: we:scripts/lib/daemon-background-build.mjs, we:scripts/lib/daemon-background-build-settings.json — off = today; on for the fix daemon only. The review daemon shares the code; turning it on is one settings line after the fix-daemon proof.

GitHub budget: one smoke makes ~86 throttled gh points (62 from dispatch-dry-run, 24 from reconcile-dry-run) plus 2 bare `gh` checks that bypass gh-throttle when the App shim is not on PATH. Background builds add no smokes (coalesced). Cutting the per-smoke cost (one shared reconcile read for the three dispatch passes) is separate work.

## Acceptance

- [A1] **Executable** — we:scripts/lib/__tests__/daemon-background-build.test.mjs (run with `npm run test:unit -- <that file>`): a simulation of `withSelfSync` with main moving every 3 min and tonight's real smoke durations (we:scripts/lib/__tests__/fixtures/background-build/fix-daemon-2026-10-09.json) gives zero ticks inline and ticks every <= 3 min in background mode, with swaps only between ticks and at most once per window. Fails on the old self-sync, passes after.
- [A2] **Live** — the wev-fix-daemon log shows completed ticks every <= 3 min while a `daemon-rebuild-builder` smoke runs, and the swap (`restarting onto the new code ... swap between ticks`) between ticks.

## Non-goals

- [N1] Never weakens the rebuild smoke, the stale-main guard, the clone read/write lock or any merge-gate guard. Does not change the versioned (card 89) path. Does not cut the smoke's own gh cost.

## Edge cases this change must handle

1. **Untrusted text** — n/a: reads only local state files this code writes.
2. **Truncated reads** — a missing or corrupt builder/tick state file reads as null (no builder running, no baseline).
3. **Shared state files** — the builder record and tick record are written atomically (tmp + rename), per clone and per daemon entry; the build lease in the rebuild state stays the single-flight guard.
4. **Fail closed** — a re-cloned clone runs no children until the builder's rebuild on it finished; a builder spawn failure logs and the next tick retries; the tick still takes the read lock.
5. **Identity scoping** — per clone (cloneKey) and per daemon entry name; a builder on another host is never waited on.
6. **State over time** — bounded: one builder at a time, at most one start per `buildMinIntervalMs`, at most one swap per `swapMinIntervalMs`; the smell logs at most once per threshold per process.
7. **Who wrote it** — n/a: no authored input.
