---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/land-overlap-yield.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Add a deterministic orchestration regression test using a red target and explicit skipRed:false,… (from web-everything/web-everything#4019 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/land-overlap-yield.test.mjs:490` — Add a deterministic orchestration regression test using a red target and explicit skipRed:false, asserting a final wait and no skip records.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4019@e9a6411e74649e278da4cd02100beb9f31c55918

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
