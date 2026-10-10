---
bornAs: x9cy7l5
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/review-loop-policy.mjs", "we:scripts/operations/review-pr-io.mjs", "we:scripts/lib/__tests__/review-loop-policy.test.mjs", "we:scripts/operations/__tests__/review-pr-io.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a test that builds a card digest with the previous raw-text rendering of a file-less guard co… (from web-everything/web-everything#4714 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/review-loop-policy.mjs:432` — Add a test that builds a card digest with the previous raw-text rendering of a file-less guard containing `@`, `<` and a newline, then asserts cardCoversGuard still matches it. Or compare normalised text on both sides of the match.
2. `we:scripts/operations/review-pr-io.mjs:339` — Count a budget round only if the head changed the net diff against the previous reviewed head, or only if a fix was dispatched. Add a replay test with N no-op heads that asserts the budget does not act. If the round source is meant to be trusted, state that in the 5471 Risks.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4714@6d59a6bae5af33fd60ea7dc1b64c936c5f8755c6

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
