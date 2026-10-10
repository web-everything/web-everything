---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/record-referral-ruling-io.mjs", "we:scripts/operations/__tests__/record-referral-ruling.test.mjs", "we:scripts/operations/__tests__/record-referral-ruling-io.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Add an openPrHeadBacklog test with an injected run stub asserting the call sequence, the non-WE r… (from web-everything/web-everything#4795 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/record-referral-ruling-io.mjs:52` — Add an `openPrHeadBacklog` test with an injected `run` stub asserting the call sequence, the non-WE rejection, and the invalid pr/head rejection. Longer term, a check:standards rule that every exported *-io function has a test importing it.
2. `we:scripts/operations/__tests__/record-referral-ruling.test.mjs:226` — A reader-level test where the card resolves on main and the injected openPrHead throws or records. It should assert that openPrHead is never called.
3. `we:scripts/operations/record-referral-ruling-io.mjs:57` — Add a test for `openPrHeadBacklog` with an injected `run`. A standards rule that every exported `*-io.mjs` function must be referenced by a test file would catch this class.
4. `we:scripts/operations/record-referral-ruling-io.mjs:59` — A lint rule forbidding O(N) subprocess spawns inside loops, or a performance integration test covering the worst-case fallback path with a mock large directory.
5. `we:scripts/operations/record-referral-ruling-io.mjs:52` — A coverage gate that requires unit tests for all exported functions.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4795@e9125bd0afd821851eb476620af3e9f34fde37a3

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
