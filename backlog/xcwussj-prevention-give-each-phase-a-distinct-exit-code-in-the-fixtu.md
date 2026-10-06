---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/verify-lane.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Give each phase a distinct exit code in the fixture (for example scan 4, standards 5) and assert… (from web-everything/web-everything#4071 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/__tests__/verify-lane.test.mjs:1262` — Give each phase a distinct exit code in the fixture (for example scan 4, standards 5) and assert the marker's exitCode equals the first red phase's code. A rule that rejects a test comment promising an ordering unless the values it checks differ would be the deterministic gate.
2. `we:scripts/__tests__/verify-lane.test.mjs:1253` — Add a deterministic regression test with two scan commands: make the first fail and assert that the second and standards both execute while the verdict remains red.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4071@249fa80c41af4eaec2ebbfd19f2ea7501235f033

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
