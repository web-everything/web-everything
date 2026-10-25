---
bornAs: xaxidcs
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/review-job.mjs", "we:scripts/operations/__tests__/review-job-red-team-only.test.mjs", "we:scripts/operations/__tests__/review-job.test.mjs"]
dateOpened: "2026-10-23"
tags: []
---

# Prevention — A planner/job test that a fresh pass ending 'disabled' or 'skipped' with zero seat rows leaves th… (from web-everything/web-everything#5838 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/review-job.mjs:748` — A planner/job test that a fresh pass ending 'disabled' or 'skipped' with zero seat rows leaves the head retryable. Or have the finish write drop the status when no row was recorded.
2. `we:scripts/operations/review-job.mjs:1183` — Add a CLI-level test that runJob returning {outcome:'red-team-only'} triggers no rateAndRecordReviewJob call. Optionally add a job-level assertion that no label hook is invoked.
3. `we:scripts/operations/__tests__/review-job-red-team-only.test.mjs:119` — Add a recovery-path test that injects a label-write spy and asserts only `red-team:*` labels are ever written. A check:standards rule requiring every 'never X' claim in a PR body or comment to cite a test would catch this class.
4. `we:scripts/operations/__tests__/review-job-red-team-only.test.mjs` — Add a deterministic integration test using the production gate with injected label IO, asserting that fresh and resumed recovery neither add acceptance labels nor remove review:human.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5838@5d675c3215f4eeca61f2c912d13237925c27ec5d

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
