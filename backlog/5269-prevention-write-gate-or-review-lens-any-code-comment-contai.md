---
bornAs: xkamp6b
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/scheduled-sweep.mjs", "we:scripts/operations/__tests__/scheduled-sweep.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Write-gate or review lens: any code comment containing 'keeps', 'never' or 'always' must name a t… (from web-everything/web-everything#4228 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/scheduled-sweep.mjs:295` — Write-gate or review lens: any code comment containing 'keeps', 'never' or 'always' must name a test, and IO shells with persisted state must take an injectable effects argument.
2. `we:scripts/operations/scheduled-sweep.mjs:196` — Lint or review lens: a bounded list call must flag when `result.length === limit`. Then the sweep could push an attention line such as 'PR list truncated at 100'.
3. `we:scripts/operations/scheduled-sweep.mjs:14` — Land-time check: when a PR comment or description claims something is absent from main, grep main for that name before merge.
4. `we:scripts/operations/scheduled-sweep.mjs:307` — Add a deterministic test with injected notification and filesystem dependencies: fail delivery, verify the stored signature remains unchanged, then verify the next identical report retries delivery.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4228@a9640f04fcb2aa0aa5b1f8818a8ff156ea1b831b

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
