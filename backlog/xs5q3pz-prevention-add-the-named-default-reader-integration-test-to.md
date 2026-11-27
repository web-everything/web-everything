---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/supersede-watch.test.mjs", "we:scripts/conveyor/supersede-watch.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Add the named default-reader integration test to CI and a deterministic mutation check that remov… (from web-everything/web-everything#7559 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/supersede-watch.test.mjs` — Add the named default-reader integration test to CI and a deterministic mutation check that removes each required identity field from the candidate request and requires that test to fail.
2. `we:scripts/conveyor/supersede-watch.mjs:247` — Add a test where readPr returns a thread that already carries a trusted supersede hold on the pre-write re-read, and assert applied[0].error matches /hold authority changed/ and postHold is not called. A review lens that asks for one test per thrown error message would catch this whole class.
3. `we:scripts/conveyor/supersede-watch.mjs:106` — Add a deterministic boundary regression test using fractional milliseconds and require it to fail when the rounding is removed.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7559@88c987d8b021c015daeb98b7a083efcb5c5ef4f1

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
