---
kind: story
size: 3
status: open
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:scripts/conveyor/tick-core.mjs", "we:scripts/lane-pool.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Cut the build daemon tick from 137 s median to under 120 s: overlap independent reads and speed the lane-pool scan

Build daemon ticks overrun the 120 s interval (172 ticks since 13:14Z: p50 137 s, p90 203 s). Dominant phases: planTick 73 s (lane-pool list --acquirable 49 s, state read 22 s, plan read 16 s), listSettledPrepares 14 s, recoverDrafts 10 s, primePrepareStatus 10 s, readBuildRuns 8.5 s, fetchOpenPrs 7.7 s. Cut by overlapping independent reads and speeding the lane scan, with identical decisions (proof: same plan output).

## Done when

1. **Executable** — `npx vitest run we:scripts/__tests__/lane-pool-clean-verdict-memo.test.mjs we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs` passes (the clean-lane reuse gives the same list as a full scan; the evidence cache gives the same evidence as a fresh read). Live: tick `totalMs` p50 in `build-dispatch-daemon.log` drops from 137 s to under 120 s.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: only stat data and transcript files already read today are reused; no new text is parsed.
2. **Truncated reads** — a transcript is cached by size and mtime read before the read; a write racing the read changes the stat, so the entry just misses next time.
3. **Shared state files** — the lane verdict memo file gains `clean` entries; a scan with the feature off ignores them, and writes merge onto the latest file as before.
4. **Fail closed** — the clean reuse is off unless the daemon's planning read turns it on; any fingerprint change, lease, dirt, or ahead commit re-probes the lane; `acquire` re-verifies before any reset.
5. **Identity scoping** — n/a: entries are keyed by lane number within one pool file and by transcript handle plus projects path.
6. **State over time** — every reused entry has a max age (10 min, staggered per lane), so a lane edited without an index change is re-proved within that bound.
7. **Who wrote it** — n/a: the reused data is read-only state the scan or transcript reader already trusts.
