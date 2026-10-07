---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/proc-read-migration-74d.test.mjs", "we:scripts/lib/open-pr-items.mjs", "we:scripts/lib/__tests__/open-pr-items.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a test helper that asserts the shimmed binary was actually invoked (for example a call-count… (from web-everything/web-everything#4204 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/__tests__/proc-read-migration-74d.test.mjs:88` — Add a test helper that asserts the shimmed binary was actually invoked (for example a call-count file written by the shim). Also add a gate requiring each module in MIGRATED to have a behavioural test.
2. `we:scripts/lib/open-pr-items.mjs:20` — Run the repo's lint or prettier semi rule (no-unexpected-multiline / semi) in check:standards.
3. `we:scripts/__tests__/proc-read-migration-74d.test.mjs:76` — Add a deterministic regression test that exceeds an explicitly small maxBuffer for both runners and requires nonzero status.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4204@5560ac0594a021364e01be03f64d8967dd774711

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
