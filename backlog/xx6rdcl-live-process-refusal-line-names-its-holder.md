---
kind: task
status: open
scope: ["we:scripts/"]
dateOpened: "2026-10-05"
tags: []
---

# Live-process refusal line names its holder

formatRefusalLine omits the bound session name, pid and cwd. On #3794 the bound session has a LIVE pid line led to a wrong diagnosis (pid reuse); it was the review job review-3794. Add the name, pid and cwd to the line.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
