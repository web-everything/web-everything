---
bornAs: xga0pu9
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add deterministic regression cases for multi-backtick code spans to the existing inline-code excl… (from web-everything/web-everything#4183 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/check-standards-rules.mjs:1152` — Add deterministic regression cases for multi-backtick code spans to the existing inline-code exclusion test, and strip spans using matching delimiter lengths.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4183@64e5fa1273334d4bfc559e423104fc37c5762b59

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
