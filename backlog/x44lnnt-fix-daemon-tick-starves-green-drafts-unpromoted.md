---
kind: story
size: 3
status: open
dateOpened: "2026-10-09"
tags: []
---

# Fix daemon tick starves behind self-sync rebuild restarts — green drafts went unpromoted for 1 h

Live 2026-10-09: drafts #4567/#4563/#4535/#4569/#4570/#4572 green but draft up to 1 h; review daemon logged 'owed a promote-draft, not a review'; health-watch raised draft-not-promoted. Root cause: the fix daemon's tick (sole promoter) did not run from 05:53Z to 07:00Z — each tick first runs the gated self-sync rebuild (10-19 min smoke) and an adopted rebuild restarts INSTEAD of ticking (we:scripts/lib/daemon-self-sync.mjs withSelfSync default path), so while main moves faster than the smoke the tick never runs. Shipped (lane/promote-green-drafts): pure rule we:scripts/conveyor/draft-promotion-rule.mjs + we:scripts/conveyor/draft-promotion-settings.json + a cheap promotion step (we:scripts/conveyor/draft-promotion-loop.mjs) run from the fix daemon's await-verify child, with a replay fixture of #4567. Still owed: the starvation itself — every fix/ci-heal dispatch is starved the same way; a process should complete at least one tick between adopted rebuilds (tick-first after restart), proven on the live fix-daemon log.

## Acceptance

- [A1] **Executable** — a unit test drives `withSelfSync` (we:scripts/lib/daemon-self-sync.mjs) through boot → adopted rebuild → restart → boot with `main` moving on every rebuild, and asserts at least one real tick runs per process; it fails on today's code (zero ticks) and passes after.
- [A2] **Live** — the fix-daemon log shows a completed tick between consecutive `rebuilt the clone … restarting` lines over an hour of fast `main` movement.

## Non-goals

- [N1] Promoting drafts — already moved off the tick (we:scripts/conveyor/draft-promotion-loop.mjs). Never weakens the rebuild smoke or the stale-main guard.

## Edge cases this change must handle

1. **Untrusted text** — n/a: no external text is parsed.
2. **Truncated reads** — n/a: reads the local clone state only.
3. **Shared state files** — the rebuild write lock stays the only mover of the clone; a tick still takes the read lock.
4. **Fail closed** — a tick that cannot get the read lock still skips; never reads a tree mid-move.
5. **Identity scoping** — per daemon clone, as today.
6. **State over time** — bounded: one tick before the next rebuild, never an unbounded deferral of the rebuild.
7. **Who wrote it** — n/a: no authored input.
