---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/required-status-checks.mjs", "we:scripts/lib/__tests__/required-status-checks.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add a deterministic integration regression test combining a permanent protection denial with a li… (from web-everything/web-everything#4187 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/required-status-checks.mjs:185` — Add a deterministic integration regression test combining a permanent protection denial with a live entry older than the admission limit, asserting eventual declared-policy recovery. The follow-up is already recorded in the changed backlog file, but the test gate is not implemented.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4187@3e00f84658bb94fd62efe92783c63686e297e374

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
