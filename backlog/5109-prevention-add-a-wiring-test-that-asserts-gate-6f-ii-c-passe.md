---
bornAs: x2s91ee
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards.mjs", "we:scripts/__tests__/check-standards.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Add a wiring test that asserts gate 6f-ii-c passes changedFiles and emits err for an owned file a… (from web-everything/web-everything#3968 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/check-standards.mjs:1763` — Add a wiring test that asserts gate 6f-ii-c passes `changedFiles` and emits err for an owned file and warn otherwise. Alternatively, extract the 6f-ii-c loop into a pure function in we:citation-check.mjs and test that.
2. `we:scripts/check-standards.mjs:1764` — Extract the 6f-ii-c decision into a pure function (hits, changedSet, exists → emit levels) and test it, including the null-changed-set case. If the gate runs in CI, also assert that origin/main is present there.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3968@c73e71a8e1b2643869f804a7118c8a8ba829c976

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
