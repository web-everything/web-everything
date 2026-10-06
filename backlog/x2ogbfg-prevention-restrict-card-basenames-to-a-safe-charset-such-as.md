---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/card-batch-policy.mjs", "we:scripts/lib/__tests__/card-batch-policy.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Restrict card basenames to a safe charset such as [A-Za-z0-9._-] in the eligibility regex, and es… (from web-everything/web-everything#4092 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/card-batch-policy.mjs:93` — Restrict card basenames to a safe charset such as `[A-Za-z0-9._-]` in the eligibility regex, and escape or JSON-quote paths in reasons. Add a test with newline and ESC characters in the path.
2. `we:scripts/lib/__tests__/card-batch-policy.test.mjs:105` — A mutation-testing framework (like Stryker) would automatically break the regex and demand a test that fails without it, catching this coverage gap deterministically.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4092@a9a9fa268eadbd4b9186c0c5a3be6538dc0e0af9

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
