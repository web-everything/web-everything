---
bornAs: x7m8ipu
kind: task
status: open
scope: ["we:scripts/"]
dateOpened: "2026-10-05"
tags: []
---

# Live-process check verifies process identity, not just pid

Hardening, no live case. The live-process check should verify process identity (start time plus command), not only that the pid exists, to guard against pid reuse.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
