---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/probation-launcher.mjs", "we:scripts/lib/__tests__/probation-launcher.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Have the contract test assert case-sensitivity through parseProposedBlockedBy itself, not only th… (from web-everything/web-everything#4152 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/probation-launcher.mjs:219` — Have the contract test assert case-sensitivity through parseProposedBlockedBy itself, not only the standalone id regex. Longer term, build the add/remove keyword case-insensitively without applying the flag to the id group.
2. `we:scripts/lib/probation-launcher.mjs:219` — Add a parser-level case to the contract test, e.g. expect `parseProposedBlockedBy('## Proposed blockedBy changes\n- add x2C7uas\n')` to equal `[]`. Write the verb match as `(?:[Aa]dd|[Rr]emove)`, or use a scoped inline modifier, so the id part stays case-sensitive. More generally: have the contract test run its valid/invalid id table through every consumer regex built from `BACKLOG_ID_SOURCE`, not just a freshly built one.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4152@84c386313e3c4731103d1ee9880c2d3b88572354

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
