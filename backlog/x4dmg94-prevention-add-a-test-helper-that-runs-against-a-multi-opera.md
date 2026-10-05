---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/extend-rounds-io.mjs", "we:scripts/operations/__tests__/extend-rounds-io.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Add a test helper that runs against a multi-operator login list. Make any 'refuses X under any ot… (from web-everything/web-everything#3982 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/extend-rounds-io.mjs:43` — Add a test helper that runs against a multi-operator login list. Make any 'refuses X under any other login' guard require one case per clause of its condition.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3982@bab0150a202810002b1531ff48086315455918ae

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
