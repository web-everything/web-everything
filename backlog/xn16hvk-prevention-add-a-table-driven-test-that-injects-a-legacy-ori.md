---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/review-pr-io.mjs", "we:scripts/operations/__tests__/review-pr-io.test.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# Prevention — Add a table-driven test that injects a legacy origin into every guard that compares origin to --r… (from web-everything/web-everything#3862 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/review-pr-io.mjs:218` — Add a table-driven test that injects a legacy origin into every guard that compares origin to --repo (readPr, resolveTransportRoot, ownsRepo, resolveVerdictedRoot). A lint rule could also flag raw `originRepo(...) ===` comparisons without canonicalizeSlug.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3862@36f398cb0e07ca38e71cf55c58a6c4c5bb0e6615

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
