---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/review-pr-io.mjs", "we:backlog/8712-review-admission-mutation-and-ownership.md", "we:scripts/operations/__tests__/review-pr-io.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add the matching-API/mismatching-local-revision test and a mutation gate requiring removal of thi… (from web-everything/web-everything#7450 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:scripts/operations/review-pr-io.mjs:418` — Add the matching-API/mismatching-local-revision test and a mutation gate requiring removal of this assertion to fail that test.
2. `we:backlog/8712-review-admission-mutation-and-ownership.md:17` — Require named planned gate tests, including 'rejects surviving or incomplete admission mutations' and 'rejects effectful dispatch without explicit ownership policy', through deterministic Acceptance-to-test validation.
3. `we:backlog/8712-review-admission-mutation-and-ownership.md:17` — Name planned gate tests with surviving, incomplete, omitted-policy and explicit-policy fixtures; require these references through an Acceptance-to-test validation gate.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 2 → #5668, finding 3 → #5473, finding 6 → #5473, finding 4 → #5360.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7450@872c56e2aff5bf9c4d897cced29b8de6ba414f54

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
