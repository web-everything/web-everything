---
bornAs: x6x41sc
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# Operator priority pin: put one PR first in the shared-file repair order

Operator, 2026-10-03: asked to land #3767 (re-queue PRs that lose their review label) before #3787 (approval-check fix); both edit we:scripts/__tests__/review-set-label.test.mjs and reconcile-fix-dispatch serializes them by aged/score/waitingTime/reviewHuman/PR number (we:scripts/conveyor/reconcile-fix-dispatch.mjs ~line 1500) with no operator override, so the only way to reorder was faking labels. Add a durable, logged operator priority pin (set from the WIP page via a relay action or a CLI; cleared automatically when the PR merges or closes) that sorts a pinned PR first among PRs overlapping the same files; show the pin and the resulting order on the WIP verify/repair queue view. Governed by the delivery-flow policy (a key under the 5112 epic, default allowed for the operator only). Tests: a pinned PR is ordered first; the pin clears on merge; the order is logged.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
