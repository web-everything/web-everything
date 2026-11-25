---
bornAs: xk4kkxl
kind: story
size: 5
parent: "5140"
status: open

dateOpened: "2026-10-05"
tags: []
---

# Route verify and heavy runs to CI by configurable strategy

When the host is busy, run verify on CI via a side ref (verify/<pr>-<sha>), not the PR head. Routing is a pluggable strategy chosen by config: local-only, ci-only, threshold (projected wait or load), cost-aware, per-kind (single-test debug stays local). Strategy and knobs live in one config; every decision and its inputs are logged. Uses queueAdmission.projectedWaitMinutes. CI wall ~45 min vs 7-35 locally; no host load. Pairs with the verify-wait story.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

## Findings (standalone worker, 2026-11-25)

The build-dispatch daemon held #5138 with:

> worker-declined: Not prepared: #5138 — could-not-prepare. Two unresolved policy choices remain: - Whether local/CI strategies replace or compose with existing Forge routing ('we:scripts/readiness/heavy-admission.mjs:847'). - Whether “cost-aware” minimizes elapsed time, paid CI usage, or a weighted combination. The delivery statute defines precedence and shadow rollout, but not these choices ('we:docs/agent/platform-decisions.md:6093'). No files changed or stamped. No tests run.

`scope:` was cleared above so this card is picked up by the existing unshaped-item auto-prepare path;
a prepare pass re-scopes it against the finding.
