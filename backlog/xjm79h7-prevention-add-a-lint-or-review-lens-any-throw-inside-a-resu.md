---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/card-batch-seal-io.mjs", "we:scripts/operations/__tests__/card-batch-seal-io.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add a lint or review lens: any throw inside a resumable step loop must either increment a bounded… (from web-everything/web-everything#4135 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/card-batch-seal-io.mjs:148` — Add a lint or review lens: any `throw` inside a resumable step loop must either increment a bounded counter or be proven terminal. Alternatively, count every non-advancing seal attempt in a single per-step `attempts` field with one cap.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4135@242210c246fff502584e017ce734bf5985ae34eb

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
