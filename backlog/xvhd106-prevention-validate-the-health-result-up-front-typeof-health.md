---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-version-switch.mjs", "we:scripts/lib/__tests__/daemon-version-switch.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Validate the health result up front (typeof health?.ok === 'boolean', otherwise treat as failed o… (from web-everything/web-everything#4210 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-version-switch.mjs:395` — Validate the health result up front (`typeof health?.ok === 'boolean'`, otherwise treat as failed or throw) and add a table-driven test over malformed health shapes. A lint rule against `!== false` success checks on guard results would catch the whole class.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4210@2b900e8b7493cf02a545e216c892a5f3c573d1c6

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
