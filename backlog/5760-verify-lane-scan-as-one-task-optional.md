---
bornAs: xxdbwoa
kind: story
size: 2
parent: "5767"
status: open
blockedBy: ["5754"]
scope: ["we:skills-src/conveyor/verify-daemon.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Verify lane scan as one task (optional)

Optional slice S7 of the async-daemons epic, after PR #4764 (verify daemon gate runs as detached jobs) and S2a. The verify daemon's lane scan runs as one readonly task instead of inline. Filed unqueued: small win; the operator decides.

## Acceptance

- [A1] **Live** — the verify daemon tick no longer includes the lane scan time (before/after `tick-timing`).

## Non-goals

- [N1] Changing verify selection.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: lane paths only.
2. **Truncated reads** — A partial scan result is discarded and rescanned next tick.
3. **Shared state files** — Readonly task.
4. **Fail closed** — Scan error -> no dispatch that tick.
5. **Identity scoping** — Keyed by lane.
6. **State over time** — Result bound to the scan time.
7. **Who wrote it** — n/a: no writes.
