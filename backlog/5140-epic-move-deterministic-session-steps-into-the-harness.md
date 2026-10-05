---
bornAs: xoa6kew
kind: epic
status: open
scope: ["we:scripts/"]
dateOpened: "2026-10-05"
tags: []
---

# Epic: move deterministic session steps into the harness

Umbrella: move deterministic session steps from the model into the harness. Needs /prepare before /slice; do not batch-build. Slices: lane acquire/release; mechanical main catch-up; commit/push/open-pr/labels as one step; CI wait; edge adoption; card filing as one operation; claim heartbeat; stand-down routing. Forks to /prepare: how a session is resumed (claude --resume vs inbox); where state lives while waiting (needs GitHub-off state plan); reaper exemptions for waiting sessions; which daemon owns which step; rollout order and edge plan.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
