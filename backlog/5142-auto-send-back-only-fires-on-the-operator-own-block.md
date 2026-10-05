---
bornAs: xup2cje
kind: task
status: open
scope: ["we:scripts/"]
dateOpened: "2026-10-05"
tags: []
---

# Auto send-back only fires on the operator own block

On #202 the reviewer ruled 4 findings block. After the last operator ruling (not-real), record-referral-ruling did not send the PR back (#3952 follow-up), so a manual review-set-label --to=changes was needed. Send back when no referral is open and ANY ruling on the head (reviewer or operator) is block.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
