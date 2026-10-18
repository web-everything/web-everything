---
bornAs: xe9m0yp
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/lib/review-timing.mjs", "we:scripts/operations/review-pr-io.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/lib/__tests__/review-timing.test.mjs", "we:scripts/operations/__tests__/review-pr-io.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — When a default policy changes, a lint or test that lists every setting-gated bypass (the waiver h… (from web-everything/web-everything#5465 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-core.mjs:1536` — When a default policy changes, a lint or test that lists every setting-gated bypass (the waiver here) and requires an explicit default-policy test for each, not a pin to the old policy.
2. `we:scripts/lib/review-timing.mjs:76` — A standards check that every key in `REVIEW_TIMING_DEFAULTS` and `FIX_TIMING_DEFAULTS` is read outside `review-timing*.mjs` and its tests, or is explicitly marked reserved.
3. `we:scripts/operations/review-pr-io.mjs:943` — Add a table-driven sink test that sends every publish effect an accept-shaped payload with reviewedHead null and expects 'review void'. Also make the exemption explicit: pass an `isAcceptance` flag in each payload instead of inferring it from `to`.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5465@f1c3a9b94218a082125f313d73da12a93877776f

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
