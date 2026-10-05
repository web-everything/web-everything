---
bornAs: xu7gljj
kind: story
size: 2
status: open
scope: ["we:scripts/verify-lane.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# verify-lane: record per-phase timing

The verify marker (.git/.lane-verify) records only total start and finish. Add durations for admission wait (before startedAt), the vitest related half, the repo-scan half and the check:standards half, plus the target-file count. Operator-approved 2026-10-04.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
