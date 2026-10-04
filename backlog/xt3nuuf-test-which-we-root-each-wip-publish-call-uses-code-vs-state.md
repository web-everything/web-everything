---
kind: story
size: 2
status: open
scope: ["plateau:scripts/wip-publish.ts", "plateau:src/wip/"]
dateOpened: "2026-10-04"
tags: []
---

# Test which WE root each wip-publish call uses (code vs state)

Follow-up from plateau #204's advisory review, approved by the operator 2026-10-04. `plateau:scripts/wip-publish.ts` routes lane map, fork notes, askSession cwd and watch dirs to the STATE root and everything else to the CODE root, but only through script wiring that no test defends. A later edit reverting `readLaneMap(weStateRoot)` / `noteFork(weStateRoot, …)` to the code root would silently read a stale lane map from the self-syncing clone and write notes there. Extract the routing into a testable helper (or add a script-level test) asserting each call's root. Also assert that `resolveLanePath` / `lane-pool path` give the same answer from the code clone and from the primary, since both read the shared lane pool.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
