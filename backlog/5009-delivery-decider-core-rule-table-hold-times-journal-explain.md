---
bornAs: xdvt2tk
kind: story
size: 8
parent: "3383"
status: open
blockedBy: ["5008", "5002"]
scope: ["we:scripts/lib/delivery-decider.mjs", "we:scripts/lib/delivery-decider.test.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# Delivery decider core: rule table, hold times, journal, explain CLI and shadow mode

Ruled in we:docs/agent/platform-decisions.md#delivery-decider-under-fixed-settings (card 4998). One pure function decide(signals, policy) returning choice, source, ruleId, signals and alternatives, called by each daemon at action time. Rule table for decision points D1 (verify order), D2 (overlap), D3 (integration check), D5 (main-red response), D6 (heavy-slot priority), D7 (test scope), D8 (dispatch admission), D9 (wide changes). Includes hold times, a journal entry per decision through recordPolicyEvent, and an explain CLI. A field set to auto runs in shadow mode: the decider only logs what it would pick and why, next to the applied value. It acts only when the operator has reviewed about a week of logs and promoted that field. An impossible pin reports blocked: fixed-policy-conflict.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
