---
kind: story
size: 3
status: open
blockedBy: ["2940"]
scope: ["we:scripts/lib/lane-drain.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Caused-vs-inherited refusal split must catch refusals the PR causes indirectly, not only via files in its diff

Finding from PR #3794 (CONFIRMED): the caused-vs-inherited split in we:backlog/2940 treats a refusal as caused only when the refusing file or card is in the PR diff. Failure scenario: a PR narrows the drain rewrite scope, edits the lane-drain refusal logic, or renames the scope constant; it causes a refusal indirectly, gets only a warning, and the gate fails open (the 2026-10-03 failure again). Hardens 2940. Done when: (1) causation is judged by a differential dry run on the base tree vs the merged tree, so any refusal new against main is caused whichever file it names; (2) inherited requires positive proof from a completed base run; (3) a test for a PR that narrows the scope, edits refusal logic, or renames the constant fails before the fix and passes after.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
