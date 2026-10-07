---
bornAs: xzhhm81
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/record-referral-ruling-io.mjs", "we:scripts/operations/__tests__/record-referral-ruling-io.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Give ruling events an idempotency key (for example head plus findingKey plus ruling) that the led… (from web-everything/web-everything#4327 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/record-referral-ruling-io.mjs:165` — Give ruling events an idempotency key (for example head plus findingKey plus ruling) that the ledger fold dedupes on, and add a fault-injection test for post-after-append failure.
2. `we:scripts/operations/record-referral-ruling-io.mjs:160` — Put event construction inside the guarded helper (a single `tryRecord(() => append(build(...)))`) and test one build-failure case per posture.
3. `we:scripts/operations/record-referral-ruling-io.mjs:160` — Make the sink throw when `rulings` is absent or empty on a post that carries a ruling body, and add a test for it. Longer term, add a lint or standards rule against defaulting security-relevant effect payload fields.
4. `we:scripts/operations/record-referral-ruling-io.mjs:170` — Give ledger events a deterministic idempotency key (for example head plus findingKey plus ruling) and dedupe on append or on read. Add a retry-after-post-failure test. A reviewer lens or doc note on write-ahead ledgers would also help.
5. `we:scripts/operations/record-referral-ruling-io.mjs:97` — Add a deterministic test passing an invalid event to appendLedgerEventsHome and asserting rejection without an appended row; verify that removing the validation guard makes it fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4327@475e4c0307da83fe57eeb3aa25e914b8b0ee5372

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
