---
kind: story
size: 3
status: open
scope: ["we:scripts/review-set-label.mjs", "we:scripts/__tests__/review-set-label.test.mjs", "we:scripts/conveyor/review-status-tag.mjs", "we:scripts/conveyor/__tests__/review-status-tag.test.mjs"]
dateOpened: "2026-10-02"
tags: []
---

# A PR shows one consistent review state: a send-back clears stale advisory labels and the status says what happens next

Live case 2026-10-02: PR #3490 carried review:changes, review:human, review-status:fixing and advisory:accepted at once after the operator sent it back. The fixer was correctly working the send-back, but the labels contradicted each other: advisory:accepted came from the review before the send-back, and review:human reads as waiting on the operator now although it means a human approval is still owed after the fix. Fix: (1) we:scripts/review-set-label.mjs --to=changes removes any advisory:* label (it described an earlier verdict); (2) the status tagger publishes one plain combined state when changes and human are both present (for example "fixing the send-back, then needs operator approval") and Plateau shows that single state instead of raw labels. Replay #3490.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
