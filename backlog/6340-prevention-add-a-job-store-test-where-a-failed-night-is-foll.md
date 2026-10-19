---
bornAs: x678k71
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/nightly-coroner-job.mjs", "we:scripts/conveyor/__tests__/nightly-coroner-health-tick.test.mjs", "we:scripts/conveyor/__tests__/nightly-coroner-job.test.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Prevention — Add a job-store test where a failed night is followed by a successful night and failures is asser… (from web-everything/web-everything#5450 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/nightly-coroner-job.mjs:88` — Add a job-store test where a failed night is followed by a successful night and `failures` is asserted empty. Better, report only failures newer than the last success, or acknowledge them once surfaced.
2. `we:scripts/conveyor/nightly-coroner-job.mjs:143` — Add a test that appends a coroner-ready line and reads it back via `unacknowledged`/`replay`, asserting distinct nights stay distinct. Alternatively give the feed a typed non-PR event API.
3. `we:scripts/conveyor/nightly-coroner-job.mjs:103` — Run the extractor from the job's pinned snapshot (`sourceRoot`) and use the lane only for scratch. Alternatively, verify that the lane HEAD equals `codeSha` before executing, and add a test for that check.
4. `we:scripts/conveyor/__tests__/nightly-coroner-health-tick.test.mjs:12` — Add a tick test that passes the real predicate with a fixture flag (such as `ps-fixture`) and asserts that `runNightlyCoronerJob` is not called. Alternatively, inject the store from the fixture `dir` so a fixture tick can never touch the real job store.
5. `we:scripts/conveyor/nightly-coroner-job.mjs:137` — Add a deterministic scheduler-to-extractor fault-injection test that interrupts between report publication and cursor persistence, then advances to the next night and asserts non-overlapping extraction windows; reconcile published receipts before scheduling new extraction.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5450@ec68c8a6c1e7894aff7967b8ec241e4eea1a9ef5

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
