---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/verify-lane-gate.mjs", "we:scripts/verify-lane.mjs", "we:scripts/lib/__tests__/verify-lane-gate.test.mjs", "we:scripts/__tests__/verify-lane.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Strip control characters in formatVerifyPhases, or in buildPhaseOutcome for every kind. Add a tes… (from web-everything/web-everything#3991 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/verify-lane-gate.mjs:531` — Strip control characters in `formatVerifyPhases`, or in `buildPhaseOutcome` for every kind. Add a test that an ESC-bearing reason does not reach the formatted line. A lint rule against raw interpolation of untrusted strings into stderr would be the deterministic gate; none exists today.
2. `we:scripts/verify-lane.mjs:486` — Add a deterministic integration test selecting a full-suite default gate and asserting that executed vitest and standards phases have measured durations and actual outcomes.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3991@c0e44601cf6c5be791ce95927dc6ca4d44068d61

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
