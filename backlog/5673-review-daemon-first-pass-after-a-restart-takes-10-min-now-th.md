---
bornAs: xbf7be9
kind: story
size: 3
status: resolved
scope: ["we:scripts/lib/daemon-background-build-settings.json", "we:scripts/lib/__tests__/review-daemon-first-pass.test.mjs", "we:scripts/lib/__tests__/fixtures/background-build/review-daemon-2026-10-09.json", "we:scripts/lib/__tests__/daemon-background-build.test.mjs"]
dateOpened: "2026-10-09"
dateStarted: "2026-10-09"
dateResolved: "2026-10-09"
tags: []
---

# Review daemon first pass after a restart takes ~10 min — now the whole promote-to-review wait

After card 5658 a promoted draft's review goes out in the same review-daemon pass, so the remaining wait is pass length. Live 2026-10-09: steady pass 2-5 min (pr-events wake 20:22:12Z -> session-reap 20:24:21Z), but after the self-sync restart at 20:33:41Z the first pass only finished at 20:43:27Z (~10 min), so #4683/#4680 (promoted 20:26:43Z) waited 16.7 min. Card 4218 owns the rebuild smoke starving ticks (smoke-slow 305 s at 20:33:39Z); this card owns the cold first pass (ledger-shadow store pending, pr-facts warm, reconcile over all repos) — measure per-step timing on the first pass (see 4129) and cut it below one steady pass.

## Profile (2026-10-09, live)

- Boot to first completed tick, from we:scripts/lib/__tests__/fixtures/background-build/review-daemon-2026-10-09.json: 586 s (20:33Z), 673 s (22:26Z), 2064 s (23:06Z, five restarts chained by inline smokes), and the 00:24Z boot had not ticked 20 min later. Process sampling of the live daemon in that window showed only rebuild-smoke children (reconcile-pass dry-runs for 3 repos, dispatch dry-run, lane-pool checks).
- One cold tick's reads replayed with every write stubbed (hold sweep, PR list, agents, reconcile for all 3 repos): ~30 s total, WE reconcile ~21 s. So the cold read side is not the 10 minutes.
- Cause: `withSelfSync` (we:scripts/lib/daemon-self-sync.mjs) runs the gated rebuild inline at the start of a tick (smoke 2.4-7.7 min on the loaded host), and an adopted rebuild restarts instead of ticking. Same failure 5572 fixed for the fix daemon.

## Fix

Turn on the existing background builder (x44lnnt, card 5572) for we:skills-src/conveyor/review-daemon.mjs in we:scripts/lib/daemon-background-build-settings.json. A restarted review daemon now ticks first; the next version builds and smokes in a detached builder; the swap stays between ticks, at most once per 10 min. No check is skipped: same gated rebuild, same smoke, same stale-main guard.

## Acceptance

- [A1] **Executable** — we:scripts/lib/__tests__/review-daemon-first-pass.test.mjs (run with `npm run test:unit -- <that file>`): the committed settings enable the background build for we:skills-src/conveyor/review-daemon.mjs, and a real `withSelfSync` simulation with tonight's smoke durations gives every restarted process its first pass within one pass length (inline: zero first passes). Fails before this change, passes after.
- [A2] **Live** — on wev-review-daemon, the first `review-daemon: tick (...)` after the next restart lands within one pass length of `started on`, with no inline smoke between them, and the same dispatch decisions as the surrounding passes.

## Non-goals

- [N1] Does not change we:skills-src/conveyor/review-daemon.mjs, the reconcile reads, the dispatch rules or the smoke itself; steady pass length under load is separate work.

## Edge cases this change must handle

1. **Untrusted text** — n/a: a settings flag; no input is parsed.
2. **Truncated reads** — a missing or corrupt settings file falls back to the built-in default (off), so the daemon runs the old inline path, never an unverified one.
3. **Shared state files** — the builder record and build lease are per clone and per daemon entry (5572); the review clone gets its own.
4. **Fail closed** — a builder failure logs and retries next tick; the daemon keeps ticking on its last smoked code; a re-cloned clone runs no children until the builder finishes.
5. **Identity scoping** — keyed by the entry basename of we:skills-src/conveyor/review-daemon.mjs; the operator can force it off per process with `WE_DAEMON_BACKGROUND_BUILD=0`.
6. **State over time** — one builder at a time, at most one start per 5 min, one swap per 10 min; the tick-starved smell still runs.
7. **Who wrote it** — n/a: no authored input.
