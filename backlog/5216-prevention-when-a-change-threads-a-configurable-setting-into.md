---
bornAs: xk3lzth
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/verify-lane.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — When a change threads a configurable setting into a new call site, require a test that sets the s… (from web-everything/web-everything#4123 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/__tests__/verify-lane.test.mjs:1115` — When a change threads a configurable setting into a new call site, require a test that sets the setting to a non-default value. A review lens is the cheapest guard; there is no practical lint for this.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4123@d506e68b3e0b9b529085a9fa3d9d2e2478519acc

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
