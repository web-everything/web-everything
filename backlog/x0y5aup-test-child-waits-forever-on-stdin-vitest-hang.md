---
kind: task
status: open
scope: ["we:scripts/"]
dateOpened: "2026-10-05"
tags: []
---

# Test child waits forever on stdin (vitest hang)

On 2026-10-05 00:22-02:27 ET a lane-2 vitest run hung: one test spawns a child that blocks on stdin. The gate timeout now catches it, but the test should use stdio: [ignore, ...]. Find it via the lane-2 verify of that time. Also check nothing else reads the truncated gate-started chunk (truncated in 356 of 1047 runs; fixed in #3972).

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
