---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-version.mjs", "we:scripts/lib/__tests__/daemon-version.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a test that iterates every documented smoke verdict and asserts the reuse and record semantic… (from web-everything/web-everything#4199 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-version.mjs:96` — Add a test that iterates every documented smoke verdict and asserts the reuse and record semantics. Better, have S4 or the reuse scan only treat 'built' and 'code' as terminal.
2. `we:scripts/lib/daemon-version.mjs:88` — Take the existing clone lock around scan-and-publish, or treat ENOTEMPTY or EEXIST on rename as 'reused' after re-reading the record. Add a concurrent-build test.
3. `we:scripts/lib/daemon-version.mjs:78` — Add a review-lens or lint rule: every `throw new Error('Unsafe …')` guard in scripts/lib needs a test asserting that message. A cheaper option is a check:standards grep that pairs each such throw with a test reference.
4. `we:scripts/lib/daemon-version.mjs:50` — Add a contract test requiring every buildVersion result variant that references a version dir to include `status` or `smoke`. Alternatively, have S4's switch step re-validate the on-disk record status before promotion.
5. `we:scripts/lib/daemon-version.mjs:63` — Add a deterministic regression test that pauses the first build in smoke, starts a second build with the same timestamp, asserts its rejection leaves staging intact, and then verifies the first build publishes successfully.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4199@7826e828b3aaa289b34acd2085e04a475c9d0e62

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
