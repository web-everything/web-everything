---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/dispatch-eligibility-shadow.mjs", "we:scripts/conveyor/dispatch-eligibility.mjs", "we:scripts/conveyor/__tests__/dispatch-eligibility-shadow.test.mjs", "we:scripts/conveyor/__tests__/dispatch-eligibility.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Add a test that runs a failing entry with the default onError and asserts both the diagnostic and… (from web-everything/web-everything#7585 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/dispatch-eligibility-shadow.mjs:152` — Add a test that runs a failing entry with the default onError and asserts both the diagnostic and the original error message reach the reporter. Longer term, make the diagnostic include error.message so it needs no second channel.
2. `we:scripts/conveyor/dispatch-eligibility-shadow.mjs:152` — A test that injects a throwing getter and asserts the default path's console.warn or ledger record carries a sanitized error class or message. Cheapest is to add a sanitized `error` field to the diagnostic record.
3. `we:scripts/conveyor/dispatch-eligibility.mjs:6` — Extend the Proxy pin test to loop over every POPULATIONS entry. Better, a lint or gate that derives the field list from `pr.<field>` reads in we:eligibility.mjs.
4. `we:scripts/conveyor/dispatch-eligibility-shadow.mjs:115` — Add the named empty-batch test to the automated suite and verify that removing the nonzero-attempt condition makes it fail.
5. `we:scripts/conveyor/dispatch-eligibility-shadow.mjs` — Add the named empty-run regression test and a targeted mutation gate removing the attempted > 0 condition.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7585@ba61b663fb873bb1a7cab82f8731ed65f7acb121

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
