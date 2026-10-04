---
bornAs: x7xwk83
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/lane-drain-numbering.test.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# Prevention — Set a file-level timeout (for example vi.setConfig({ testTimeout: 30000 })) or a per-test timeout for g… (from chalbert/web-everything#3806 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/__tests__/lane-drain-numbering.test.mjs:89` — Set a file-level timeout (for example vi.setConfig({ testTimeout: 30000 })) or a per-test timeout for git-spawning integration tests. A lint rule could flag tests that spawn git without a timeout.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3806@4695581a36c1d40280e1bfc00c095bc53cc552b5

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
