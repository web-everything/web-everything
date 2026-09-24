---
bornAs: xq46pq0
kind: story
size: 3
status: resolved
scope: ["we:scripts/lane-pool.mjs", "we:scripts/__tests__/lane-pool-acquire-growth.test.mjs"]
dateOpened: "2026-09-24"
dateStarted: "2026-09-24"
dateResolved: "2026-09-24"
tags: []
---

# lane-pool acquire must grow the pool on no-free-lane, bounded by a hard cap (#3383)

acquire's auto-pick fails hard on a full pool (no free lane in pool ...) with zero growth attempt; add bounded growth-on-empty up to a hard cap above the trim target, both env-overridable, refusing to grow on a live remote-probe failure (mirrors #4025's fail-safe-stop).

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
