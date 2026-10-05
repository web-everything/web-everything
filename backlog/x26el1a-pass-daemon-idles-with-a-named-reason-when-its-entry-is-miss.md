---
kind: task
status: open
scope: ["we:scripts/"]
dateOpened: "2026-10-05"
tags: []
---

# Pass-daemon idles with a named reason when its entry is missing from the clone

The load-flake-reverify launchd job crash-looped every 10s because wev-review-daemon lacked #3945. It should idle with a named reason, not crash-loop.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
