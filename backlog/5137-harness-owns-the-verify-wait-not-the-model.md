---
bornAs: xjyvpkf
kind: story
size: 5
parent: "5140"
status: resolved
scope: ["we:scripts/"]
dateOpened: "2026-10-05"
dateResolved: "2026-10-06"
tags: []
---

# Harness owns the verify wait, not the model

The fixer requests a verify, saves state and ends its turn (awaiting verify). The daemon watches the verdict by deterministic policy: green pushes and ends the fix; timeout or outage retries; load-flake holds until quiet (#3945); N failures go to the escalation ladder (#3889). Resume the SAME session with failing tests attached only on a real red. Needs: reaper must not stop awaiting-verify sessions; wire resume-session-with-message to the verify result. Replaces check --wait loops.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
