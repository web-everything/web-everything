---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/review-job.mjs", "we:scripts/operations/__tests__/review-job.test.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Prevention — Add a hermetic test of the createReviewJobIo red-team hooks against a temp WE_SHARED_RUNS_DIR and… (from web-everything/web-everything#5838 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/review-job.mjs:308` — Add a hermetic test of the `createReviewJobIo` red-team hooks against a temp `WE_SHARED_RUNS_DIR` and scorecard path. A lint or standards check that every new `io.*` hook added to `createReviewJobIo` is referenced from a test using the real factory would catch the whole class.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5838@8ef8437cab7d09e0a4b61429a02f15a7f846e8ee

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
