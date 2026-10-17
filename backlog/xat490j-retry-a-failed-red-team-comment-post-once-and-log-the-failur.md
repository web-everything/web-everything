---
kind: story
size: 2
status: active
scaffoldedBy: "redteam-comment-retry"
dateScaffolded: "2026-10-17"
scope: ["we:scripts/operations/review-extra-seats.mjs", "we:scripts/operations/review-job.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Retry a failed red-team comment post once and log the failure reason

Follow-up, after #5482 and #5465 land: retry a failed red-team comment post once with a short backoff, and include comment.reason (first line, no secrets) in summarizeRedTeam and the job log line.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/operations/__tests__/review-extra-seats.test.mjs we:scripts/operations/__tests__/review-job-red-team.test.mjs` fails before this item lands (fail-once-then-succeed posts once; fail-twice; reason shown in summary) and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the drain red-team hold, or run any new model call.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no new surface beyond the existing readers.
2. **Truncated reads** — n/a: no new surface beyond the existing readers.
3. **Shared state files** — n/a: no new surface beyond the existing readers.
4. **Fail closed** — n/a: no new surface beyond the existing readers.
5. **Identity scoping** — n/a: no new surface beyond the existing readers.
6. **State over time** — n/a: no new surface beyond the existing readers.
7. **Who wrote it** — n/a: no new surface beyond the existing readers.
