---
bornAs: xd3h4w0
kind: story
size: 3
parent: "3383"
status: open
scope: ["we:skills-src/conveyor/fix-agent-brief.md", "we:scripts/conveyor/fix-procedure.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Test-first by default for CONFIRMED findings

Live 2026-10-03/04: fixers repeatedly pushed changes that did not address CONFIRMED findings: #3833 twice, #3794 and #3771. The escalation ladder (#3889) makes 'failing test first' mandatory only at rung 2 (opus). Fix: make it the default for any fix addressing a CONFIRMED finding. we:skills-src/conveyor/fix-agent-brief.md requires a test that reproduces each finding and fails on the current head before the fix; we:scripts/conveyor/fix-procedure.mjs checks that each finding has a test cited in the fix-end note. Done when: (1) the brief requires a red test per CONFIRMED finding; (2) fix-procedure rejects a fix-end note with a finding lacking a cited test; (3) tests cover accept and reject; (4) the #3889 rung-2 rule still holds.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
