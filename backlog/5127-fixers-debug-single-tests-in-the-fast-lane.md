---
bornAs: x1ds37v
kind: task
status: open
scope: ["we:scripts/readiness/heavy-admission.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Fixers debug single tests in the fast lane

Fixer brief: iterate on the one failing test via node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run <file> -t "<name>" (fast slot), then run ONE full default verify before pushing. Today fixers re-run the full related verify after every edit.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
