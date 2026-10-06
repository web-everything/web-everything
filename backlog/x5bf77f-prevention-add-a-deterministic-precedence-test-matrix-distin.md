---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/verify-settings.mjs", "we:scripts/lib/__tests__/verify-settings.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Add a deterministic precedence test matrix distinguishing absent, valid, and invalid environment… (from web-everything/web-everything#4037 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/verify-settings.mjs:62` — Add a deterministic precedence test matrix distinguishing absent, valid, and invalid environment values against non-default file settings; require invalid explicit values to resolve to built-in defaults with default provenance.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4037@5bf661794831f9a03bb66dd074e7ba45c99e8d80

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
