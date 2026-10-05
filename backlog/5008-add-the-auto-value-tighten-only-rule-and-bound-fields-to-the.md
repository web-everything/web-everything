---
bornAs: xhbe7xa
kind: story
size: 5
parent: "3383"
status: open
scope: ["we:config/defineConfig.ts", "we:config/platformDefaults.ts", "we:scripts/lib/delivery-policy.mjs", "we:scripts/drain-overlap-yield-config.json"]
dateOpened: "2026-10-03"
tags: []
---

# Add the auto value, tighten-only rule and bound fields to the delivery-policy loader

Extends card 5113 (the delivery-policy loader; not yet on main, so no blockedBy edge could be written: add it once 5113 is numbered). Ruled in we:docs/agent/platform-decisions.md#delivery-decider-under-fixed-settings (card 4998). Each strategy field gains an auto value. Precedence: invariants, per-item override, fixed value, decider, platform default. Safety-class fields (mergeGate.onMainRed, mergeGate.recheckWhenMainMoved) take auto only as tighten-only; dispatchGate.overlapOverride takes none. Also adds a per-field promotion setting (shadow or live, default shadow) and merges we:scripts/drain-overlap-yield-config.json into the one delivery-policy home before overlap goes live. Platform defaults stay today ruled values; auto is never a default.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
