---
bornAs: xkba1wh
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/review-dispatch.mjs", "we:scripts/operations/__tests__/review-job-red-team-skip.test.mjs", "we:scripts/operations/__tests__/review-dispatch.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Add a check:standards rule or unit test that parses we:review-job.mjs's static imports and assert… (from web-everything/web-everything#5890 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/review-dispatch.mjs:461` — Add a check:standards rule or unit test that parses we:review-job.mjs's static imports and asserts every in-repo import is matched by REVIEW_CODE_PATH_RE or REVIEW_CODE_PATH_FILES.
2. `we:scripts/operations/__tests__/review-job-red-team-skip.test.mjs` — Add a deterministic test named 'incomplete comment thread cannot bypass settlement' in this file: return a trusted head-bound comment with totalCount exceeding the returned count, then assert non-policy settlement publishes needs-you and posts no clearance comment.
3. `we:scripts/operations/__tests__/review-job-red-team-skip.test.mjs` — Add a deterministic test named 'incomplete result thread cannot bypass settlement' with one returned trusted comment and totalCount=2; assert visibility fails closed, settlement publishes needs-you, and no result comment is posted. Require this test in the existing test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5890@83fe32fcf5320af6a16b244b24fcc97160399461

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
