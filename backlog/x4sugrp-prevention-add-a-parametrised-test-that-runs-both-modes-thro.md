---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/review-job.mjs", "we:skills-src/conveyor/__tests__/review-daemon.test.mjs", "we:skills-src/conveyor/review-daemon.mjs", "we:scripts/operations/review-dispatch.mjs", "we:scripts/operations/__tests__/review-job.test.mjs", "we:scripts/operations/__tests__/review-dispatch.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a parametrised test that runs both modes through dispatchReviewByMode with no head and expect… (from web-everything/web-everything#7430 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/review-job.mjs:1714` — Add a parametrised test that runs both modes through dispatchReviewByMode with no head and expects refusal, or scope the PR text and soak break to job mode only.
2. `we:skills-src/conveyor/__tests__/review-daemon.test.mjs:138` — Extend the test with two PRs in the plan, where the first refuses and the second must still dispatch, and assert that the daemon state's lastDispatched is empty for the refused PR.
3. `we:scripts/operations/review-job.mjs:1714` — Apply the expected-head check once in dispatchReviewByMode before the mode split, plus a table test over both modes asserting refusal with no head.
4. `we:skills-src/conveyor/review-daemon.mjs:861` — Extend the test to two PRs (refused first, then a started one) and assert the second still dispatches and lastDispatched is unset for the refused one.
5. `we:scripts/operations/review-dispatch.mjs:757` — Add a spawn-level CLI test of we:scripts/operations/review-dispatch.mjs with and without --expected-head asserting exit code 75 and no job spawn.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7430@e069c5aea419e738ca6e1cf88b69d7a6bc57eb3a

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
