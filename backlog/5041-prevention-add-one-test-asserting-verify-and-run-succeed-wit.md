---
bornAs: xv8xpo7
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/verify-lane.test.mjs", "we:scripts/verify-lane.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# Prevention — Add one test asserting verify and run succeed with an empty lock root. A broader guard would be a… (from web-everything/web-everything#3797 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/__tests__/verify-lane.test.mjs:1114` — Add one test asserting `verify` and `run` succeed with an empty lock root. A broader guard would be a lint that every mode-conditional guard has a negative-mode test.
2. `we:scripts/verify-lane.mjs:368` — Make the daemon honor the same env var, or document the override as test-only. A shared helper that resolves the lock root for both reader and writer would prevent the mismatch.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3797@d6e12da5247222b97e6ade0ea431a4a73584088b

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
