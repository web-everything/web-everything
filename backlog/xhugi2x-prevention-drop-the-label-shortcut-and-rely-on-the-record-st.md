---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/ruling-ledger.mjs", "we:scripts/operations/__tests__/record-referral-ruling-supersede.test.mjs", "we:scripts/lib/__tests__/ruling-ledger.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Drop the label shortcut and rely on the record state alone, or require the accepted state to be h… (from web-everything/web-everything#4430 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/ruling-ledger.mjs:84` — Drop the label shortcut and rely on the record state alone, or require the accepted state to be head-bound. Add a ledger test pairing review:accepted with a pending referral on the live head.
2. `we:scripts/operations/__tests__/record-referral-ruling-supersede.test.mjs:88` — Assert that `other` exists for the #4271 case, or add a dedicated synthetic two-finding case. A lint against conditional expects in tests would catch the class.
3. `we:scripts/operations/__tests__/record-referral-ruling-supersede.test.mjs:54` — Add a deterministic line-drift regression test and require it to fail when the supersedes-ID matching arm in ignoredRulings is removed.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4430@50010a4845f549150e6ab621ad8fd34ea5d66ea4

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
