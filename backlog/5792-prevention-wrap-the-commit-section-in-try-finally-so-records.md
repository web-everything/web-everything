---
bornAs: xxjxdms
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/cli-adapter.mjs", "we:scripts/operations/review-pr.mjs", "we:scripts/operations/__tests__/cli-adapter.test.mjs", "we:scripts/operations/__tests__/review-pr.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Wrap the commit section in try/finally so recordSpentSeats runs on every exit. Add a test where a… (from web-everything/web-everything#4763 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/cli-adapter.mjs:1109` — Wrap the commit section in try/finally so `recordSpentSeats` runs on every exit. Add a test where `advance` throws on seat 1 and later seats' telemetry is still recorded.
2. `we:scripts/operations/review-pr.mjs` — Add a deterministic regression test in we:scripts/operations/__tests__/parallel-judges.test.mjs with an unscored empty net list and readable code diff, asserting refusal before any judge starts; require a trustworthy net-list result before accepting a security-less roster.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4763@8cdeb0505cd1cc506d349069a912984b1c3aaae2

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
