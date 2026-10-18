---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/x9jlvy0-a-head-whose-red-team-comment-is-owed-is-not-held-by-the-alr.md", "we:scripts/conveyor/__tests__/review-referral-hold-owed.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Extend the card-to-test mapping check so every Must line in Acceptance must name a test, or an ex… (from web-everything/web-everything#5510 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/x9jlvy0-a-head-whose-red-team-comment-is-owed-is-not-held-by-the-alr.md:28` — Extend the card-to-test mapping check so every Must line in Acceptance must name a test, or an explicit 'n/a: structurally absent' note.
2. `we:backlog/x9jlvy0-a-head-whose-red-team-comment-is-owed-is-not-held-by-the-alr.md:20` — Add a check:standards gate requiring each Acceptance guarantee to reference a resolvable named test; use a parameterized test listing the promised input kinds for A3.
3. `we:backlog/x9jlvy0-a-head-whose-red-team-comment-is-owed-is-not-held-by-the-alr.md:20` — Add a parameterized acceptance test covering all four change types and their identity/authorship refusal cases to the required test suite.
4. `we:scripts/conveyor/__tests__/review-referral-hold-owed.test.mjs` — Require a regression test with 100 initial comments and a trusted advisory appearing only in the expanded response, exercised through both entry points.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 2 → #6216.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5510@1e869ffe82d4d1c3cb7774021b1426177b68f91d

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
