---
bornAs: xk4kkxl
kind: story
size: 5
parent: "5140"
status: open
scope: ["we:scripts/readiness/heavy-admission.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Route verify and heavy runs to CI by configurable strategy

When the host is busy, run verify on CI via a side ref (verify/<pr>-<sha>), not the PR head. Routing is a pluggable strategy chosen by config: local-only, ci-only, threshold (projected wait or load), cost-aware, per-kind (single-test debug stays local). Strategy and knobs live in one config; every decision and its inputs are logged. Uses queueAdmission.projectedWaitMinutes. CI wall ~45 min vs 7-35 locally; no host load. Pairs with the verify-wait story.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
